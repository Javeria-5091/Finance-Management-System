-- ═══════════════════════════════════════════════════════════════════════
-- P2_008: Fix bank-transfer posting finalization + reconciliation ledger
--         balance case bug
-- ═══════════════════════════════════════════════════════════════════════
-- Apply this migration to the database (e.g. via the Supabase CLI /
-- migration runner) to fix FND-BANK-01 and FND-BANK-02.
--
-- NOTE: schema.sql (the consolidated dump) is intentionally left
-- untouched by this change, per repo convention (see P2_006). Once this
-- migration has been applied to the actual database, regenerate
-- schema.sql from it (e.g. `supabase db dump`) rather than hand-editing
-- the dump.
-- ═══════════════════════════════════════════════════════════════════════
--
-- FND-BANK-01 (P0, Banking)
-- ---------------------------------------------------------------------
-- finance.post_bank_transfer() posts a journal via finance.post_journal_
-- entry() and returns its id, but never UPDATEs finance.bank_transfers
-- itself. The row is left at status = APPROVED with journal_entry_id
-- still NULL. Since the function's only guard is
-- "IF v_t.status <> 'APPROVED' THEN RAISE EXCEPTION 'Must be approved'",
-- that guard passes again on every retry (double-click, network retry,
-- user re-opening the row and hitting Post again), and each call creates
-- another identical journal entry -- unlimited duplicate GL postings for
-- one real transfer, with no journal_entry_id ever recorded to trace it
-- back.
--
-- finance.update_bank_transfer_status() cannot be used to patch this up
-- from the client afterwards -- its p_status allow-list is 'SUBMITTED',
-- 'APPROVED', 'REJECTED', 'CANCELLED' only, so a second RPC call passing
-- 'POSTED' is rejected outright. The finalization has to happen inside
-- post_bank_transfer() itself, in the same transaction as the journal
-- insert, exactly the way finance.post_income_atomic / post_expense_
-- atomic / post_asset_disposal already finalize their own source rows.
--
-- Fix: after finance.post_journal_entry() returns, in the same
-- transaction and under the row lock already taken by the existing
-- "FOR UPDATE" at the top of the function, UPDATE finance.bank_transfers
-- to status = 'POSTED', set journal_entry_id, period_id, posted_by,
-- posted_at. Re-check status = 'APPROVED' in the UPDATE's WHERE clause
-- (defense in depth against a race) and RAISE EXCEPTION if it didn't
-- match, so a failure here rolls back the journal too instead of leaving
-- an orphaned posting. An explicit EXISTS pre-check against
-- finance.journal_entries (source_type = 'BANK_TRANSFER') is also added
-- so a second call for the same transfer fails fast with a clear message
-- instead of relying solely on the status flip.
--
-- FND-BANK-02 (P0, Banking)
-- ---------------------------------------------------------------------
-- reporting.reconciliation_summary joins finance.journal_lines to
-- finance.journal_entries and filters "je.status = 'posted'" (lowercase).
-- finance.journal_entries_status_check only allows the uppercase value
-- 'POSTED' (see schema.sql), and finance.post_journal_entry() always
-- inserts status = 'POSTED' -- so the lowercase literal never matches any
-- row. The LATERAL join's ledger_balance is therefore always NULL, which
-- COALESCEs to 0 for every account, so:
--   * ledger_balance always reads 0,
--   * difference = 0 - statement_balance = -closing_balance for every
--     account, and
--   * reconciliation_pct is computed independently of this and is
--     unaffected, but every account with a nonzero statement balance is
--     falsely flagged as needing reconciliation on the AccountCard, since
--     the reported ledger side never reflects any posted activity at all.
--
-- Fix: compare against 'POSTED' (uppercase), matching the actual
-- constraint and every posting function in the schema.
--
-- Idempotent: safe to run more than once.
-- ═══════════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION "finance"."post_bank_transfer"("p_transfer_id" "uuid", "p_period_id" "uuid", "p_transaction_date" "date") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'public', 'core'
    AS $$
DECLARE
    v_org uuid;
    v_t RECORD;
    v_fy_id UUID;
    v_from_ledger UUID;
    v_to_ledger UUID;
    v_fx_gain UUID;
    v_fx_loss UUID;
    v_lines JSONB := '[]'::JSONB;
    v_fx_diff NUMERIC(18,2);
    v_from_base NUMERIC(18,2);
    v_to_base NUMERIC(18,2);
    v_from_rate NUMERIC(18,6);
    v_to_rate NUMERIC(18,6);
    v_journal_id UUID;
BEGIN
    -- BUG-025 FIX (four issues in this one check, all from the same missing
    -- guard block):
    -- 1) No organization scoping at all -- any authenticated user of any org
    --    could post an arbitrary transfer by id (see BUG-026 for the same
    --    pattern on the reconciliation-matching functions).
    -- 2) No role/permission check at all.
    -- 3) 'SUBMITTED' was an accepted status for posting, meaning a transfer
    --    that was never actually approved could still be posted.
    -- 4) requires_dual_approval / second_approved_by were never checked, so
    --    even a transfer correctly left at SUBMITTED pending its second
    --    approval could be posted by calling this function directly.
    v_org := core.current_user_org_id();
    IF v_org IS NULL THEN RAISE EXCEPTION 'Organization context is required'; END IF;
    IF NOT (core.is_finance_head() OR core.has_role('ACCOUNTANT')) THEN
        RAISE EXCEPTION 'Access denied';
    END IF;

    SELECT * INTO v_t FROM finance.bank_transfers
    WHERE id = p_transfer_id AND organization_id = v_org
    FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Transfer not found or access denied'; END IF;
    IF v_t.status <> 'APPROVED' THEN RAISE EXCEPTION 'Must be approved, status: %', v_t.status; END IF;
    IF v_t.requires_dual_approval AND v_t.second_approved_by IS NULL THEN
        RAISE EXCEPTION 'This transfer requires a second approval before it can be posted';
    END IF;

    -- FND-BANK-01 FIX: explicit idempotency guard, matching the pattern
    -- used by post_income_atomic / post_expense_atomic. Belt-and-suspenders
    -- alongside the status re-check on the UPDATE below -- either one alone
    -- would already stop a duplicate posting, but this gives a clearer
    -- error message than a generic "Must be approved" would once the
    -- status has already flipped to POSTED.
    IF EXISTS (
        SELECT 1 FROM finance.journal_entries
        WHERE source_type = 'BANK_TRANSFER' AND source_id = p_transfer_id
    ) THEN
        RAISE EXCEPTION 'This transfer has already been posted to the general ledger';
    END IF;

    SELECT fiscal_year_id INTO v_fy_id FROM finance.accounting_periods WHERE id = p_period_id;
    IF v_fy_id IS NULL THEN RAISE EXCEPTION 'Invalid period'; END IF;

    SELECT linked_ledger_account_id INTO v_from_ledger FROM finance.financial_accounts WHERE id = v_t.from_account_id;
    SELECT linked_ledger_account_id INTO v_to_ledger FROM finance.financial_accounts WHERE id = v_t.to_account_id;

    --  BUG FIX: 4210 = Exchange Gain (exists), 7121 = Realized FX Loss (exists, was 7210)
    SELECT id INTO v_fx_gain FROM finance.chart_of_accounts WHERE code = '4210' LIMIT 1;
    SELECT id INTO v_fx_loss FROM finance.chart_of_accounts WHERE code = '7121' LIMIT 1;

    -- From side to PKR base
    IF v_t.from_currency = 'PKR' THEN v_from_base := v_t.from_amount; v_from_rate := 1;
    ELSE
        --  BUG FIX: rate_date NOT effective_date
        SELECT rate INTO v_from_rate FROM finance.exchange_rates
        WHERE from_currency = v_t.from_currency AND to_currency = 'PKR'
        ORDER BY rate_date DESC LIMIT 1;
        IF v_from_rate IS NULL THEN v_from_rate := v_t.exchange_rate; END IF;
        v_from_base := ROUND(v_t.from_amount * v_from_rate, 2);
    END IF;

    -- To side to PKR base
    IF v_t.to_currency = 'PKR' THEN v_to_base := v_t.to_amount; v_to_rate := 1;
    ELSE
        --  BUG FIX: rate_date NOT effective_date
        SELECT rate INTO v_to_rate FROM finance.exchange_rates
        WHERE from_currency = v_t.to_currency AND to_currency = 'PKR'
        ORDER BY rate_date DESC LIMIT 1;
        IF v_to_rate IS NULL THEN v_to_rate := 1 / v_t.exchange_rate; END IF;
        v_to_base := ROUND(v_t.to_amount * v_to_rate, 2);
    END IF;

    -- Same currency
    IF v_t.from_currency = v_t.to_currency THEN
        v_lines := v_lines || jsonb_build_object('account_id', v_to_ledger, 'debit_amount', v_t.to_amount, 'credit_amount', 0, 'description', 'Transfer TO: ' || v_t.transfer_number);
        v_lines := v_lines || jsonb_build_object('account_id', v_from_ledger, 'debit_amount', 0, 'credit_amount', v_t.from_amount, 'description', 'Transfer FROM: ' || v_t.transfer_number);
    ELSE
        v_fx_diff := v_to_base - v_from_base;
        v_lines := v_lines || jsonb_build_object('account_id', v_to_ledger, 'debit_amount', v_to_base, 'credit_amount', 0, 'description', 'Transfer TO: ' || v_t.transfer_number || ' (' || v_t.to_amount || ' ' || v_t.to_currency || ')');
        v_lines := v_lines || jsonb_build_object('account_id', v_from_ledger, 'debit_amount', 0, 'credit_amount', v_from_base, 'description', 'Transfer FROM: ' || v_t.transfer_number || ' (' || v_t.from_amount || ' ' || v_t.from_currency || ')');
        IF v_fx_diff > 0 AND v_fx_gain IS NOT NULL THEN
            v_lines := v_lines || jsonb_build_object('account_id', v_fx_gain, 'debit_amount', 0, 'credit_amount', v_fx_diff, 'description', 'FX Gain: ' || v_t.transfer_number);
        ELSIF v_fx_diff < 0 AND v_fx_loss IS NOT NULL THEN
            v_lines := v_lines || jsonb_build_object('account_id', v_fx_loss, 'debit_amount', ABS(v_fx_diff), 'credit_amount', 0, 'description', 'FX Loss: ' || v_t.transfer_number);
        END IF;
    END IF;

    --  CORRECT PARAMETER ORDER
    v_journal_id := finance.post_journal_entry('Bank Transfer: ' || v_t.transfer_number, p_transaction_date, p_period_id, v_lines, 'PKR', 1.0000, 'BANK_TRANSFER', p_transfer_id, NULL, NULL);

    -- FND-BANK-01 FIX: finalize the transfer row in the SAME transaction as
    -- the journal insert above. If this UPDATE fails or matches zero rows
    -- (status changed under us despite the earlier FOR UPDATE lock), the
    -- RAISE EXCEPTION below rolls back the journal insert too, so we never
    -- end up with a posted journal and a transfer still stuck at APPROVED.
    UPDATE finance.bank_transfers
    SET status = 'POSTED',
        journal_entry_id = v_journal_id,
        period_id = p_period_id,
        posted_by = auth.uid(),
        posted_at = now(),
        updated_at = now()
    WHERE id = p_transfer_id
      AND organization_id = v_org
      AND status = 'APPROVED';

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Bank transfer status update failed while posting to GL';
    END IF;

    RETURN v_journal_id;
END;
$$;

COMMENT ON FUNCTION "finance"."post_bank_transfer"("p_transfer_id" "uuid", "p_period_id" "uuid", "p_transaction_date" "date") IS 'FND-BANK-01 FIX: now atomic. Previously created the GL journal via finance.post_journal_entry() and returned its id but never updated finance.bank_transfers itself, leaving the row at status=APPROVED with journal_entry_id=NULL forever. Because the only guard was "status <> APPROVED", every retry (double-click, network retry) passed the guard again and posted another duplicate journal, with no journal_entry_id ever recorded. Now updates the transfer row to status=POSTED with journal_entry_id/period_id/posted_by/posted_at in the same transaction as the journal insert, re-checking status=APPROVED under the row lock so a race rolls back the journal too, plus an explicit idempotency guard against finance.journal_entries.';


-- ---------------------------------------------------------------------
-- FND-BANK-02: reconciliation_summary compared je.status against the
-- lowercase literal 'posted', which no row can ever match since
-- journal_entries_status_check only allows uppercase 'POSTED' and every
-- posting function inserts uppercase. ledger_balance was therefore always
-- NULL -> COALESCEd to 0, so every account showed ledger_balance = 0 and
-- difference = -statement_balance, falsely flagging every account as out
-- of reconciliation.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW "reporting"."reconciliation_summary" WITH ("security_invoker"='true') AS
 SELECT "fa"."id" AS "financial_account_id",
    "fa"."account_name",
    "fa"."institution_name",
    "fa"."currency",
    "fa"."masked_identifier",
    COALESCE("ledger"."ledger_balance", (0)::numeric) AS "ledger_balance",
    COALESCE("latest"."closing_balance", (0)::numeric) AS "statement_balance",
    (COALESCE("ledger"."ledger_balance", (0)::numeric) - COALESCE("latest"."closing_balance", (0)::numeric)) AS "difference",
    COALESCE("cnts"."total_lines", (0)::bigint) AS "total_lines",
    COALESCE("cnts"."matched_lines", (0)::bigint) AS "matched_lines",
    COALESCE("cnts"."unreconciled_lines", (0)::bigint) AS "unreconciled_lines",
        CASE
            WHEN (COALESCE("cnts"."total_lines", (0)::bigint) = 0) THEN (100)::numeric
            ELSE "round"((((COALESCE("cnts"."matched_lines", (0)::bigint))::numeric / (COALESCE("cnts"."total_lines", (0)::bigint))::numeric) * (100)::numeric), 1)
        END AS "reconciliation_pct",
    "latest"."statement_date" AS "latest_statement_date",
    "fa"."organization_id"
   FROM ((("finance"."financial_accounts" "fa"
     LEFT JOIN LATERAL ( SELECT "sum"(("jl"."debit_amount" - "jl"."credit_amount")) AS "ledger_balance"
           FROM ("finance"."journal_lines" "jl"
             JOIN "finance"."journal_entries" "je" ON (("je"."id" = "jl"."journal_entry_id")))
          WHERE (("jl"."account_id" = "fa"."linked_ledger_account_id") AND ("je"."status" = 'POSTED'::"text"))) "ledger" ON (true))
     LEFT JOIN LATERAL ( SELECT "bank_statements"."closing_balance",
            "bank_statements"."statement_date"
           FROM "finance"."bank_statements"
          WHERE ("bank_statements"."financial_account_id" = "fa"."id")
          ORDER BY "bank_statements"."statement_date" DESC
         LIMIT 1) "latest" ON (true))
     LEFT JOIN LATERAL ( SELECT "count"(*) AS "total_lines",
            "count"(*) FILTER (WHERE ("sl"."reconciliation_status" = ANY (ARRAY['MATCHED'::"text", 'MANUAL_MATCH'::"text"]))) AS "matched_lines",
            "count"(*) FILTER (WHERE ("sl"."reconciliation_status" = 'UNRECONCILED'::"text")) AS "unreconciled_lines"
           FROM ("finance"."statement_lines" "sl"
             JOIN "finance"."bank_statements" "bs" ON (("bs"."id" = "sl"."bank_statement_id")))
          WHERE ("bs"."financial_account_id" = "fa"."id")) "cnts" ON (true))
  WHERE ("fa"."is_active" = true);

ALTER VIEW "reporting"."reconciliation_summary" OWNER TO "postgres";

GRANT SELECT ON TABLE "reporting"."reconciliation_summary" TO "authenticated";
GRANT SELECT ON TABLE "reporting"."reconciliation_summary" TO "ai_readonly_role";
GRANT ALL ON TABLE "reporting"."reconciliation_summary" TO "service_role";

COMMIT;

-- =====================================================================
-- End of script. After running, verify with:
--   SELECT prosrc FROM pg_proc WHERE proname = 'post_bank_transfer';
--   SELECT * FROM reporting.reconciliation_summary LIMIT 5;
-- =====================================================================

-- ═══════════════════════════════════════════════════════════════════════
-- P2_009: Fix bank-statement import end-to-end
-- ═══════════════════════════════════════════════════════════════════════
-- Apply this migration to the database (e.g. via the Supabase CLI /
-- migration runner) to fix FND-BANK-03.
--
-- NOTE: schema.sql (the consolidated dump) is intentionally left
-- untouched by this change, per repo convention (see P2_006 / P2_008).
-- Once this migration has been applied to the actual database,
-- regenerate schema.sql from it (e.g. `supabase db dump`) rather than
-- hand-editing the dump.
-- ═══════════════════════════════════════════════════════════════════════
--
-- FND-BANK-03 (P0, Banking) -- four separate defects, one fix
-- ---------------------------------------------------------------------
-- 1) Org CHECK violation on every import
--    src/components/banking/StatementImport.tsx -> bank.service.ts
--    createBankStatement() inserted straight into finance.bank_statements
--    from the browser client with no organization_id in the payload.
--    bank_statements_org_required_going_forward CHECK (organization_id
--    IS NOT NULL) rejects that unconditionally, so every single import
--    failed before a single line was ever written.
--
-- 2) Non-atomic batch inserts
--    Even if (1) were patched by adding organization_id client-side, the
--    component created the statement header with one PostgREST call,
--    then looped over the parsed lines in client-side batches of 100
--    with separate insert calls. A failure on batch 3 of 5 left an
--    orphan bank_statements row with only some of its lines, no
--    transactional link between the header and any batch, and no way to
--    resume or cleanly retry -- the user's only option was to re-import
--    the whole file, which (see #3) had nothing to stop it from
--    re-inserting the batches that already succeeded.
--
-- 3) No duplicate defense
--    finance.statement_lines had no unique constraint of any kind beyond
--    its surrogate id, so re-importing the same CSV (or the same
--    overlapping date range from a fresh export) silently duplicated
--    every line, corrupting reconciliation counts and ledger-vs-
--    statement comparisons with no error and no warning.
--
-- 4) Dead duplicate-detector
--    finance.detect_duplicate_statement_lines() (wired up in the UI via
--    ReconciliationTable's "Detect Duplicates" button) calls SIMILARITY(),
--    which is provided by the pg_trgm extension. pg_trgm is never
--    installed anywhere in this schema (see the CREATE EXTENSION block
--    near the top of schema.sql -- only btree_gist, pg_stat_statements,
--    pgcrypto, supabase_vault, uuid-ossp are present), so every call to
--    this function has always raised "function similarity(text, text)
--    does not exist" and the button has never worked.
--
-- Fix, matching the finance.post_income_atomic / post_payment_receipt_
-- atomic pattern already used elsewhere in this schema:
--   * One new SECURITY DEFINER RPC, finance.import_bank_statement(),
--     resolves organization_id from the caller's own session
--     (core.current_user_org_id()) -- never trusts a client-supplied
--     value -- validates the target account belongs to that org, and
--     inserts the statement header AND every line in a single DB
--     transaction via one INSERT ... SELECT FROM jsonb_to_recordset(),
--     so a bad row anywhere in the file aborts the whole import instead
--     of leaving a partial statement behind.
--   * A real unique index on finance.statement_lines gives that INSERT
--     an ON CONFLICT DO NOTHING target, so re-submitting a file that was
--     already imported (in whole or in part) silently skips the lines
--     that already exist instead of duplicating them, and the RPC
--     reports how many were skipped so the user isn't left guessing.
--     NOTE on this key's limits: it dedupes on (account, date, amount,
--     identifier/reference/description). Two genuinely distinct
--     transactions that share all of those (e.g. two identical PKR 500
--     cash withdrawals on the same day with no bank-provided reference)
--     will collide and the second will be silently dropped. This is the
--     same trade-off most bank-feed importers make; if your bank's
--     export includes a real transaction_identifier this key is exact.
--   * pg_trgm is installed (matching this schema's existing convention
--     of WITH SCHEMA "extensions"), and detect_duplicate_statement_lines's
--     search_path is updated to include that schema so SIMILARITY()
--     actually resolves.
--
-- Idempotent: safe to run more than once.
-- ═══════════════════════════════════════════════════════════════════════

BEGIN;

-- ---------------------------------------------------------------------
-- 0) Install pg_trgm (fixes the dead duplicate-detector, defect #4).
-- ---------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS "pg_trgm" WITH SCHEMA "extensions";

CREATE OR REPLACE FUNCTION "finance"."detect_duplicate_statement_lines"("p_statement_id" "uuid") RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'extensions', 'finance', 'public', 'core'
    AS $$ DECLARE v_count INT; v_org uuid;
BEGIN
    -- BUG-026 FIX: same cross-tenant gap as auto_match_statement_lines -- no
    -- organization check at all on a SECURITY DEFINER function with no
    -- REVOKE. Scoped to the caller's own organization before touching
    -- anything.
    v_org := core.current_user_org_id();
    IF v_org IS NULL THEN RAISE EXCEPTION 'Organization context is required'; END IF;
    IF NOT EXISTS (SELECT 1 FROM finance.bank_statements WHERE id = p_statement_id AND organization_id = v_org) THEN
        RAISE EXCEPTION 'Statement not found or access denied';
    END IF;

    UPDATE finance.statement_lines sl SET reconciliation_status = 'DUPLICATE', exclusion_reason = 'Auto-detected duplicate'
    WHERE sl.bank_statement_id = p_statement_id AND sl.reconciliation_status = 'UNRECONCILED'
      AND EXISTS (
          SELECT 1 FROM finance.statement_lines sl2
          JOIN finance.bank_statements bs2 ON bs2.id = sl2.bank_statement_id
          WHERE bs2.financial_account_id = (SELECT financial_account_id FROM finance.bank_statements WHERE id = p_statement_id)
            AND bs2.organization_id = v_org
            AND sl2.id != sl.id AND sl2.amount = sl.amount AND sl2.transaction_date = sl.transaction_date
            AND (sl2.description = sl.description OR SIMILARITY(sl2.description, sl.description) > 0.85)
            AND sl2.reconciliation_status NOT IN ('DUPLICATE','EXCLUDED')
      );
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
 $$;

COMMENT ON FUNCTION "finance"."detect_duplicate_statement_lines"("p_statement_id" "uuid") IS 'FND-BANK-03 FIX: search_path now includes "extensions" (see CREATE EXTENSION pg_trgm above), so SIMILARITY() actually resolves. Previously raised "function similarity(text, text) does not exist" on every call because pg_trgm was never installed anywhere in this schema -- the "Detect Duplicates" button in ReconciliationTable.tsx has never worked until now.';


-- ---------------------------------------------------------------------
-- 1) Denormalize financial_account_id onto statement_lines.
--    statement_lines only carries bank_statement_id today, so there is
--    no way to build a per-account uniqueness key without joining back
--    to bank_statements on every insert/lookup. Backfilled from the
--    existing join, then required going forward.
-- ---------------------------------------------------------------------
ALTER TABLE "finance"."statement_lines"
  ADD COLUMN IF NOT EXISTS "financial_account_id" uuid;

UPDATE "finance"."statement_lines" sl
SET financial_account_id = bs.financial_account_id
FROM "finance"."bank_statements" bs
WHERE bs.id = sl.bank_statement_id
  AND sl.financial_account_id IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'statement_lines_financial_account_id_fkey'
  ) THEN
    ALTER TABLE "finance"."statement_lines"
      ADD CONSTRAINT "statement_lines_financial_account_id_fkey"
      FOREIGN KEY (financial_account_id) REFERENCES "finance"."financial_accounts"(id);
  END IF;
END $$;

-- Defense in depth: if anything ever inserts a line without going
-- through finance.import_bank_statement() below, backfill it from the
-- parent statement automatically rather than leaving it NULL (which
-- would silently opt that row out of the dedupe index, since NULL never
-- equals NULL in a unique index).
CREATE OR REPLACE FUNCTION "finance"."set_statement_line_financial_account"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'pg_catalog', 'finance', 'public'
    AS $$
BEGIN
  IF NEW.financial_account_id IS NULL THEN
    SELECT financial_account_id INTO NEW.financial_account_id
    FROM finance.bank_statements WHERE id = NEW.bank_statement_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "trg_statement_line_financial_account" ON "finance"."statement_lines";
CREATE TRIGGER "trg_statement_line_financial_account"
  BEFORE INSERT ON "finance"."statement_lines"
  FOR EACH ROW EXECUTE FUNCTION "finance"."set_statement_line_financial_account"();

-- ---------------------------------------------------------------------
-- 2) Real duplicate defense (defect #3): a genuine unique index, used
--    as the ON CONFLICT target by finance.import_bank_statement() below.
--    COALESCE'd so two lines with no reference/identifier/description
--    at all don't each get a free pass (NULL <> NULL in a plain unique
--    index).
-- ---------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS "statement_lines_dedupe_key"
  ON "finance"."statement_lines" (
    financial_account_id,
    transaction_date,
    amount,
    (md5(COALESCE(transaction_identifier, '') || '|' || COALESCE(reference, '') || '|' || COALESCE(description, '')))
  );

-- ---------------------------------------------------------------------
-- 3) Atomic import RPC (fixes defects #1 and #2). Statement header +
--    every line are written in this one PL/pgSQL function, i.e. one DB
--    transaction: any bad row aborts the whole import, and
--    organization_id is always taken server-side from the caller's own
--    session, never from client input.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "finance"."import_bank_statement"(
    "p_financial_account_id" "uuid",
    "p_statement_date" "date",
    "p_opening_balance" numeric,
    "p_closing_balance" numeric,
    "p_currency" "text",
    "p_file_name" "text",
    "p_lines" "jsonb"
) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'core', 'public'
    AS $$
DECLARE
  v_org uuid;
  v_account RECORD;
  v_statement_id uuid;
  v_lines_submitted int;
  v_inserted int;
  v_duplicates int;
BEGIN
  v_org := core.current_user_org_id();
  IF v_org IS NULL THEN RAISE EXCEPTION 'Organization context is required'; END IF;
  IF NOT (core.is_finance_head() OR core.has_role('ACCOUNTANT')) THEN
    RAISE EXCEPTION 'Insufficient privileges to import a bank statement';
  END IF;

  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'At least one statement line is required';
  END IF;
  v_lines_submitted := jsonb_array_length(p_lines);

  IF p_opening_balance IS NULL OR p_closing_balance IS NULL THEN
    RAISE EXCEPTION 'Opening and closing balances are required';
  END IF;

  -- Row-lock the target account for the duration of the import so two
  -- concurrent imports for the same account can't race each other's
  -- dedupe check.
  SELECT * INTO v_account
  FROM finance.financial_accounts
  WHERE id = p_financial_account_id AND organization_id = v_org AND is_active = true
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Financial account not found, inactive, or access denied';
  END IF;

  INSERT INTO finance.bank_statements (
    financial_account_id, statement_date, opening_balance, closing_balance,
    currency, imported_by, file_name, organization_id
  ) VALUES (
    p_financial_account_id, p_statement_date, p_opening_balance, p_closing_balance,
    COALESCE(NULLIF(p_currency, ''), v_account.currency), auth.uid(), p_file_name, v_org
  ) RETURNING id INTO v_statement_id;

  -- Single set-based INSERT for every line: a NOT NULL / type-cast
  -- failure on any one row aborts the whole statement (including the
  -- header just inserted above), rather than leaving a partially
  -- imported file behind. Only exact duplicates (per the unique index)
  -- are silently skipped -- everything else that's wrong about the file
  -- fails the entire import.
  WITH parsed AS (
    SELECT row_number() OVER () AS line_number, x.*
    FROM jsonb_to_recordset(p_lines) AS x(
      transaction_date date,
      description text,
      reference text,
      counterparty text,
      transaction_identifier text,
      amount numeric,
      balance_after numeric
    )
  ),
  ins AS (
    INSERT INTO finance.statement_lines (
      bank_statement_id, financial_account_id, line_number, transaction_date,
      description, reference, counterparty, transaction_identifier,
      amount, balance_after, reconciliation_status
    )
    SELECT v_statement_id, p_financial_account_id, line_number, transaction_date,
           description, reference, counterparty, transaction_identifier,
           amount, balance_after, 'UNRECONCILED'
    FROM parsed
    ON CONFLICT (
      financial_account_id, transaction_date, amount,
      (md5(COALESCE(transaction_identifier, '') || '|' || COALESCE(reference, '') || '|' || COALESCE(description, '')))
    ) DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_inserted FROM ins;

  v_duplicates := v_lines_submitted - v_inserted;

  IF v_inserted = 0 THEN
    -- Every submitted line already exists for this account -- treat the
    -- whole call as a no-op error instead of leaving an empty statement
    -- header behind (the INSERT above rolls back along with everything
    -- else in this function on RAISE EXCEPTION).
    RAISE EXCEPTION 'All % line(s) in this file already exist for this account (duplicate import)', v_lines_submitted;
  END IF;

  UPDATE finance.bank_statements bs
  SET total_debits = COALESCE(t.total_debits, 0),
      total_credits = COALESCE(t.total_credits, 0),
      line_count = COALESCE(t.line_count, 0)
  FROM (
    SELECT sum(amount) FILTER (WHERE amount > 0) AS total_debits,
           sum(abs(amount)) FILTER (WHERE amount < 0) AS total_credits,
           count(*) AS line_count
    FROM finance.statement_lines
    WHERE bank_statement_id = v_statement_id
  ) t
  WHERE bs.id = v_statement_id;

  RETURN jsonb_build_object(
    'statement_id', v_statement_id,
    'lines_submitted', v_lines_submitted,
    'lines_inserted', v_inserted,
    'duplicates_skipped', v_duplicates
  );
END;
$$;

ALTER FUNCTION "finance"."import_bank_statement"("p_financial_account_id" "uuid", "p_statement_date" "date", "p_opening_balance" numeric, "p_closing_balance" numeric, "p_currency" "text", "p_file_name" "text", "p_lines" "jsonb") OWNER TO "postgres";

REVOKE ALL ON FUNCTION "finance"."import_bank_statement"("p_financial_account_id" "uuid", "p_statement_date" "date", "p_opening_balance" numeric, "p_closing_balance" numeric, "p_currency" "text", "p_file_name" "text", "p_lines" "jsonb") FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "finance"."import_bank_statement"("p_financial_account_id" "uuid", "p_statement_date" "date", "p_opening_balance" numeric, "p_closing_balance" numeric, "p_currency" "text", "p_file_name" "text", "p_lines" "jsonb") TO "authenticated";

COMMENT ON FUNCTION "finance"."import_bank_statement"("p_financial_account_id" "uuid", "p_statement_date" "date", "p_opening_balance" numeric, "p_closing_balance" numeric, "p_currency" "text", "p_file_name" "text", "p_lines" "jsonb") IS 'FND-BANK-03 FIX: atomic replacement for StatementImport.tsx''s previous two-step create-statement-then-batch-insert-lines flow. organization_id is now always resolved server-side from the caller''s session (the old client insert omitted it entirely, which the bank_statements_org_required_going_forward CHECK always rejected). Header + all lines are written in one transaction, and duplicate lines (per statement_lines_dedupe_key) are skipped via ON CONFLICT DO NOTHING instead of silently re-inserted on a repeat import.';

COMMIT;

-- =====================================================================
-- End of script. After running, verify with:
--   SELECT extname FROM pg_extension WHERE extname = 'pg_trgm';
--   SELECT indexname FROM pg_indexes WHERE tablename = 'statement_lines';
--   SELECT proname FROM pg_proc WHERE proname = 'import_bank_statement';
-- =====================================================================
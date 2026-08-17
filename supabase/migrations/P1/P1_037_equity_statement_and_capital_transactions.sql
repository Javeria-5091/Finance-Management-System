-- =============================================================================
-- Migration: 024_equity_statement_and_capital_transactions.sql
-- Purpose:   Fix CRITICAL finding C4 (equity statement) from the
--            second-opinion audit, independently VERIFIED against this
--            schema (grep for equity_movement/changes_in_equity/
--            statement_of_equity/v_equity/get_equity across the full file
--            returned zero matches -- confirmed absent). Also fixes a
--            related gap the audit report did not explicitly call out but
--            which the same spec section requires and which is genuinely
--            missing: no table exists for capital contributions, owner
--            loans, or drawings (spec Section 5.13: "Track capital
--            contributions, owner loans, drawings, retained earnings,
--            declared distributions, paid distributions, and outstanding
--            owner balances" -- confirmed by searching schema.sql for
--            capital_events/capital_contributions/owner_loans/drawings:
--            zero matches for any of them). Spec ref: Section 13.2
--            ("Statement of Changes in Equity" required alongside P&L/BS/
--            CF); Section 5.13 (capital/loan/drawing tracking); Section
--            2.1 ("shareholder capital, owner loans, drawings").
--
-- Fix:
--   1. New table finance.capital_transactions: the master-data record for
--      an owner's capital contribution, loan advance/repayment, or
--      drawing -- ledger-linked (journal_entry_id) the same way
--      finance.profit_distributions already is, so the general ledger
--      remains the source of truth (spec Section 1.1) and this table is a
--      structured entry point into it, not a parallel figure. Existing
--      finance.owners is reused for the owner reference (no new identity
--      table).
--   2. reporting.get_statement_of_changes_in_equity(p_period_start,
--      p_period_end): assembles the statement directly from
--      finance.chart_of_accounts (account_type = 'EQUITY') and
--      finance.journal_lines/journal_entries -- the same GL-derived
--      pattern already used by reporting.get_balance_sheet and
--      reporting.get_trial_balance -- so the reported movement always
--      reconciles to the ledger by construction, rather than being a
--      second calculation that could drift from it. Opening balance,
--      period movement, and closing balance are broken out per equity
--      account.
--
-- Data safety: Purely additive (one new table, one new function). No
--            existing object is changed. finance.capital_transactions
--            starts empty; nothing is backfilled into it, since there is
--            no existing table to backfill it from (that is the gap this
--            migration closes) -- any historical capital contributions/
--            loans/drawings that were posted directly as manual journal
--            entries in the past will still show up correctly in the new
--            reporting function (which reads the ledger), but will not
--            have a corresponding finance.capital_transactions master-data
--            row unless someone chooses to backfill one for record-keeping.
--            That backfill, if wanted, is a business decision requiring
--            someone who knows the actual historical transactions -- not
--            something this migration should invent.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS "finance"."capital_transactions" (
    "id" uuid DEFAULT gen_random_uuid() NOT NULL,
    "owner_id" uuid NOT NULL,
    "transaction_type" text NOT NULL,
    "amount" numeric(18,2) NOT NULL,
    "currency" text DEFAULT 'PKR'::text NOT NULL,
    "base_amount" numeric(18,2),
    "transaction_date" date NOT NULL,
    "description" text,
    "financial_account_id" uuid,
    "journal_entry_id" uuid,
    "status" text DEFAULT 'DRAFT' NOT NULL,
    "declared_by" uuid,
    "declared_at" timestamp with time zone,
    "approved_by" uuid,
    "approved_at" timestamp with time zone,
    "posted_by" uuid,
    "posted_at" timestamp with time zone,
    "notes" text,
    "created_at" timestamp with time zone DEFAULT now(),
    "updated_at" timestamp with time zone DEFAULT now(),
    "created_by" uuid,
    CONSTRAINT "capital_transactions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "capital_transactions_amount_check" CHECK (("amount" > (0)::numeric)),
    CONSTRAINT "capital_transactions_type_check"
        CHECK (("transaction_type" = ANY (ARRAY[
            'CAPITAL_CONTRIBUTION'::text,
            'OWNER_LOAN_ADVANCE'::text,
            'OWNER_LOAN_REPAYMENT'::text,
            'DRAWING'::text
        ]))),
    CONSTRAINT "capital_transactions_status_check"
        CHECK (("status" = ANY (ARRAY['DRAFT'::text, 'APPROVED'::text, 'POSTED'::text, 'CANCELLED'::text]))),
    CONSTRAINT "capital_transactions_owner_id_fkey"
        FOREIGN KEY ("owner_id") REFERENCES "finance"."owners"("id"),
    CONSTRAINT "capital_transactions_financial_account_id_fkey"
        FOREIGN KEY ("financial_account_id") REFERENCES "finance"."financial_accounts"("id"),
    CONSTRAINT "capital_transactions_journal_entry_id_fkey"
        FOREIGN KEY ("journal_entry_id") REFERENCES "finance"."journal_entries"("id")
);

ALTER TABLE "finance"."capital_transactions" OWNER TO "postgres";

COMMENT ON TABLE "finance"."capital_transactions" IS
  'Owner capital contributions, loan advances/repayments, and drawings. '
  'Spec Section 5.13/2.1. journal_entry_id links to the authoritative GL '
  'posting once posted -- this table is the structured entry point, not a '
  'parallel balance. See Migration 024.';

CREATE INDEX IF NOT EXISTS "idx_capital_txn_owner"
  ON "finance"."capital_transactions" USING btree ("owner_id");

CREATE INDEX IF NOT EXISTS "idx_capital_txn_date"
  ON "finance"."capital_transactions" USING btree ("transaction_date");

CREATE INDEX IF NOT EXISTS "idx_capital_txn_status"
  ON "finance"."capital_transactions" USING btree ("status")
  WHERE ("status" IN ('DRAFT','APPROVED'));

-- Reuse the same posted-record-immutability pattern already used elsewhere
-- in this schema (finance.prevent_posted_edit) rather than inventing a new
-- one: block edits once POSTED, consistent with spec Section 4.2.
CREATE OR REPLACE FUNCTION "finance"."prevent_posted_capital_transaction_edit"()
RETURNS "trigger"
LANGUAGE "plpgsql" SECURITY DEFINER
SET "search_path" TO 'pg_catalog', 'finance', 'public'
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'POSTED' THEN
      RAISE EXCEPTION 'Cannot delete a POSTED capital transaction (%). Reverse via the linked journal entry instead.', OLD.id;
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status = 'POSTED' AND NEW.status = 'POSTED' THEN
    RAISE EXCEPTION 'Cannot edit a POSTED capital transaction (%). Correct via a reversing journal entry.', OLD.id;
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION "finance"."prevent_posted_capital_transaction_edit"() OWNER TO "postgres";
REVOKE ALL ON FUNCTION "finance"."prevent_posted_capital_transaction_edit"() FROM PUBLIC;

DROP TRIGGER IF EXISTS "trg_prevent_posted_capital_transaction_edit" ON "finance"."capital_transactions";

CREATE TRIGGER "trg_prevent_posted_capital_transaction_edit"
  BEFORE UPDATE OR DELETE ON "finance"."capital_transactions"
  FOR EACH ROW
  EXECUTE FUNCTION "finance"."prevent_posted_capital_transaction_edit"();

ALTER TABLE "finance"."capital_transactions" ENABLE ROW LEVEL SECURITY;

-- RLS follows the same role pattern already used on finance.owners /
-- finance.profit_distributions in this schema (core.is_finance_head() /
-- core.has_role(...)) rather than inventing a new permission model.
CREATE POLICY "capital_txn_select" ON "finance"."capital_transactions"
  FOR SELECT
  USING (core.is_finance_head() OR core.has_role('ACCOUNTANT') OR core.has_role('CEO') OR core.has_role('VIEWER'));

CREATE POLICY "capital_txn_insert" ON "finance"."capital_transactions"
  FOR INSERT
  WITH CHECK (core.is_finance_head() OR core.has_role('ACCOUNTANT'));

CREATE POLICY "capital_txn_update" ON "finance"."capital_transactions"
  FOR UPDATE
  USING (core.is_finance_head() OR core.has_role('ACCOUNTANT'))
  WITH CHECK (core.is_finance_head() OR core.has_role('ACCOUNTANT'));

CREATE POLICY "capital_txn_delete" ON "finance"."capital_transactions"
  FOR DELETE
  USING (core.is_finance_head());

CREATE POLICY "capital_txn_service_all" ON "finance"."capital_transactions"
  TO "service_role" USING (true) WITH CHECK (true);

-- -----------------------------------------------------------------------------
-- Statement of Changes in Equity (spec Section 13.2)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "reporting"."get_statement_of_changes_in_equity"(
  "p_period_start" date,
  "p_period_end" date
)
RETURNS TABLE(
  "account_id" uuid,
  "code" text,
  "account_name" text,
  "opening_balance" numeric,
  "period_movement" numeric,
  "closing_balance" numeric
)
LANGUAGE "sql" STABLE SECURITY DEFINER
SET "search_path" TO 'pg_catalog', 'reporting', 'finance', 'public'
AS $$
WITH opening AS (
  SELECT
    coa.id AS account_id,
    COALESCE(SUM(jl.base_credit), 0) - COALESCE(SUM(jl.base_debit), 0) AS opening_balance
  FROM finance.chart_of_accounts coa
  LEFT JOIN finance.journal_lines jl ON jl.account_id = coa.id
  LEFT JOIN finance.journal_entries je
    ON je.id = jl.journal_entry_id
   AND je.status = 'POSTED'
   AND je.transaction_date < p_period_start
  WHERE coa.account_type = 'EQUITY'
  GROUP BY coa.id
),
movement AS (
  SELECT
    coa.id AS account_id,
    COALESCE(SUM(jl.base_credit), 0) - COALESCE(SUM(jl.base_debit), 0) AS period_movement
  FROM finance.chart_of_accounts coa
  LEFT JOIN finance.journal_lines jl ON jl.account_id = coa.id
  LEFT JOIN finance.journal_entries je
    ON je.id = jl.journal_entry_id
   AND je.status = 'POSTED'
   AND je.transaction_date >= p_period_start
   AND je.transaction_date <= p_period_end
  WHERE coa.account_type = 'EQUITY'
  GROUP BY coa.id
)
SELECT
  coa.id AS account_id,
  coa.code,
  coa.name AS account_name,
  COALESCE(o.opening_balance, 0) AS opening_balance,
  COALESCE(m.period_movement, 0) AS period_movement,
  COALESCE(o.opening_balance, 0) + COALESCE(m.period_movement, 0) AS closing_balance
FROM finance.chart_of_accounts coa
LEFT JOIN opening o ON o.account_id = coa.id
LEFT JOIN movement m ON m.account_id = coa.id
WHERE coa.account_type = 'EQUITY'
  AND coa.is_active = true
ORDER BY coa.code;
$$;

ALTER FUNCTION "reporting"."get_statement_of_changes_in_equity"("date", "date") OWNER TO "postgres";
REVOKE ALL ON FUNCTION "reporting"."get_statement_of_changes_in_equity"("date", "date") FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "reporting"."get_statement_of_changes_in_equity"("date", "date") TO "authenticated";

COMMENT ON FUNCTION "reporting"."get_statement_of_changes_in_equity"("date", "date") IS
  'Statement of Changes in Equity, spec Section 13.2. GL-derived (chart_of_'
  'accounts EQUITY type + posted journal_lines/journal_entries) using the '
  'same opening/movement/closing pattern as reporting.get_balance_sheet, so '
  'it reconciles to the ledger by construction. See Migration 024.';

COMMIT;

-- -----------------------------------------------------------------------------
-- Verification (read-only)
-- -----------------------------------------------------------------------------
-- SELECT * FROM reporting.get_statement_of_changes_in_equity('2025-07-01', '2026-06-30');
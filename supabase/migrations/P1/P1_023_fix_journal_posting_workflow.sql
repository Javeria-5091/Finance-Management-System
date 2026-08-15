-- ============================================================================
-- Migration: 029_fix_journal_posting_workflow.sql
-- Purpose:   Make finance.post_journal_entry() compatible with the triggers
--            attached in migration 028, and close Critical #5 (self-approval
--            on manual journals) properly instead of just patching around it.
--
-- MUST be applied together with / after 028. Migration 028 attaches
-- trg_maker_checker to finance.journal_entries. The CURRENT (unpatched)
-- post_journal_entry() sets created_by = submitted_by = verified_by =
-- approved_by = posted_by = auth.uid() on every call — after 028, every
-- single call (including the automatic postings from invoices, vendor
-- bills, payments, credit notes, bank transfers, distributions) would start
-- failing with MAKER_CHECKER_VIOLATION. This migration fixes that by
-- splitting behavior:
--
--   - System-sourced postings (source_type <> 'MANUAL': the invoice, bill,
--     payment, credit note, transfer, or distribution was already approved
--     through its OWN module workflow before this function is called) keep
--     posting straight to POSTED, but approved_by is left NULL — there is
--     no separate "who approved this specific journal" concept for a
--     journal that is a deterministic derivative of an already-approved
--     source document. posted_by still records who triggered the posting
--     action, for traceability.
--
--   - Manual/ad hoc journals (source_type = 'MANUAL', the default — used
--     for journals a human types in directly, with no upstream approved
--     document) now insert as DRAFT with only created_by set. They must
--     be moved to POSTED via the new finance.approve_and_post_journal_entry()
--     function below, which requires a Finance Head/Accountant role AND
--     (via the trigger) a DIFFERENT user than the creator. This is the
--     actual maker-checker control the specification requires for manual
--     journals (§7.1, §7.3).
--
-- The period-status guard itself is NOT duplicated in this function — the
-- trg_prevent_closed_period_posting trigger from migration 028 already
-- covers every INSERT/UPDATE on finance.journal_entries, including this
-- RPC's INSERT. Duplicating the check here would just be dead code once
-- the trigger exists. This migration relies on that trigger and does not
-- re-implement it, to avoid the two checks drifting apart later.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION "finance"."post_journal_entry"(
    "p_description" "text",
    "p_transaction_date" "date",
    "p_period_id" "uuid",
    "p_lines" "jsonb",
    "p_currency" "text" DEFAULT 'PKR'::"text",
    "p_exchange_rate" numeric DEFAULT 1.0000,
    "p_source_type" "text" DEFAULT 'MANUAL'::"text",
    "p_source_id" "uuid" DEFAULT NULL::"uuid",
    "p_project_id" "uuid" DEFAULT NULL::"uuid",
    "p_department_id" "uuid" DEFAULT NULL::"uuid"
) RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'public'
    AS $$
DECLARE
  v_journal_id UUID;
  v_ref TEXT;
  v_fiscal_year_id UUID;
  v_total_dr NUMERIC(18,2) := 0;
  v_total_cr NUMERIC(18,2) := 0;
  v_line_num INTEGER := 0;
  v_line JSONB;
  v_is_manual BOOLEAN;
BEGIN
  v_is_manual := (COALESCE(p_source_type, 'MANUAL') = 'MANUAL');

  -- 1. Get Fiscal Year from Period
  SELECT fiscal_year_id INTO v_fiscal_year_id
  FROM finance.accounting_periods WHERE id = p_period_id;

  IF v_fiscal_year_id IS NULL THEN
    RAISE EXCEPTION 'Invalid period_id: %', p_period_id;
  END IF;

  -- 2. Validate & Calculate Totals.
  --    This early check is kept for a fast, friendly error message before
  --    we build any rows. finance.check_journal_balance() (attached as a
  --    deferred constraint trigger in migration 028) remains the actual
  --    authoritative, unbypassable enforcement at COMMIT time.
  IF jsonb_array_length(p_lines) < 2 THEN
    RAISE EXCEPTION 'Journal must have at least 2 lines';
  END IF;

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    v_total_dr := v_total_dr + COALESCE((v_line->>'debit_amount')::NUMERIC(18,2), 0);
    v_total_cr := v_total_cr + COALESCE((v_line->>'credit_amount')::NUMERIC(18,2), 0);
  END LOOP;

  IF ABS(v_total_dr - v_total_cr) > 0.01 THEN
    RAISE EXCEPTION 'Journal unbalanced: DR=% CR=%', v_total_dr, v_total_cr;
  END IF;

  -- 3. Get Reference
  v_ref := finance.get_next_number('JOURNAL_ENTRY');

  -- 4. Insert Header.
  --    System-sourced (non-MANUAL) postings: already approved via their own
  --    module workflow -> insert directly as POSTED, approved_by left NULL
  --    (no separate journal-level approver; see header comment).
  --    Manual postings: insert as DRAFT, only created_by set. Must be
  --    completed via finance.approve_and_post_journal_entry() below.
  IF v_is_manual THEN
    INSERT INTO finance.journal_entries (
      reference, description, status, transaction_date,
      period_id, fiscal_year_id, currency, exchange_rate, base_currency,
      total_debit, total_credit, source_type, source_id, project_id, department_id,
      created_by
    ) VALUES (
      v_ref, p_description, 'DRAFT', p_transaction_date,
      p_period_id, v_fiscal_year_id, p_currency, p_exchange_rate, 'PKR',
      v_total_dr, v_total_cr, p_source_type, p_source_id, p_project_id, p_department_id,
      auth.uid()
    ) RETURNING id INTO v_journal_id;
  ELSE
    INSERT INTO finance.journal_entries (
      reference, description, status, transaction_date, posting_date,
      period_id, fiscal_year_id, currency, exchange_rate, base_currency,
      total_debit, total_credit, source_type, source_id, project_id, department_id,
      created_by, posted_by, posted_at
    ) VALUES (
      v_ref, p_description, 'POSTED', p_transaction_date, CURRENT_DATE,
      p_period_id, v_fiscal_year_id, p_currency, p_exchange_rate, 'PKR',
      v_total_dr, v_total_cr, p_source_type, p_source_id, p_project_id, p_department_id,
      auth.uid(), auth.uid(), NOW()
    ) RETURNING id INTO v_journal_id;
  END IF;

  -- 5. Insert Lines (unchanged)
  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    v_line_num := v_line_num + 1;

    INSERT INTO finance.journal_lines (
      journal_entry_id, line_number, account_id, description,
      debit_amount, credit_amount, currency, exchange_rate,
      base_debit, base_credit, project_id, department_id, created_by
    ) VALUES (
      v_journal_id, v_line_num,
      (v_line->>'account_id')::UUID,
      v_line->>'description',
      COALESCE((v_line->>'debit_amount')::NUMERIC(18,2), 0),
      COALESCE((v_line->>'credit_amount')::NUMERIC(18,2), 0),
      p_currency, p_exchange_rate,
      COALESCE((v_line->>'debit_amount')::NUMERIC(18,2), 0) * p_exchange_rate,
      COALESCE((v_line->>'credit_amount')::NUMERIC(18,2), 0) * p_exchange_rate,
      COALESCE((v_line->>'project_id')::UUID, p_project_id),
      p_department_id, auth.uid()
    );
  END LOOP;

  RETURN v_journal_id;
END;
$$;

ALTER FUNCTION "finance"."post_journal_entry"(
    "p_description" "text", "p_transaction_date" "date", "p_period_id" "uuid",
    "p_lines" "jsonb", "p_currency" "text", "p_exchange_rate" numeric,
    "p_source_type" "text", "p_source_id" "uuid", "p_project_id" "uuid",
    "p_department_id" "uuid"
) OWNER TO "postgres";

COMMENT ON FUNCTION "finance"."post_journal_entry"(
    "p_description" "text", "p_transaction_date" "date", "p_period_id" "uuid",
    "p_lines" "jsonb", "p_currency" "text", "p_exchange_rate" numeric,
    "p_source_type" "text", "p_source_id" "uuid", "p_project_id" "uuid",
    "p_department_id" "uuid"
) IS 'Fixed migration 029: MANUAL-source journals now insert as DRAFT (no self-approval); system-sourced journals post directly with approved_by left NULL to satisfy maker-checker. See audit Critical #4/#5.';

-- ----------------------------------------------------------------------------
-- New RPC: complete the DRAFT -> POSTED workflow for a manual journal.
-- The maker-checker trigger (finance.enforce_maker_checker, attached to
-- finance.journal_entries in migration 028) fires on this UPDATE and will
-- reject the call if the approver is the same user as created_by.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "finance"."approve_and_post_journal_entry"(
    "p_journal_id" "uuid"
) RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'public'
    AS $$
DECLARE
  v_status TEXT;
  v_source_type TEXT;
BEGIN
  IF NOT (core.is_finance_head() OR core.has_role('ACCOUNTANT')) THEN
    RAISE EXCEPTION 'Only Finance Head or Accountant may approve and post a journal entry';
  END IF;

  SELECT status, source_type INTO v_status, v_source_type
  FROM finance.journal_entries WHERE id = p_journal_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Journal entry % not found', p_journal_id;
  END IF;

  IF v_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'Journal entry % is not in DRAFT status (current: %)', p_journal_id, v_status;
  END IF;

  IF COALESCE(v_source_type, 'MANUAL') <> 'MANUAL' THEN
    RAISE EXCEPTION 'System-sourced journal entries post automatically and cannot be approved through this function';
  END IF;

  -- The trg_maker_checker + trg_prevent_closed_period_posting triggers on
  -- finance.journal_entries, and trg_check_journal_balance on
  -- finance.journal_lines, all fire on this UPDATE and enforce their rules.
  UPDATE finance.journal_entries
  SET status = 'POSTED',
      submitted_by = COALESCE(submitted_by, auth.uid()),
      submitted_at = COALESCE(submitted_at, NOW()),
      verified_by = COALESCE(verified_by, auth.uid()),
      verified_at = COALESCE(verified_at, NOW()),
      approved_by = auth.uid(),
      approved_at = NOW(),
      posted_by = auth.uid(),
      posted_at = NOW(),
      posting_date = CURRENT_DATE
  WHERE id = p_journal_id;

  RETURN p_journal_id;
END;
$$;

ALTER FUNCTION "finance"."approve_and_post_journal_entry"("p_journal_id" "uuid") OWNER TO "postgres";
COMMENT ON FUNCTION "finance"."approve_and_post_journal_entry"("p_journal_id" "uuid") IS
    'Added migration 029. Completes the maker-checker approval + posting step for a MANUAL journal left in DRAFT by finance.post_journal_entry(). Enforces creator <> approver via trg_maker_checker.';

REVOKE ALL ON FUNCTION "finance"."approve_and_post_journal_entry"("p_journal_id" "uuid") FROM "anon";
GRANT EXECUTE ON FUNCTION "finance"."approve_and_post_journal_entry"("p_journal_id" "uuid") TO "authenticated";

COMMIT;

-- ----------------------------------------------------------------------------
-- APPLICATION CODE IMPACT — read before deploying.
-- ----------------------------------------------------------------------------
-- Any existing frontend/API code that calls finance.post_journal_entry()
-- with the DEFAULT p_source_type ('MANUAL') and expects the returned
-- journal to already be status = 'POSTED' will now receive a 'DRAFT'
-- journal instead, and must call finance.approve_and_post_journal_entry()
-- (as a second user) to complete posting. Calls that already pass an
-- explicit non-MANUAL source_type (post_invoice_ar, post_credit_note,
-- post_bank_transfer, post_distribution_payment, post_payment_receipt,
-- post_profit_distribution, post_vendor_payment) are unaffected in
-- behavior -- they still return an immediately-POSTED journal. This is
-- flagged again in Section E (Application Code Changes Required) below.
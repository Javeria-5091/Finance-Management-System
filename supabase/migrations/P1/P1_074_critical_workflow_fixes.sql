-- OSYSTIC Finance - Current-state critical workflow contract fixes
-- Applies only to confirmed remaining blockers from the 2026-08-29 audit.
-- Safe to run more than once.

BEGIN;

-- BUG-003: payment receipt numbering.
-- finance.get_next_number() intentionally raises when a sequence is absent,
-- so seed the canonical PMT-RC sequence for every existing organization.
INSERT INTO finance.numbering_sequences
  (sequence_type, prefix, current_number, padding, reset_per_period, format, organization_id, created_by)
SELECT
  'PMT-RC', 'PMT-RC-', 0, 4, false, '{PREFIX}{NUMBER}', o.id, NULL
FROM core.organizations o
WHERE NOT EXISTS (
  SELECT 1
  FROM finance.numbering_sequences ns
  WHERE ns.organization_id = o.id
    AND ns.sequence_type = 'PMT-RC'
    AND ns.fiscal_year_id IS NULL
);

-- Keep the sequence available for organizations created after this migration.
CREATE OR REPLACE FUNCTION finance.ensure_payment_receipt_numbering_sequence()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO pg_catalog, finance, public, core
AS $$
BEGIN
  INSERT INTO finance.numbering_sequences
    (sequence_type, prefix, current_number, padding, reset_per_period, format, organization_id, created_by)
  VALUES
    ('PMT-RC', 'PMT-RC-', 0, 4, false, '{PREFIX}{NUMBER}', NEW.id, NULL)
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ensure_payment_receipt_numbering_sequence ON core.organizations;
CREATE TRIGGER trg_ensure_payment_receipt_numbering_sequence
AFTER INSERT ON core.organizations
FOR EACH ROW
EXECUTE FUNCTION finance.ensure_payment_receipt_numbering_sequence();

-- BUG-008: the workflow route records verification/reversal metadata on
-- expenses/incomes. Add the nullable audit fields required by that workflow.
ALTER TABLE public.expenses
  ADD COLUMN IF NOT EXISTS verified_by uuid,
  ADD COLUMN IF NOT EXISTS verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS reversal_reason text,
  ADD COLUMN IF NOT EXISTS reversed_by uuid,
  ADD COLUMN IF NOT EXISTS reversed_at timestamptz;

ALTER TABLE public.incomes
  ADD COLUMN IF NOT EXISTS verified_by uuid,
  ADD COLUMN IF NOT EXISTS verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS reversal_reason text,
  ADD COLUMN IF NOT EXISTS reversed_by uuid,
  ADD COLUMN IF NOT EXISTS reversed_at timestamptz;

-- BUG-008: make expense/income reversal atomic with the GL reversal.
-- Each wrapper has a fixed table name; no caller-controlled SQL is used.
CREATE OR REPLACE FUNCTION finance.reverse_expense_atomic(
  p_expense_id uuid,
  p_reversal_date date,
  p_reason text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO pg_catalog, finance, public, core
AS $$
DECLARE
  v_org uuid := core.current_user_org_id();
  v_journal_id uuid;
  v_reversal_id uuid;
BEGIN
  IF v_org IS NULL OR NOT (core.is_finance_head() OR core.has_role('ACCOUNTANT')) THEN
    RAISE EXCEPTION 'Access denied';
  END IF;

  SELECT journal_entry_id
    INTO v_journal_id
  FROM public.expenses
  WHERE id = p_expense_id
    AND organization_id = v_org
    AND status = 'POSTED'
  FOR UPDATE;

  IF NOT FOUND OR v_journal_id IS NULL THEN
    RAISE EXCEPTION 'Posted expense not found or has no linked journal entry';
  END IF;

  v_reversal_id := finance.reverse_journal_entry(v_journal_id, p_reversal_date, p_reason);

  UPDATE public.expenses
  SET status = 'REVERSED',
      reversal_reason = p_reason,
      reversed_by = auth.uid(),
      reversed_at = now(),
      journal_entry_id = v_reversal_id
  WHERE id = p_expense_id
    AND organization_id = v_org
    AND status = 'POSTED';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense status update failed';
  END IF;

  RETURN v_reversal_id;
END;
$$;

CREATE OR REPLACE FUNCTION finance.reverse_income_atomic(
  p_income_id uuid,
  p_reversal_date date,
  p_reason text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO pg_catalog, finance, public, core
AS $$
DECLARE
  v_org uuid := core.current_user_org_id();
  v_journal_id uuid;
  v_reversal_id uuid;
BEGIN
  IF v_org IS NULL OR NOT (core.is_finance_head() OR core.has_role('ACCOUNTANT')) THEN
    RAISE EXCEPTION 'Access denied';
  END IF;

  SELECT journal_entry_id
    INTO v_journal_id
  FROM public.incomes
  WHERE id = p_income_id
    AND organization_id = v_org
    AND status = 'POSTED'
  FOR UPDATE;

  IF NOT FOUND OR v_journal_id IS NULL THEN
    RAISE EXCEPTION 'Posted income not found or has no linked journal entry';
  END IF;

  v_reversal_id := finance.reverse_journal_entry(v_journal_id, p_reversal_date, p_reason);

  UPDATE public.incomes
  SET status = 'REVERSED',
      reversal_reason = p_reason,
      reversed_by = auth.uid(),
      reversed_at = now(),
      journal_entry_id = v_reversal_id
  WHERE id = p_income_id
    AND organization_id = v_org
    AND status = 'POSTED';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Income status update failed';
  END IF;

  RETURN v_reversal_id;
END;
$$;

GRANT EXECUTE ON FUNCTION finance.reverse_expense_atomic(uuid, date, text) TO authenticated;
GRANT EXECUTE ON FUNCTION finance.reverse_income_atomic(uuid, date, text) TO authenticated;

-- BUG-009: fields used by mark-paid were missing from the authoritative table.
ALTER TABLE public.payroll_runs
  ADD COLUMN IF NOT EXISTS paid_by uuid,
  ADD COLUMN IF NOT EXISTS paid_at timestamptz;

COMMIT;

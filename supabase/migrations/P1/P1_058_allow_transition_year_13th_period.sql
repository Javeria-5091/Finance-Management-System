-- =============================================================================
-- Migration: P1_058_allow_transition_year_13th_period.sql
-- Purpose:   Fix BUG-027 (audit Section 8.2, High).
--
-- Issue: finance.accounting_periods.period_number has
--        CHECK (period_number BETWEEN 1 AND 12), which unconditionally
--        blocks a 13th period. P1_033_fiscal_year_transition_flag.sql
--        already added finance.fiscal_years.is_transition_year (+
--        transition_approved_by/at) to represent Spec 4.3's "a period from
--        1 June through the following 30 June is thirteen months and may
--        only be created as an explicitly approved one-time transition
--        period" — but nothing changed the accounting_periods CHECK, so
--        even an approved transition-year fiscal year still cannot have a
--        13th period inserted.
--
-- Fix: 1) widen the CHECK constraint on period_number to 1..13 (this alone
--         would let ANY fiscal year get a 13th period, which is too loose)
--      2) add a trigger that enforces the actual spec rule: period_number
--         13 is only allowed when the owning fiscal_years row has
--         is_transition_year = true AND transition_approved_by/at are set
--         (i.e. genuinely approved, matching the existing
--         fy_transition_requires_approval constraint from P1_033).
--         Regular (non-transition) fiscal years remain limited to 12
--         periods, exactly as before.
--
-- This is additive/corrective only: no existing row is modified, and every
-- fiscal year that is not flagged as a transition year keeps behaving
-- exactly as it does today (max 12 periods, unchanged CHECK behavior for
-- periods 1-12).
-- =============================================================================

BEGIN;

-- 1. Widen the range check. (13 is now structurally permitted; the trigger
--    below is what actually restricts *when* 13 may be used.)
ALTER TABLE "finance"."accounting_periods"
  DROP CONSTRAINT IF EXISTS "accounting_periods_period_number_check";
ALTER TABLE "finance"."accounting_periods"
  ADD CONSTRAINT "accounting_periods_period_number_check"
  CHECK ("period_number" BETWEEN 1 AND 13);

-- 2. Enforce the real business rule: a 13th period may only belong to a
--    fiscal year that is explicitly flagged AND approved as a transition
--    year.
CREATE OR REPLACE FUNCTION "finance"."enforce_transition_year_period_13"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, finance, public
AS $$
DECLARE
  v_is_transition boolean;
  v_approved_by uuid;
  v_approved_at timestamptz;
BEGIN
  IF NEW.period_number <> 13 THEN
    RETURN NEW;
  END IF;

  SELECT is_transition_year, transition_approved_by, transition_approved_at
    INTO v_is_transition, v_approved_by, v_approved_at
    FROM finance.fiscal_years
   WHERE id = NEW.fiscal_year_id;

  IF v_is_transition IS NOT TRUE THEN
    RAISE EXCEPTION
      'Period 13 is only allowed for a fiscal year explicitly flagged is_transition_year = true (fiscal_year_id %). Regular fiscal years are limited to 12 periods per spec Section 4.3.',
      NEW.fiscal_year_id;
  END IF;

  IF v_approved_by IS NULL OR v_approved_at IS NULL THEN
    RAISE EXCEPTION
      'Period 13 requires the owning fiscal year to have recorded transition approval (transition_approved_by/transition_approved_at) per spec Section 4.3 ("explicitly approved one-time transition period"). fiscal_year_id %.',
      NEW.fiscal_year_id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "trg_enforce_transition_year_period_13" ON "finance"."accounting_periods";
CREATE TRIGGER "trg_enforce_transition_year_period_13"
  BEFORE INSERT OR UPDATE OF period_number, fiscal_year_id ON "finance"."accounting_periods"
  FOR EACH ROW
  EXECUTE FUNCTION "finance"."enforce_transition_year_period_13"();

COMMENT ON FUNCTION "finance"."enforce_transition_year_period_13"() IS
  'BUG-027 fix: restricts accounting_periods.period_number = 13 to fiscal years explicitly flagged and approved as a transition year (finance.fiscal_years.is_transition_year/transition_approved_by/transition_approved_at), per spec Section 4.3.';

COMMIT;
-- ═════════════════════════════════════════════════════════════════════
--  BUG-010 FIX (DB layer): extend the maker-checker trigger from
--  supabase/migrations/P0/040_maker_checker_trigger.sql to cover
--  finance.vendor_payments.
--
--  Audit evidence: "the DB maker-checker trigger does not cover
--  vendor_payments" — finance.enforce_maker_checker() only handled
--  expenses/incomes/invoices (user_id) and vendor_bills/journal_entries
--  (created_by). A vendor_payment could previously be approved by its own
--  creator with only the (removable) application-layer check to stop it.
--  This migration makes the DB itself refuse that, as a second line of
--  defense behind the new src/app/api/finance/vendor-payments/[id]/route.ts
--  server-side check.
-- ═════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION finance.enforce_maker_checker()
RETURNS TRIGGER AS $$
DECLARE
  v_creator_id UUID;
  v_approver_id UUID;
  v_table TEXT;
BEGIN
  v_table := TG_TABLE_NAME;

  IF v_table IN ('expenses', 'incomes', 'invoices') THEN
    v_creator_id := COALESCE(OLD.user_id, NEW.user_id);
    v_approver_id := NEW.approved_by;
  ELSIF v_table IN ('vendor_bills', 'journal_entries') THEN
    v_creator_id := COALESCE(OLD.created_by, NEW.created_by);
    v_approver_id := NEW.approved_by;
  -- BUG-010 FIX: finance.vendor_payments uses created_by / approved_by,
  -- same shape as vendor_bills/journal_entries.
  ELSIF v_table = 'vendor_payments' THEN
    v_creator_id := COALESCE(OLD.created_by, NEW.created_by);
    v_approver_id := NEW.approved_by;
  ELSE
    RETURN NEW;
  END IF;

  IF v_approver_id IS NOT NULL AND v_creator_id IS NOT NULL AND v_approver_id = v_creator_id THEN
    RAISE EXCEPTION 'MAKER_CHECKER_VIOLATION: Creator (user %) cannot approve their own record in %',
      v_creator_id, v_table;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.triggers WHERE event_object_table = 'vendor_payments' AND trigger_name = 'chk_maker_checker') THEN
    DROP TRIGGER chk_maker_checker ON finance.vendor_payments;
  END IF;
  CREATE TRIGGER chk_maker_checker BEFORE UPDATE ON finance.vendor_payments
    FOR EACH ROW EXECUTE FUNCTION finance.enforce_maker_checker();
END $$;
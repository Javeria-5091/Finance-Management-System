-- ═════════════════════════════════════════════════════════════════════
--  MAKER-CHECKER TRIGGER — Prevents creator from approving own records
--  Applies to: expenses, incomes, invoices, vendor_bills, journal_entries
--  
--  IMPORTANT: 
--  - expenses/incomes/invoices live in `public` schema and use `user_id` as creator
--  - vendor_bills/journal_entries live in `finance` schema and use `created_by`
-- ═════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION finance.enforce_maker_checker()
RETURNS TRIGGER AS $$
DECLARE
  v_creator_id UUID;
  v_approver_id UUID;
  v_table TEXT;
  v_schema TEXT;
BEGIN
  v_table := TG_TABLE_NAME;
  v_schema := TG_TABLE_SCHEMA;
  
  -- Get creator and approver IDs based on table
  -- public.expenses, public.incomes, public.invoices use `user_id` as creator
  -- finance.vendor_bills, finance.journal_entries use `created_by` as creator
  IF v_table IN ('expenses', 'incomes', 'invoices') THEN
    v_creator_id := COALESCE(OLD.user_id, NEW.user_id);
    v_approver_id := NEW.approved_by;
  ELSIF v_table IN ('vendor_bills', 'journal_entries') THEN
    v_creator_id := COALESCE(OLD.created_by, NEW.created_by);
    v_approver_id := NEW.approved_by;
  ELSE
    RETURN NEW;
  END IF;

  -- Enforce: creator cannot be the approver
  IF v_approver_id IS NOT NULL AND v_creator_id IS NOT NULL AND v_approver_id = v_creator_id THEN
    RAISE EXCEPTION 'MAKER_CHECKER_VIOLATION: Creator (user %) cannot approve their own record in %', 
      v_creator_id, v_table;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Apply trigger to all relevant tables
DO $$ BEGIN
  -- ─── public.expenses (creator field: user_id) ───
  IF EXISTS (SELECT 1 FROM information_schema.triggers WHERE event_object_table = 'expenses' AND trigger_name = 'chk_maker_checker') THEN
    DROP TRIGGER chk_maker_checker ON public.expenses;
  END IF;
  CREATE TRIGGER chk_maker_checker BEFORE UPDATE ON public.expenses
    FOR EACH ROW EXECUTE FUNCTION finance.enforce_maker_checker();

  -- ─── public.incomes (creator field: user_id) ───
  IF EXISTS (SELECT 1 FROM information_schema.triggers WHERE event_object_table = 'incomes' AND trigger_name = 'chk_maker_checker') THEN
    DROP TRIGGER chk_maker_checker ON public.incomes;
  END IF;
  CREATE TRIGGER chk_maker_checker BEFORE UPDATE ON public.incomes
    FOR EACH ROW EXECUTE FUNCTION finance.enforce_maker_checker();

  -- ─── public.invoices (creator field: user_id) ───
  IF EXISTS (SELECT 1 FROM information_schema.triggers WHERE event_object_table = 'invoices' AND trigger_name = 'chk_maker_checker') THEN
    DROP TRIGGER chk_maker_checker ON public.invoices;
  END IF;
  CREATE TRIGGER chk_maker_checker BEFORE UPDATE ON public.invoices
    FOR EACH ROW EXECUTE FUNCTION finance.enforce_maker_checker();

  -- ─── finance.vendor_bills (creator field: created_by) ───
  IF EXISTS (SELECT 1 FROM information_schema.triggers WHERE event_object_table = 'vendor_bills' AND trigger_name = 'chk_maker_checker') THEN
    DROP TRIGGER chk_maker_checker ON finance.vendor_bills;
  END IF;
  CREATE TRIGGER chk_maker_checker BEFORE UPDATE ON finance.vendor_bills
    FOR EACH ROW EXECUTE FUNCTION finance.enforce_maker_checker();

  -- ─── finance.journal_entries (creator field: created_by) ───
  IF EXISTS (SELECT 1 FROM information_schema.triggers WHERE event_object_table = 'journal_entries' AND trigger_name = 'chk_maker_checker') THEN
    DROP TRIGGER chk_maker_checker ON finance.journal_entries;
  END IF;
  CREATE TRIGGER chk_maker_checker BEFORE UPDATE ON finance.journal_entries
    FOR EACH ROW EXECUTE FUNCTION finance.enforce_maker_checker();
END $$;

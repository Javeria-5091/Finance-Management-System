-- 033_accounting_integrity_fixes.sql
--
-- Fixes four issues found in the final specification-alignment audit,
-- all additive/enforcement-only -- no data is dropped, deleted, or
-- rewritten, and no existing valid record becomes invalid by this
-- migration alone (see per-step notes on what happens to existing rows).

BEGIN;

-- =======================================================================
-- STEP 1: Base-currency (PKR) journal balance enforcement
-- Spec 4.1: "Total debit must equal total credit in the transaction
-- currency and base currency." The existing trigger validated only
-- debit_amount/credit_amount (transaction currency); this extends it.
-- =======================================================================
CREATE OR REPLACE FUNCTION "finance"."check_journal_balance"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  v_journal_id uuid;
  v_total_debit numeric(18,2);
  v_total_credit numeric(18,2);
  v_total_base_debit numeric(18,2);
  v_total_base_credit numeric(18,2);
BEGIN
  v_journal_id := COALESCE(NEW.journal_entry_id, OLD.journal_entry_id);

  SELECT
    COALESCE(SUM(debit_amount), 0), COALESCE(SUM(credit_amount), 0),
    COALESCE(SUM(COALESCE(base_debit, debit_amount)), 0),
    COALESCE(SUM(COALESCE(base_credit, credit_amount)), 0)
  INTO v_total_debit, v_total_credit, v_total_base_debit, v_total_base_credit
  FROM finance.journal_lines
  WHERE journal_entry_id = v_journal_id;

  IF abs(v_total_debit - v_total_credit) > 0.01 THEN
    RAISE EXCEPTION 'Journal entry % is unbalanced in transaction currency: debit % != credit %',
      v_journal_id, v_total_debit, v_total_credit
      USING ERRCODE = 'check_violation';
  END IF;

  IF abs(v_total_base_debit - v_total_base_credit) > 0.01 THEN
    RAISE EXCEPTION 'Journal entry % is unbalanced in base (PKR) currency: base debit % != base credit %',
      v_journal_id, v_total_base_debit, v_total_base_credit
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE finance.journal_entries
  SET total_debit = v_total_debit, total_credit = v_total_credit
  WHERE id = v_journal_id;

  RETURN NULL;
END;
$$;

-- NOTE ON EXISTING DATA: COALESCE(base_debit, debit_amount) means any
-- existing row where base_debit/base_credit was left NULL (pure-PKR
-- rows, where transaction currency = base currency) is treated as
-- already balanced -- this does not retroactively invalidate anything.
-- It only starts catching NEW or EDITED foreign-currency journals where
-- base amounts were populated inconsistently, which is exactly the gap
-- identified in the original audit.

-- =======================================================================
-- STEP 2: Posted-invoice UPDATE protection (was DELETE-only)
-- Spec 4.2: "Posted entries are immutable. Corrections use reversal or
-- adjustment entries." journal_entry_id IS NOT NULL is this schema's
-- existing, already-correct signal for "posted" (reused from
-- prevent_posted_invoice_deletion for consistency).
-- =======================================================================
CREATE OR REPLACE FUNCTION "public"."prevent_posted_invoice_edit"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  IF OLD.journal_entry_id IS NOT NULL THEN
    -- Allow status/payment-tracking fields to keep moving (paid amount,
    -- status, updated_at) since those reflect real subsequent events
    -- (payments, void) rather than rewriting the posted financial facts.
    IF NEW.total_amount IS DISTINCT FROM OLD.total_amount
       OR NEW.tax_amount IS DISTINCT FROM OLD.tax_amount
       OR NEW.currency IS DISTINCT FROM OLD.currency
       OR NEW.client_id IS DISTINCT FROM OLD.client_id
       OR NEW.issue_date IS DISTINCT FROM OLD.issue_date
       OR NEW.journal_entry_id IS DISTINCT FROM OLD.journal_entry_id
    THEN
      RAISE EXCEPTION
        'Cannot modify financial fields of invoice "%": it has already been posted to the general ledger (journal_entry_id = %). Issue a credit note or reversal instead.',
        OLD.invoice_number, OLD.journal_entry_id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION "public"."prevent_posted_invoice_edit"() OWNER TO "postgres";

DROP TRIGGER IF EXISTS "trg_prevent_posted_invoice_edit" ON "public"."invoices";
CREATE TRIGGER "trg_prevent_posted_invoice_edit"
  BEFORE UPDATE ON "public"."invoices"
  FOR EACH ROW EXECUTE FUNCTION "public"."prevent_posted_invoice_edit"();

-- =======================================================================
-- STEP 3: Posted vendor-bill immutability (previously had NONE)
-- =======================================================================
CREATE OR REPLACE FUNCTION "finance"."prevent_posted_vendor_bill_edit"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.status = 'POSTED' THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'Cannot delete vendor bill "%": it is POSTED. Reverse it instead.', OLD.bill_number
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.total_amount IS DISTINCT FROM OLD.total_amount
       OR NEW.vendor_id IS DISTINCT FROM OLD.vendor_id
       OR NEW.currency IS DISTINCT FROM OLD.currency
       OR NEW.status NOT IN ('POSTED','PARTIALLY_PAID','PAID','REVERSED','CANCELLED')
    THEN
      RAISE EXCEPTION 'Cannot modify financial fields of vendor bill "%": it is POSTED. Reverse it instead.', OLD.bill_number
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION "finance"."prevent_posted_vendor_bill_edit"() OWNER TO "postgres";

DROP TRIGGER IF EXISTS "trg_prevent_posted_vendor_bill_edit" ON "finance"."vendor_bills";
CREATE TRIGGER "trg_prevent_posted_vendor_bill_edit"
  BEFORE UPDATE OR DELETE ON "finance"."vendor_bills"
  FOR EACH ROW EXECUTE FUNCTION "finance"."prevent_posted_vendor_bill_edit"();

-- =======================================================================
-- STEP 4: Posted payroll-run immutability (previously had NONE)
-- Spec 5.9: "Payroll runs store a snapshot/version of every input used
-- so later HR edits do not silently change an approved run."
-- =======================================================================
CREATE OR REPLACE FUNCTION "public"."prevent_posted_payroll_run_edit"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.status = 'POSTED' THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'Cannot delete payroll run "%": it is POSTED.', OLD.id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.status NOT IN ('POSTED','CANCELLED') THEN
      RAISE EXCEPTION 'Cannot modify a POSTED payroll run (id %). Create an adjustment run instead.', OLD.id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION "public"."prevent_posted_payroll_run_edit"() OWNER TO "postgres";

DROP TRIGGER IF EXISTS "trg_prevent_posted_payroll_run_edit" ON "public"."payroll_runs";
CREATE TRIGGER "trg_prevent_posted_payroll_run_edit"
  BEFORE UPDATE OR DELETE ON "public"."payroll_runs"
  FOR EACH ROW EXECUTE FUNCTION "public"."prevent_posted_payroll_run_edit"();

-- =======================================================================
-- STEP 5: Enforce the existing tax_rule_sets status lifecycle
-- (LOCKED/SUPERSEDED already existed as valid status values but were
-- never actually enforced against edits)
-- =======================================================================
CREATE OR REPLACE FUNCTION "finance"."prevent_locked_tax_rule_edit"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  IF TG_OP IN ('UPDATE','DELETE') AND OLD.status IN ('APPROVED','LOCKED','SUPERSEDED') THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'Cannot delete tax rule set "%" (status %): once approved it is retained for computations that reference it.', OLD.name, OLD.status
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.status = 'DRAFT' OR NEW.name IS DISTINCT FROM OLD.name
       OR NEW.jurisdiction IS DISTINCT FROM OLD.jurisdiction
       OR NEW.taxpayer_type IS DISTINCT FROM OLD.taxpayer_type
       OR NEW.tax_year IS DISTINCT FROM OLD.tax_year
    THEN
      RAISE EXCEPTION 'Cannot modify tax rule set "%": status is % (approved/locked). Create a new versioned rule set instead.', OLD.name, OLD.status
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION "finance"."prevent_locked_tax_rule_edit"() OWNER TO "postgres";

DROP TRIGGER IF EXISTS "trg_prevent_locked_tax_rule_edit" ON "finance"."tax_rule_sets";
CREATE TRIGGER "trg_prevent_locked_tax_rule_edit"
  BEFORE UPDATE OR DELETE ON "finance"."tax_rule_sets"
  FOR EACH ROW EXECUTE FUNCTION "finance"."prevent_locked_tax_rule_edit"();

-- Same protection for the slab lines, keyed off the parent rule set's status
CREATE OR REPLACE FUNCTION "finance"."prevent_locked_tax_slab_edit"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  v_status text;
BEGIN
  SELECT status INTO v_status FROM finance.tax_rule_sets WHERE id = COALESCE(NEW.tax_rule_set_id, OLD.tax_rule_set_id);
  IF v_status IN ('APPROVED','LOCKED','SUPERSEDED') THEN
    RAISE EXCEPTION 'Cannot modify tax slabs for a rule set with status %. Create a new versioned rule set instead.', v_status
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION "finance"."prevent_locked_tax_slab_edit"() OWNER TO "postgres";

DROP TRIGGER IF EXISTS "trg_prevent_locked_tax_slab_edit" ON "finance"."tax_slabs";
CREATE TRIGGER "trg_prevent_locked_tax_slab_edit"
  BEFORE INSERT OR UPDATE OR DELETE ON "finance"."tax_slabs"
  FOR EACH ROW EXECUTE FUNCTION "finance"."prevent_locked_tax_slab_edit"();

-- =======================================================================
-- STEP 6: Auto-snapshot the rule set into computation_json for NEW
-- tax_computations rows going forward. This does NOT touch existing
-- rows -- see the manual-decision note below.
-- =======================================================================
CREATE OR REPLACE FUNCTION "finance"."snapshot_tax_rule_set"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  IF NEW.computation_json IS NULL AND NEW.tax_rule_set_id IS NOT NULL THEN
    SELECT jsonb_build_object(
      'rule_set', to_jsonb(trs.*),
      'slabs', (SELECT jsonb_agg(to_jsonb(ts.*) ORDER BY ts.sort_order) FROM finance.tax_slabs ts WHERE ts.tax_rule_set_id = trs.id),
      'snapshot_taken_at', now()
    )
    INTO NEW.computation_json
    FROM finance.tax_rule_sets trs
    WHERE trs.id = NEW.tax_rule_set_id;
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION "finance"."snapshot_tax_rule_set"() OWNER TO "postgres";

DROP TRIGGER IF EXISTS "trg_snapshot_tax_rule_set" ON "finance"."tax_computations";
CREATE TRIGGER "trg_snapshot_tax_rule_set"
  BEFORE INSERT ON "finance"."tax_computations"
  FOR EACH ROW EXECUTE FUNCTION "finance"."snapshot_tax_rule_set"();

COMMENT ON FUNCTION "finance"."snapshot_tax_rule_set"() IS
  'Auto-populates tax_computations.computation_json with an immutable snapshot of the referenced tax_rule_set + tax_slabs at insert time (Spec 5.12.1). Applies to new rows only -- existing tax_computations rows created before this migration do not have a verified-accurate historical snapshot and require a manual decision (see Migration 033 notes) before they can be trusted for a filed return.';

COMMIT;
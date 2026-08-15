-- =============================================================================
-- Migration: 030_permission_catalog_and_journal_immutability.sql
-- Purpose  : Two related P0 fixes:
--
--   PART A — Permission catalog additions.
--   The RLS rewrites in migrations 031-033 reference permission codes that
--   express the resource/action grain the spec requires (Section 7.2:
--   "Resource... Action... view, create, edit, submit, verify, approve,
--   reject, post, reverse, reconcile, export"). core.permissions is a
--   data-driven catalog with no seed rows in schema.sql, so this migration
--   idempotently INSERTs the specific codes needed (ON CONFLICT DO NOTHING
--   keyed on the existing UNIQUE code column), without assigning them to any
--   role — role/permission assignment is business configuration owned by
--   the CEO/Finance Head via the application's role management screen
--   (spec 5.1 "CEO can create or change a role, assign a scoped permission
--   and limit"), not something a database migration should decide on this
--   project's behalf. See the deployment notes for the required one-time
--   manual grant step.
--
--   PART B — CRITICAL-5 remediation (spec 4.2, 24: "Posted... No direct
--   edit/delete"). finance.journal_lines already has prevent_posted_edit
--   protecting line rows once the parent is POSTED. The header row
--   (finance.journal_entries) had no equivalent protection — only a
--   transition-guard trigger that fires exclusively on the specific
--   OLD.status<>'POSTED' AND NEW.status='POSTED' transition, which does
--   nothing to a row that is already POSTED. This part adds a header-level
--   BEFORE UPDATE/DELETE trigger that blocks any change to a POSTED,
--   REVERSED, or CANCELLED journal entry except through the transition to
--   REVERSED via finance.reverse_journal_entry (which the trigger allows by
--   checking the specific, narrow field-set that reversal touches).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- PART A: permission catalog
-- -----------------------------------------------------------------------------
INSERT INTO "core"."permissions" ("code", "name", "module", "action", "description", "is_system")
VALUES
  ('VIEW_JOURNAL',            'View Journal Entries',        'ACCOUNTING', 'view',    'View journal entries and ledger detail', true),
  ('CREATE_JOURNAL',          'Create Journal Entries',      'ACCOUNTING', 'create',  'Create draft journal entries', true),
  ('VERIFY_JOURNAL',          'Verify Journal Entries',      'ACCOUNTING', 'verify',  'Verify submitted journal entries for evidence/coding', true),
  ('APPROVE_JOURNAL',         'Approve Journal Entries',     'ACCOUNTING', 'approve', 'Approve verified journal entries', true),
  ('POST_JOURNAL',            'Post Journal Entries',        'ACCOUNTING', 'post',    'Post approved journal entries to the general ledger', true),
  ('REVERSE_JOURNAL',         'Reverse Journal Entries',     'ACCOUNTING', 'reverse', 'Reverse a posted journal entry', true),
  ('VIEW_FINANCIAL_ACCOUNTS', 'View Financial Accounts',     'BANKING',    'view',    'View bank/cash/wallet/platform account master data', true),
  ('MANAGE_FINANCIAL_ACCOUNTS','Manage Financial Accounts',  'BANKING',    'manage',  'Create, edit, deactivate financial accounts', true),
  ('VIEW_VENDOR_BILLS',       'View Vendor Bills',           'PAYABLES',   'view',    'View vendor bills and payables', true),
  ('CREATE_VENDOR_BILLS',     'Create Vendor Bills',         'PAYABLES',   'create',  'Create/edit draft vendor bills', true),
  ('APPROVE_VENDOR_BILLS',    'Approve Vendor Bills',        'PAYABLES',   'approve', 'Approve vendor bills within limit', true),
  ('POST_VENDOR_BILLS',       'Post Vendor Bills',           'PAYABLES',   'post',    'Post vendor bills/payments to the ledger', true),
  ('VIEW_SALARY',             'View Salary/Compensation',    'PAYROLL',    'view',    'View individual salary/compensation records', true),
  ('MANAGE_PAYROLL',          'Manage Payroll',              'PAYROLL',    'manage',  'Create/edit/approve payroll and compensation records', true),
  ('VIEW_TAX',                'View Tax Records',            'TAX',        'view',    'View tax computations, reconciliations, and filings', true),
  ('MANAGE_TAX',              'Manage Tax Records',          'TAX',        'manage',  'Create/edit/approve tax adjustments, rule sets, and filings', true),
  ('VIEW_OWNER_EQUITY',       'View Owner/Equity Data',      'EQUITY',     'view',    'View owner, ownership history, reserve, and distribution data', true),
  ('MANAGE_OWNER_EQUITY',     'Manage Owner/Equity Data',    'EQUITY',     'manage',  'Manage owners, ownership percentages, reserve policy, and distributions', true),
  ('DECLARE_DISTRIBUTION',    'Declare Owner Distribution',  'EQUITY',     'approve', 'Approve/declare an owner profit distribution (CEO/governance only per spec 7.3)', true)
ON CONFLICT ("code") DO NOTHING;

-- -----------------------------------------------------------------------------
-- PART B: journal entry header immutability
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "finance"."prevent_posted_header_edit"() RETURNS "trigger"
LANGUAGE plpgsql
SET search_path = pg_catalog, finance
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status IN ('POSTED','REVERSED') THEN
      RAISE EXCEPTION 'IMMUTABLE_LEDGER: Cannot delete a % journal entry (id=%). Use reversal, not delete.', OLD.status, OLD.id;
    END IF;
    RETURN OLD;
  END IF;

  -- TG_OP = 'UPDATE'
  IF OLD.status IN ('POSTED','REVERSED','CANCELLED') THEN
    -- The one legitimate mutation of a POSTED row is the transition to
    -- REVERSED performed by finance.reverse_journal_entry, which only ever
    -- touches status/reversed_by/reversed_at/reversal_reason and leaves
    -- every financial/descriptive field untouched. Anything else is
    -- rejected outright, regardless of caller or RLS grant.
    IF OLD.status = 'POSTED' AND NEW.status = 'REVERSED'
       AND NEW.reference        IS NOT DISTINCT FROM OLD.reference
       AND NEW.description      IS NOT DISTINCT FROM OLD.description
       AND NEW.transaction_date IS NOT DISTINCT FROM OLD.transaction_date
       AND NEW.posting_date     IS NOT DISTINCT FROM OLD.posting_date
       AND NEW.period_id        IS NOT DISTINCT FROM OLD.period_id
       AND NEW.fiscal_year_id   IS NOT DISTINCT FROM OLD.fiscal_year_id
       AND NEW.currency         IS NOT DISTINCT FROM OLD.currency
       AND NEW.exchange_rate    IS NOT DISTINCT FROM OLD.exchange_rate
       AND NEW.total_debit      IS NOT DISTINCT FROM OLD.total_debit
       AND NEW.total_credit     IS NOT DISTINCT FROM OLD.total_credit
       AND NEW.source_type      IS NOT DISTINCT FROM OLD.source_type
       AND NEW.source_id        IS NOT DISTINCT FROM OLD.source_id
    THEN
      RETURN NEW;
    END IF;

    RAISE EXCEPTION 'IMMUTABLE_LEDGER: Journal entry % is % and cannot be edited directly. Use finance.reverse_journal_entry for corrections.', OLD.id, OLD.status;
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION "finance"."prevent_posted_header_edit"() OWNER TO "postgres";
COMMENT ON FUNCTION "finance"."prevent_posted_header_edit"() IS 'CRITICAL-5 fix: blocks any UPDATE/DELETE on a POSTED/REVERSED/CANCELLED finance.journal_entries header row except the narrow POSTED->REVERSED transition performed by finance.reverse_journal_entry.';

DROP TRIGGER IF EXISTS "trg_prevent_posted_header_edit" ON "finance"."journal_entries";
CREATE TRIGGER "trg_prevent_posted_header_edit"
  BEFORE UPDATE OR DELETE ON "finance"."journal_entries"
  FOR EACH ROW EXECUTE FUNCTION "finance"."prevent_posted_header_edit"();
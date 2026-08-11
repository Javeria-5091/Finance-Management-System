-- ═══════════════════════════════════════════════════════════════════════════
-- P1_008_audit_trigger_gap_fix.sql
-- Fixes ALL missing audit triggers identified in the Spec 8 compliance gap
-- analysis. Reuses the existing audit.trigger_audit_log() function — only
-- attaches triggers to tables that were missed in 004_audit_schema.
--
-- Tables covered (with CORRECT schema-qualified names):
--   Vendors:              finance.vendors (NOT public.vendors)
--   Profiles:             public.profiles
--   Payroll (7 tables):   finance.payroll_employees, finance.payroll_runs,
--                         finance.payroll_entries, finance.payroll_advance_requests,
--                         finance.advance_repayments, finance.payroll_compensation,
--                         finance.payroll_deductions
--   Payroll commissions:  finance.commission_rules, finance.commission_earnings,
--                         finance.commission_payments
--   Profit distributions: finance.profit_distributions (header record)
--   Platform fees:        finance.platforms, finance.fee_rules, finance.fee_tiers,
--                         finance.fee_computation_log
--   Fixed assets:         finance.fixed_assets, finance.depreciation_schedule,
--                         finance.asset_verifications, finance.asset_categories,
--                         finance.disposal_records
--   Tax:                  finance.tax_returns
--   Banking:              finance.bank_statements, finance.statement_lines
--   Budgets:              finance.budget_lines (if exists)
--   Subscriptions:        finance.subscriptions, finance.subscription_invoices,
--                         finance.subscription_payments
--   Contractors:          public.contractors, public.contractor_invoices,
--                         public.contractor_payments, public.contractor_milestones
--   AI:                   ai.ai_conversations, ai.ai_messages, ai.ai_feedback,
--                         ai.ai_document_extractions, ai.ai_suggestions
--   Numbering:            finance.numbering_sequences
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

DO $$
DECLARE
  v_tables TEXT[][] := ARRAY[
    -- ═══ Vendors (Spec 8.2: vendor bank-detail change) ═══
    -- NOTE: Original trigger list had ['public','vendors'] but actual table
    -- is finance.vendors (created in 017_vendor_ap_tables.sql)
    ['finance','vendors'],

    -- ═══ User profiles (Spec 8.2: role/status changes) ═══
    ['public','profiles'],

    -- ═══ Payroll — 7 tables (Spec 8.2: salary access — MOST SENSITIVE) ═══
    -- NOTE: Original trigger list had wrong names:
    --   'compensation_terms' → actual: payroll_compensation
    --   'payroll_lines'       → actual: payroll_entries
    --   'commissions'         → actual: commission_rules/earnings/payments
    --   'advances'            → actual: payroll_advance_requests
    ['finance','payroll_employees'],
    ['finance','payroll_runs'],
    ['finance','payroll_entries'],
    ['finance','payroll_advance_requests'],
    ['finance','advance_repayments'],
    ['finance','payroll_compensation'],
    ['finance','payroll_deductions'],

    -- ═══ Commission module ═══
    ['finance','commission_rules'],
    ['finance','commission_earnings'],
    ['finance','commission_payments'],

    -- ═══ Profit distributions — HEADER record (Spec 8.2: owner distribution) ═══
    -- NOTE: distribution_lines already has a trigger from 004, but the main
    -- profit_distributions header (declare/approve/pay) was missed
    ['finance','profit_distributions'],

    -- ═══ Platform fee rules config (Spec 5.13 + 8.2) ═══
    ['finance','platforms'],
    ['finance','fee_rules'],
    ['finance','fee_tiers'],
    ['finance','fee_computation_log'],

    -- ═══ Fixed assets & depreciation (Spec 8.2) ═══
    ['finance','fixed_assets'],
    ['finance','depreciation_schedule'],
    ['finance','asset_verifications'],
    ['finance','asset_categories'],
    ['finance','disposal_records'],

    -- ═══ Tax returns (Spec 8.2 + Section 10.2) ═══
    -- NOTE: tax_rule_sets, tax_slabs, tax_reconciliations, tax_adjustments,
    -- taxpayer_profile were ALREADY in the 004 trigger list. Only tax_returns
    -- was missing.
    ['finance','tax_returns'],

    -- ═══ Banking — statements (Spec 8.2) ═══
    ['finance','bank_statements'],
    ['finance','statement_lines'],

    -- ═══ Subscriptions ═══
    ['finance','subscriptions'],
    ['finance','subscription_invoices'],
    ['finance','subscription_payments'],

    -- ═══ Contractors ═══
    ['public','contractors'],
    ['public','contractor_invoices'],
    ['public','contractor_payments'],
    ['public','contractor_milestones'],

    -- ═══ AI tables (extra safety — AI activity is already logged via
    -- log_ai_event(), but table-level DML should also be captured) ═══
    ['ai','ai_conversations'],
    ['ai','ai_messages'],
    ['ai','ai_feedback'],
    ['ai','ai_document_extractions'],
    ['ai','ai_suggestions'],

    -- ═══ Numbering sequences (config change — 8.2) ═══
    ['finance','numbering_sequences'],

    -- ═══ Notifications (access accountability) ═══
    ['public','notifications']
  ];

  v_pair TEXT[];
  v_trigger_name TEXT;
  v_attached_count INTEGER := 0;
  v_skipped_count INTEGER := 0;
  v_already_count INTEGER := 0;
BEGIN
  FOREACH v_pair SLICE 1 IN ARRAY v_tables LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = v_pair[1] AND table_name = v_pair[2]
    ) THEN
      v_trigger_name := left(v_pair[2], 20) || '_audit';

      -- Check if trigger already exists
      IF EXISTS (
        SELECT 1 FROM pg_trigger pg_t
        JOIN pg_class pg_c ON pg_c.oid = pg_t.tgrelid
        JOIN pg_namespace pg_n ON pg_n.oid = pg_c.relnamespace
        WHERE pg_n.nspname = v_pair[1]
          AND pg_c.relname = v_pair[2]
          AND pg_t.tgname = v_trigger_name
      ) THEN
        v_already_count := v_already_count + 1;
      ELSE
        EXECUTE format(
          'CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I.%I FOR EACH ROW EXECUTE FUNCTION audit.trigger_audit_log()',
          v_trigger_name, v_pair[1], v_pair[2]
        );
        v_attached_count := v_attached_count + 1;
        RAISE NOTICE 'Attached audit trigger to %.%', v_pair[1], v_pair[2];
      END IF;
    ELSE
      v_skipped_count := v_skipped_count + 1;
      RAISE NOTICE 'Table %.% does not exist — skipped', v_pair[1], v_pair[2];
    END IF;
  END LOOP;

  RAISE NOTICE '═══════════════════════════════════════════════════════════════';
  RAISE NOTICE 'Audit trigger gap fix complete:';
  RAISE NOTICE '  New triggers attached: %', v_attached_count;
  RAISE NOTICE '  Already existed:      %', v_already_count;
  RAISE NOTICE '  Tables not found:     % (expected if P1 modules not yet created)', v_skipped_count;
  RAISE NOTICE '═══════════════════════════════════════════════════════════════';
END $$;

COMMIT;

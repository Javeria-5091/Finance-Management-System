-- =====================================================================
-- OSYSTIC Finance Management System
-- DATABASE-LAYER AUDIT FIX SCRIPT -- PART 2
-- Generated against your UPDATED schema.sql (post part-1 migration)
-- Reference: BUG-024 (LOW) from the original audit report
-- =====================================================================
--
-- WHAT HAPPENED
-- --------------
-- The part-1 fix script validated 34 of the 48 "NOT VALID" check
-- constraints automatically. The remaining 14 stayed NOT VALID because
-- they genuinely have EXISTING ROWS that violate them -- i.e. real data
-- problems, not a scripting issue:
--
--   * 12x "<table>_org_required_going_forward" -> some rows still have
--     organization_id = NULL on: accounting_periods, asset_categories,
--     asset_verifications, fee_rules, fiscal_years, fixed_assets,
--     numbering_sequences, platforms, tax_rule_sets, taxpayer_profile,
--     vendor_payments, vendors.
--   * invoices_status_check -> some invoices.status values aren't in
--     the allowed list (DRAFT/PENDING_APPROVAL/ISSUED/PARTIALLY_PAID/
--     PAID/OVERDUE/VOID/CREDITED/REFUNDED).
--   * invoices_journal_entry_id_fkey -> some invoices.journal_entry_id
--     values point to a journal_entries row that no longer exists.
--
-- WHAT THIS SCRIPT DOES
-- ----------------------
-- 1. For the 12 organization_id gaps: backfills organization_id using
--    the SAFEST available signal first (a related row that already
--    has an organization_id -- e.g. vendor_payments -> vendors,
--    accounting_periods -> fiscal_years), and only falls back to
--    "assign to the single existing organization" when there is
--    EXACTLY ONE organization in core.organizations (safe for a
--    single-tenant / pilot deployment). If multiple organizations
--    exist and a row can't be traced to one, it is left alone and
--    reported via NOTICE so you can assign it manually -- this script
--    will never guess an organization for ambiguous multi-tenant data.
-- 2. For invoices_status_check: this is DIAGNOSTIC ONLY. Financial
--    document statuses are too consequential to silently rewrite, so
--    this script reports exactly which invoices and status values are
--    offending and lets you decide the correct mapping.
-- 3. For invoices_journal_entry_id_fkey: nulls out only the orphaned
--    journal_entry_id references (i.e. pointers to a journal entry
--    that was deleted) -- safe, since the column is nullable and the
--    original FK is itself declared ON DELETE SET NULL, so this just
--    catches up rows that predate that policy.
-- 4. Re-validates every constraint it touches, and gives you a final
--    pass/fail summary.
--
-- This script is IDEMPOTENT and safe to re-run.
-- =====================================================================


-- =====================================================================
-- STEP 1 — Backfill organization_id via related records (parent tables
--          first, so children can inherit from a freshly-filled parent)
-- =====================================================================

-- 1a. finance.fiscal_years — no org-scoped parent to infer from.
UPDATE finance.fiscal_years fy
SET organization_id = o.id
FROM (SELECT id FROM core.organizations LIMIT 1) o
WHERE fy.organization_id IS NULL
  AND (SELECT COUNT(*) FROM core.organizations) = 1;

-- 1b. finance.vendors — no org-scoped parent to infer from.
UPDATE finance.vendors v
SET organization_id = o.id
FROM (SELECT id FROM core.organizations LIMIT 1) o
WHERE v.organization_id IS NULL
  AND (SELECT COUNT(*) FROM core.organizations) = 1;

-- 1c. finance.asset_categories — no org-scoped parent to infer from.
UPDATE finance.asset_categories ac
SET organization_id = o.id
FROM (SELECT id FROM core.organizations LIMIT 1) o
WHERE ac.organization_id IS NULL
  AND (SELECT COUNT(*) FROM core.organizations) = 1;

-- 1d. finance.platforms — no org-scoped parent to infer from.
UPDATE finance.platforms p
SET organization_id = o.id
FROM (SELECT id FROM core.organizations LIMIT 1) o
WHERE p.organization_id IS NULL
  AND (SELECT COUNT(*) FROM core.organizations) = 1;

-- 1e. finance.tax_rule_sets — no org-scoped parent to infer from.
UPDATE finance.tax_rule_sets trs
SET organization_id = o.id
FROM (SELECT id FROM core.organizations LIMIT 1) o
WHERE trs.organization_id IS NULL
  AND (SELECT COUNT(*) FROM core.organizations) = 1;

-- 1f. finance.taxpayer_profile — no org-scoped parent to infer from.
UPDATE finance.taxpayer_profile tp
SET organization_id = o.id
FROM (SELECT id FROM core.organizations LIMIT 1) o
WHERE tp.organization_id IS NULL
  AND (SELECT COUNT(*) FROM core.organizations) = 1;

-- 1g. finance.accounting_periods — backfill from its fiscal year first
--     (real relationship), then fall back to the single-org rule.
UPDATE finance.accounting_periods ap
SET organization_id = fy.organization_id
FROM finance.fiscal_years fy
WHERE ap.organization_id IS NULL
  AND ap.fiscal_year_id = fy.id
  AND fy.organization_id IS NOT NULL;

UPDATE finance.accounting_periods ap
SET organization_id = o.id
FROM (SELECT id FROM core.organizations LIMIT 1) o
WHERE ap.organization_id IS NULL
  AND (SELECT COUNT(*) FROM core.organizations) = 1;

-- 1h. finance.numbering_sequences — backfill from its fiscal year
--     (nullable relationship), then single-org fallback.
UPDATE finance.numbering_sequences ns
SET organization_id = fy.organization_id
FROM finance.fiscal_years fy
WHERE ns.organization_id IS NULL
  AND ns.fiscal_year_id = fy.id
  AND fy.organization_id IS NOT NULL;

UPDATE finance.numbering_sequences ns
SET organization_id = o.id
FROM (SELECT id FROM core.organizations LIMIT 1) o
WHERE ns.organization_id IS NULL
  AND (SELECT COUNT(*) FROM core.organizations) = 1;

-- 1i. finance.vendor_payments — backfill from the vendor (real
--     relationship), then single-org fallback.
UPDATE finance.vendor_payments vp
SET organization_id = v.organization_id
FROM finance.vendors v
WHERE vp.organization_id IS NULL
  AND vp.vendor_id = v.id
  AND v.organization_id IS NOT NULL;

UPDATE finance.vendor_payments vp
SET organization_id = o.id
FROM (SELECT id FROM core.organizations LIMIT 1) o
WHERE vp.organization_id IS NULL
  AND (SELECT COUNT(*) FROM core.organizations) = 1;

-- 1j. finance.fee_rules — backfill from its platform, then single-org.
UPDATE finance.fee_rules fr
SET organization_id = p.organization_id
FROM finance.platforms p
WHERE fr.organization_id IS NULL
  AND fr.platform_id = p.id
  AND p.organization_id IS NOT NULL;

UPDATE finance.fee_rules fr
SET organization_id = o.id
FROM (SELECT id FROM core.organizations LIMIT 1) o
WHERE fr.organization_id IS NULL
  AND (SELECT COUNT(*) FROM core.organizations) = 1;

-- 1k. finance.fixed_assets — backfill from its asset category, or
--     from its vendor if the category has no org, then single-org.
UPDATE finance.fixed_assets fa
SET organization_id = ac.organization_id
FROM finance.asset_categories ac
WHERE fa.organization_id IS NULL
  AND fa.category_id = ac.id
  AND ac.organization_id IS NOT NULL;

UPDATE finance.fixed_assets fa
SET organization_id = v.organization_id
FROM finance.vendors v
WHERE fa.organization_id IS NULL
  AND fa.vendor_id = v.id
  AND v.organization_id IS NOT NULL;

UPDATE finance.fixed_assets fa
SET organization_id = o.id
FROM (SELECT id FROM core.organizations LIMIT 1) o
WHERE fa.organization_id IS NULL
  AND (SELECT COUNT(*) FROM core.organizations) = 1;

-- 1l. finance.asset_verifications — backfill via its verification
--     lines -> the fixed asset they verified, then single-org.
UPDATE finance.asset_verifications av
SET organization_id = fa.organization_id
FROM finance.asset_verification_lines avl
JOIN finance.fixed_assets fa ON fa.id = avl.asset_id
WHERE av.organization_id IS NULL
  AND avl.verification_id = av.id
  AND fa.organization_id IS NOT NULL;

UPDATE finance.asset_verifications av
SET organization_id = o.id
FROM (SELECT id FROM core.organizations LIMIT 1) o
WHERE av.organization_id IS NULL
  AND (SELECT COUNT(*) FROM core.organizations) = 1;


-- =====================================================================
-- STEP 2 — Report any rows STILL missing organization_id (only
--          possible if you have more than one organization and the
--          row can't be traced to one -- these need a manual decision)
-- =====================================================================

DO $$
DECLARE
    v_org_count INTEGER;
    r RECORD;
    v_cnt INTEGER;
BEGIN
    SELECT COUNT(*) INTO v_org_count FROM core.organizations;

    IF v_org_count > 1 THEN
        RAISE NOTICE '--- Multiple organizations (%) exist. Checking for rows that still could not be traced to one: ---', v_org_count;

        FOR r IN
            SELECT unnest(ARRAY[
                'finance.accounting_periods','finance.asset_categories',
                'finance.asset_verifications','finance.fee_rules',
                'finance.fiscal_years','finance.fixed_assets',
                'finance.numbering_sequences','finance.platforms',
                'finance.tax_rule_sets','finance.taxpayer_profile',
                'finance.vendor_payments','finance.vendors'
            ]) AS tbl
        LOOP
            EXECUTE format('SELECT COUNT(*) FROM %s WHERE organization_id IS NULL', r.tbl) INTO v_cnt;
            IF v_cnt > 0 THEN
                RAISE NOTICE '  % still has % row(s) with NULL organization_id -- please assign these manually (e.g. UPDATE %s SET organization_id = ... WHERE organization_id IS NULL).', r.tbl, v_cnt, r.tbl;
            END IF;
        END LOOP;
    END IF;
END $$;


-- =====================================================================
-- STEP 3 — Diagnose invoices_status_check (no automatic data change --
--          financial document status is too consequential to guess)
-- =====================================================================

DO $$
DECLARE
    r RECORD;
    v_any BOOLEAN := false;
BEGIN
    FOR r IN
        SELECT status, COUNT(*) AS cnt
        FROM public.invoices
        WHERE status IS NULL
           OR status::text NOT IN (
                'DRAFT','PENDING_APPROVAL','ISSUED','PARTIALLY_PAID',
                'PAID','OVERDUE','VOID','CREDITED','REFUNDED'
           )
        GROUP BY status
    LOOP
        v_any := true;
        RAISE NOTICE 'invoices_status_check: % invoice(s) have invalid status = %. Decide the correct mapping and run: UPDATE public.invoices SET status = ''<CORRECT_VALUE>'' WHERE status %s;',
            r.cnt,
            COALESCE(r.status, 'NULL'),
            CASE WHEN r.status IS NULL THEN 'IS NULL' ELSE '= ' || quote_literal(r.status) END;
    END LOOP;

    IF NOT v_any THEN
        RAISE NOTICE 'invoices_status_check: no invalid status values found -- safe to validate.';
    END IF;
END $$;


-- =====================================================================
-- STEP 4 — Fix invoices_journal_entry_id_fkey (safe: null out only
--          orphaned references to a deleted journal entry)
-- =====================================================================

DO $$
DECLARE
    v_orphans INTEGER;
BEGIN
    SELECT COUNT(*) INTO v_orphans
    FROM public.invoices i
    WHERE i.journal_entry_id IS NOT NULL
      AND NOT EXISTS (
          SELECT 1 FROM finance.journal_entries je WHERE je.id = i.journal_entry_id
      );

    IF v_orphans > 0 THEN
        RAISE NOTICE 'invoices_journal_entry_id_fkey: clearing % orphaned journal_entry_id reference(s) (pointing to a deleted journal entry).', v_orphans;

        UPDATE public.invoices i
        SET journal_entry_id = NULL
        WHERE i.journal_entry_id IS NOT NULL
          AND NOT EXISTS (
              SELECT 1 FROM finance.journal_entries je WHERE je.id = i.journal_entry_id
          );
    ELSE
        RAISE NOTICE 'invoices_journal_entry_id_fkey: no orphaned references found.';
    END IF;
END $$;


-- =====================================================================
-- STEP 5 — Re-attempt VALIDATE CONSTRAINT on all remaining NOT VALID
--          check/foreign-key constraints. Each is validated in its own
--          savepoint so one still-bad table doesn't block the rest.
-- =====================================================================

DO $$
DECLARE
    r RECORD;
    v_ok_count INTEGER := 0;
    v_failed_count INTEGER := 0;
BEGIN
    FOR r IN
        SELECT
            n.nspname AS schema_name,
            t.relname AS table_name,
            c.conname AS constraint_name
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE c.contype IN ('c', 'f')
          AND c.convalidated = false
          AND n.nspname IN ('finance', 'core', 'public', 'audit', 'reporting')
        ORDER BY n.nspname, t.relname, c.conname
    LOOP
        BEGIN
            EXECUTE format(
                'ALTER TABLE %I.%I VALIDATE CONSTRAINT %I',
                r.schema_name, r.table_name, r.constraint_name
            );
            v_ok_count := v_ok_count + 1;
        EXCEPTION
            WHEN check_violation OR foreign_key_violation OR not_null_violation THEN
                v_failed_count := v_failed_count + 1;
                RAISE NOTICE 'Still could NOT validate %.%.% -- rows still violate it. Investigate and clean up the data, then run: ALTER TABLE %.% VALIDATE CONSTRAINT %;',
                    r.schema_name, r.table_name, r.constraint_name,
                    r.schema_name, r.table_name, r.constraint_name;
        END;
    END LOOP;

    RAISE NOTICE 'PART 2 SUMMARY: validated % constraint(s); % still need manual data cleanup.',
        v_ok_count, v_failed_count;
END $$;

-- =====================================================================
-- After this runs, check the NOTICEs above (Supabase SQL Editor shows
-- them in the "Results"/"Messages" panel). Anything still flagged
-- needs a one-off manual decision (which organization a legacy row
-- belongs to, or what the correct invoice status should be) -- that's
-- a business decision this script deliberately won't make for you.
-- =====================================================================
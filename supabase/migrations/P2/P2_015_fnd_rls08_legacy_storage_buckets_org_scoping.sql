-- =====================================================================
-- Finance Management System — Critical Fix
--   FND-RLS-08 (P1): legacy storage buckets (receipts, invoices,
--   bank-statements, contracts — supabase/migrations/P0/phase_1_foundation/
--   006_storage_buckets_policies.sql) enforce access with role checks
--   only, never binding the check to the caller's own organization:
--     - invoices_read / statements_read / contracts_read: core.is_finance_head()
--       lets a Finance Head/CEO of ANY org read ANY org's objects.
--     - receipts_read: core.is_ceo_or_admin() has the same problem.
--     - invoices_upload / contracts_upload: any authenticated user at all,
--       no role or org check, so anyone can write into either bucket.
--
-- Fix, mirroring the correctly-scoped finance-attachments bucket added in
-- P2_002: bind every policy to the caller's own organization. Since these
-- legacy buckets have no metadata table mapping storage_path ->
-- organization_id (unlike finance.attachments), organization scoping is
-- enforced via the object's folder path instead:
--   - invoices / bank-statements / contracts: object path must start with
--     the caller's own organization_id (as the first path segment), for
--     both upload (WITH CHECK) and read (USING). No app code in this
--     repository currently references these three buckets, so this is a
--     forward-looking path convention, not a break of live uploads.
--   - receipts: keeps its existing {user_id}/... path convention (used by
--     the still-correct receipts_upload/receipts_delete policies) and,
--     for the CEO/admin cross-user branch, looks up the uploader's
--     organization_id via public.profiles instead of introducing a path
--     change.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- RECEIPTS: fix the CEO/admin cross-org read branch. The
-- self-access branch ((storage.foldername(name))[1] = auth.uid()::text)
-- was already correct and is unchanged, as are receipts_upload/receipts_delete.
-- ---------------------------------------------------------------------

DROP POLICY IF EXISTS "receipts_read" ON storage.objects;

CREATE POLICY "receipts_read" ON storage.objects
    FOR SELECT USING (
        bucket_id = 'receipts'
        AND (
            (storage.foldername(name))[1] = auth.uid()::TEXT
            OR (
                core.is_ceo_or_admin()
                AND EXISTS (
                    SELECT 1 FROM public.profiles p
                    WHERE p.user_id::text = (storage.foldername(name))[1]
                      AND core.same_org(p.organization_id)
                )
            )
        )
    );

-- ---------------------------------------------------------------------
-- INVOICES: org-scope both upload and read via a {organization_id}/...
-- path convention.
-- ---------------------------------------------------------------------

DROP POLICY IF EXISTS "invoices_upload" ON storage.objects;

CREATE POLICY "invoices_upload" ON storage.objects
    FOR INSERT WITH CHECK (
        bucket_id = 'invoices'
        AND auth.uid() IS NOT NULL
        AND core.current_user_org_id() IS NOT NULL
        AND (storage.foldername(name))[1] = core.current_user_org_id()::TEXT
    );

DROP POLICY IF EXISTS "invoices_read" ON storage.objects;

CREATE POLICY "invoices_read" ON storage.objects
    FOR SELECT USING (
        bucket_id = 'invoices'
        AND core.is_finance_head()
        AND (storage.foldername(name))[1] = core.current_user_org_id()::TEXT
    );

-- ---------------------------------------------------------------------
-- BANK STATEMENTS: statements_upload already required is_finance_head(),
-- but with no org scoping either; add the same path convention to both
-- policies so an upload under one org's folder is never readable (or,
-- previously, overwritable) from another org.
-- ---------------------------------------------------------------------

DROP POLICY IF EXISTS "statements_upload" ON storage.objects;

CREATE POLICY "statements_upload" ON storage.objects
    FOR INSERT WITH CHECK (
        bucket_id = 'bank-statements'
        AND core.is_finance_head()
        AND core.current_user_org_id() IS NOT NULL
        AND (storage.foldername(name))[1] = core.current_user_org_id()::TEXT
    );

DROP POLICY IF EXISTS "statements_read" ON storage.objects;

CREATE POLICY "statements_read" ON storage.objects
    FOR SELECT USING (
        bucket_id = 'bank-statements'
        AND core.is_finance_head()
        AND (storage.foldername(name))[1] = core.current_user_org_id()::TEXT
    );

-- ---------------------------------------------------------------------
-- CONTRACTS: same treatment as invoices.
-- ---------------------------------------------------------------------

DROP POLICY IF EXISTS "contracts_upload" ON storage.objects;

CREATE POLICY "contracts_upload" ON storage.objects
    FOR INSERT WITH CHECK (
        bucket_id = 'contracts'
        AND auth.uid() IS NOT NULL
        AND core.current_user_org_id() IS NOT NULL
        AND (storage.foldername(name))[1] = core.current_user_org_id()::TEXT
    );

DROP POLICY IF EXISTS "contracts_read" ON storage.objects;

CREATE POLICY "contracts_read" ON storage.objects
    FOR SELECT USING (
        bucket_id = 'contracts'
        AND core.is_finance_head()
        AND (storage.foldername(name))[1] = core.current_user_org_id()::TEXT
    );

COMMIT;

-- ---------------------------------------------------------------------
-- App-side note: since invoices/bank-statements/contracts now require the
-- first path segment to equal the uploader's organization_id, any future
-- code that uploads into these buckets must build paths as
-- `${organizationId}/${filename}` (exactly the same convention 'receipts'
-- already uses with the user's id). No code in this repository currently
-- uploads to these three buckets; if that changes, build the path
-- accordingly rather than passing a bare filename.
--
-- Verification:
--   1) As a Finance Head of Org A, try to read an object whose path
--      starts with Org B's organization_id (e.g. via a signed URL or
--      direct storage.objects query) -- now denied.
--   2) As a plain EMPLOYEE (not Finance Head), try to upload to
--      'invoices' or 'contracts' -- still allowed (upload only checks
--      auth.uid() + org-scoped path, matching the original "any
--      authenticated user" intent for upload), but only under their own
--      org's folder; uploading under a different org's folder is denied.
--   3) As a Finance Head of Org A, upload to 'invoices' under Org A's
--      folder, then read it back -- still works.
--   4) As a CEO/admin of Org A, read a receipt uploaded by another user
--      who is also in Org A -- still works. Read a receipt uploaded by a
--      user in Org B -- now denied.
-- ---------------------------------------------------------------------
-- ==========================================
-- C-06 FIX (Critical): finance-attachments bucket has no
-- creation/policy definition anywhere, so every upload via
-- src/app/api/finance/attachment/route.ts fails once the bucket
-- doesn't already exist, and would otherwise have zero access
-- control. Mirrors the pattern of 006_storage_buckets_policies.sql
-- for the other buckets, and additionally scopes SELECT/DELETE to
-- the caller's own organization via finance.attachments, since a
-- financial attachment is more sensitive than a receipt photo.
-- ==========================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'finance-attachments',
    'finance-attachments',
    false, -- PRIVATE
    10485760, -- 10MB, matches C-06 recommendation
    ARRAY['application/pdf', 'image/jpeg', 'image/png']
) ON CONFLICT (id) DO NOTHING;

-- Upload: any authenticated Finance Head / Accountant / CEO can initiate an
-- upload (matches the existing 'invoices_upload' / 'contracts_upload' style,
-- since the finance.attachments row that records the org isn't written
-- until after the signed upload URL is issued).
CREATE POLICY "finance_attachments_upload" ON storage.objects
    FOR INSERT WITH CHECK (
        bucket_id = 'finance-attachments'
        AND auth.uid() IS NOT NULL
        AND (core.is_finance_head() OR core.has_role('ACCOUNTANT'))
    );

-- Read: only within the caller's own organization, verified against the
-- finance.attachments row created for this storage_path.
CREATE POLICY "finance_attachments_read" ON storage.objects
    FOR SELECT USING (
        bucket_id = 'finance-attachments'
        AND EXISTS (
            SELECT 1 FROM finance.attachments a
            WHERE a.storage_path = storage.objects.name
              AND core.same_org(a.organization_id)
        )
    );

-- Delete: same organization scoping as read, restricted to Finance Head/CEO.
CREATE POLICY "finance_attachments_delete" ON storage.objects
    FOR DELETE USING (
        bucket_id = 'finance-attachments'
        AND core.is_finance_head()
        AND EXISTS (
            SELECT 1 FROM finance.attachments a
            WHERE a.storage_path = storage.objects.name
              AND core.same_org(a.organization_id)
        )
    );

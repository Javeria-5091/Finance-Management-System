-- ==========================================
-- PHASE 1 - STEP 1.6 (BONUS): Storage Buckets
-- Private buckets for receipts, invoices, etc.
-- ==========================================

-- Create buckets (run in Supabase SQL editor or via CLI)
-- Note: Bucket creation might need specific permissions

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types) 
VALUES (
    'receipts', 
    'receipts', 
    false,  -- PRIVATE
    5242880,  -- 5MB
    ARRAY['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
) ON CONFLICT (id) DO NOTHING;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types) 
VALUES (
    'invoices', 
    'invoices', 
    false,  -- PRIVATE
    10485760,  -- 10MB
    ARRAY['application/pdf', 'image/jpeg', 'image/png']
) ON CONFLICT (id) DO NOTHING;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types) 
VALUES (
    'bank-statements', 
    'bank-statements', 
    false,  -- PRIVATE
    52428800,  -- 50MB (CSV can be large)
    ARRAY['text/csv', 'application/pdf', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']
) ON CONFLICT (id) DO NOTHING;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types) 
VALUES (
    'contracts', 
    'contracts', 
    false,  -- PRIVATE
    10485760,  -- 10MB
    ARRAY['application/pdf', 'image/jpeg', 'image/png', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']
) ON CONFLICT (id) DO NOTHING;

-- ==========================================
-- STORAGE POLICIES
-- ==========================================

-- RECEIPTS bucket policies
CREATE POLICY "receipts_upload" ON storage.objects
    FOR INSERT WITH CHECK (
        bucket_id = 'receipts' 
        AND auth.uid() IS NOT NULL
        AND (storage.foldername(name))[1] = auth.uid()::TEXT  -- Organize by user
    );

CREATE POLICY "receipts_read" ON storage.objects
    FOR SELECT USING (
        bucket_id = 'receipts' 
        AND (
            (storage.foldername(name))[1] = auth.uid()::TEXT
            OR core.is_ceo_or_admin()
        )
    );

CREATE POLICY "receipts_delete" ON storage.objects
    FOR DELETE USING (
        bucket_id = 'receipts' 
        AND (storage.foldername(name))[1] = auth.uid()::TEXT
    );

-- INVOICES bucket policies (accountants and admins can access)
CREATE POLICY "invoices_upload" ON storage.objects
    FOR INSERT WITH CHECK (
        bucket_id = 'invoices' 
        AND auth.uid() IS NOT NULL
    );

CREATE POLICY "invoices_read" ON storage.objects
    FOR SELECT USING (
        bucket_id = 'invoices' 
        AND core.is_finance_head()
    );

-- BANK STATEMENTS bucket policies (finance only)
CREATE POLICY "statements_upload" ON storage.objects
    FOR INSERT WITH CHECK (
        bucket_id = 'bank-statements' 
        AND core.is_finance_head()
    );

CREATE POLICY "statements_read" ON storage.objects
    FOR SELECT USING (
        bucket_id = 'bank-statements' 
        AND core.is_finance_head()
    );

-- CONTRACTS bucket policies
CREATE POLICY "contracts_upload" ON storage.objects
    FOR INSERT WITH CHECK (
        bucket_id = 'contracts' 
        AND auth.uid() IS NOT NULL
    );

CREATE POLICY "contracts_read" ON storage.objects
    FOR SELECT USING (
        bucket_id = 'contracts' 
        AND core.is_finance_head()
    );
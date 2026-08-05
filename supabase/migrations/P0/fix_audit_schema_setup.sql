-- migrations/fix_audit_schema_final.sql

-- ✅ STEP 1: Drop EVERYTHING related to audit first (clean slate)
DROP TABLE IF EXISTS audit.audit_log CASCADE;
DROP VIEW IF EXISTS public.v_audit_log CASCADE;
DROP FUNCTION IF EXISTS audit.has_audit_permission(UUID) CASCADE;
DROP FUNCTION IF EXISTS audit.log_action CASCADE;
DROP INDEX IF EXISTS audit.idx_audit_log_created_at CASCADE;
DROP INDEX IF EXISTS audit.idx_audit_log_user_id CASCADE;
DROP INDEX IF EXISTS audit.idx_audit_log_action CASCADE;
DROP INDEX IF EXISTS audit.idx_audit_log_entity CASCADE;
DROP INDEX IF EXISTS audit.idx_audit_log_status CASCADE;

-- ✅ STEP 2: Drop old public schema audit stuff
DROP TABLE IF EXISTS public.audit_logs CASCADE;
DROP TABLE IF EXISTS public.audit_log CASCADE;
DROP FUNCTION IF EXISTS public.has_audit_permission(UUID) CASCADE;
DROP FUNCTION IF EXISTS public.log_audit_action() CASCADE;
DROP VIEW IF EXISTS public.v_audit_log CASCADE;

-- ✅ STEP 3: Create audit schema if not exists
CREATE SCHEMA IF NOT EXISTS audit;

-- ✅ STEP 4: Create the table FRESH (no IF NOT EXISTS - we dropped it above)
CREATE TABLE audit.audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID,
  user_email TEXT,
  user_name TEXT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id UUID,
  description TEXT,
  old_values JSONB,
  new_values JSONB,
  ip_address INET,
  user_agent TEXT,
  status TEXT DEFAULT 'success' CHECK (status IN ('success', 'denied', 'error')),
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ✅ STEP 5: Create indexes
CREATE INDEX idx_audit_log_created_at ON audit.audit_log(created_at DESC);
CREATE INDEX idx_audit_log_user_id ON audit.audit_log(user_id);
CREATE INDEX idx_audit_log_action ON audit.audit_log(action);
CREATE INDEX idx_audit_log_entity ON audit.audit_log(entity_type, entity_id);
CREATE INDEX idx_audit_log_status ON audit.audit_log(status);

-- ✅ STEP 6: Enable RLS
ALTER TABLE audit.audit_log ENABLE ROW LEVEL SECURITY;

-- ✅ STEP 7: Create permission helper function
CREATE OR REPLACE FUNCTION audit.has_audit_permission(p_user_id UUID)
RETURNS BOOLEAN AS $$ DECLARE
  v_role TEXT;
BEGIN
  -- Get user's active role from user_roles
  SELECT ur.role INTO v_role
  FROM public.user_roles ur
  WHERE ur.user_id = p_user_id
    AND ur.is_active = true
    AND ur.effective_from <= NOW()
    AND (ur.effective_to IS NULL OR ur.effective_to >= NOW())
  ORDER BY ur.effective_from DESC
  LIMIT 1;
  
  -- Fallback to profiles if not found
  IF v_role IS NULL THEN
    SELECT p.role INTO v_role
    FROM public.profiles p
    WHERE p.id = p_user_id;
  END IF;
  
  -- CEO, FINANCE_HEAD, and ACCOUNTANT can view audit logs
  RETURN v_role IN ('CEO', 'FINANCE_HEAD', 'ACCOUNTANT');
END;
 $$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

-- ✅ STEP 8: RLS Policies

-- Read: users with permission can see ALL logs
CREATE POLICY "audit_log_select_permitted" ON audit.audit_log
  FOR SELECT
  TO authenticated
  USING (audit.has_audit_permission(auth.uid()));

-- Insert: users can insert their own logs
CREATE POLICY "audit_log_insert" ON audit.audit_log
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

-- No updates
CREATE POLICY "audit_log_no_update" ON audit.audit_log
  FOR UPDATE
  TO authenticated
  USING (false);

-- No deletes
CREATE POLICY "audit_log_no_delete" ON audit.audit_log
  FOR DELETE
  TO authenticated
  USING (false);

-- Service role full access
CREATE POLICY "audit_log_service_all" ON audit.audit_log
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ✅ STEP 9: Grant permissions
GRANT USAGE ON SCHEMA audit TO authenticated;
GRANT SELECT, INSERT ON audit.audit_log TO authenticated;
REVOKE UPDATE, DELETE ON audit.audit_log FROM authenticated;
GRANT ALL ON audit.audit_log TO service_role;

-- ✅ STEP 10: Create public view for app access
CREATE VIEW public.v_audit_log AS
SELECT 
  id,
  user_id,
  user_email,
  user_name,
  action,
  entity_type,
  entity_id,
  description,
  old_values,
  new_values,
  ip_address::TEXT AS ip_address,
  user_agent,
  status,
  error_message,
  created_at
FROM audit.audit_log;

GRANT SELECT, INSERT ON public.v_audit_log TO authenticated;

-- ✅ STEP 11: Server-side logging function
CREATE OR REPLACE FUNCTION audit.log_action(
  p_user_id UUID,
  p_user_email TEXT,
  p_user_name TEXT,
  p_action TEXT,
  p_entity_type TEXT,
  p_entity_id UUID DEFAULT NULL,
  p_description TEXT DEFAULT '',
  p_old_values JSONB DEFAULT NULL,
  p_new_values JSONB DEFAULT NULL,
  p_ip_address INET DEFAULT NULL,
  p_user_agent TEXT DEFAULT NULL,
  p_status TEXT DEFAULT 'success',
  p_error_message TEXT DEFAULT NULL
)
RETURNS UUID AS $$ DECLARE
  v_id UUID;
BEGIN
  INSERT INTO audit.audit_log (
    user_id, user_email, user_name, action, entity_type, entity_id,
    description, old_values, new_values, ip_address, user_agent,
    status, error_message
  ) VALUES (
    p_user_id, p_user_email, p_user_name, p_action, p_entity_type, p_entity_id,
    p_description, p_old_values, p_new_values, p_ip_address, p_user_agent,
    p_status, p_error_message
  )
  RETURNING id INTO v_id;
  
  RETURN v_id;
END;
 $$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION audit.log_action TO authenticated;

-- ✅ STEP 12: Verify table structure
DO $$ BEGIN
  RAISE NOTICE '✅ audit.audit_log table created successfully';
  RAISE NOTICE 'Columns: %', (
    SELECT string_agg(column_name, ', ' ORDER BY ordinal_position)
    FROM information_schema.columns
    WHERE table_schema = 'audit' AND table_name = 'audit_log'
  );
END $$;
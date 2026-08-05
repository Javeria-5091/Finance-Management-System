-- ==========================================
-- PHASE 1 - STEP 1.1: Schema Setup
-- Yeh sabse pehle run hona hai
-- ==========================================

-- Schemas create karo
CREATE SCHEMA IF NOT EXISTS core;
CREATE SCHEMA IF NOT EXISTS finance;
CREATE SCHEMA IF NOT EXISTS audit;
CREATE SCHEMA IF NOT EXISTS reporting;

-- Grant schemas to authenticated users and service role
GRANT USAGE ON SCHEMA core TO authenticated, service_role;
GRANT USAGE ON SCHEMA finance TO authenticated, service_role;
GRANT USAGE ON SCHEMA audit TO authenticated, service_role;
GRANT USAGE ON SCHEMA reporting TO authenticated, service_role;

-- Grant CREATE permission (needed for tables within schemas)
GRANT CREATE ON SCHEMA core TO authenticated, service_role;
GRANT CREATE ON SCHEMA finance TO authenticated, service_role;
GRANT CREATE ON SCHEMA audit TO authenticated, service_role;
GRANT CREATE ON SCHEMA reporting TO authenticated, service_role;

-- Default privileges for future tables in these schemas
ALTER DEFAULT PRIVILEGES IN SCHEMA core GRANT ALL ON TABLES TO authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA finance GRANT ALL ON TABLES TO authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA audit GRANT ALL ON TABLES TO authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA reporting GRANT ALL ON TABLES TO authenticated, service_role;

-- ==========================================
-- SHARED UTILITY FUNCTIONS
-- ==========================================

-- Updated_at trigger function (har table pe lagega)
CREATE OR REPLACE FUNCTION core.set_updated_at()
RETURNS TRIGGER AS $$ BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
 $$ LANGUAGE plpgsql;

-- Helper: Get current user ID safely
CREATE OR REPLACE FUNCTION core.current_user_id()
RETURNS UUID AS $$ BEGIN
    RETURN auth.uid();
END;
 $$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- Helper: Check if user has specific role (old profile table se, temporary)
-- Phase 3 mein proper RBAC aayega, tab yeh replace hoga
CREATE OR REPLACE FUNCTION core.has_role(p_role TEXT)
RETURNS BOOLEAN AS $$ DECLARE
    user_role TEXT;
BEGIN
    SELECT role INTO user_role
    FROM public.profiles
    WHERE user_id = auth.uid();
    
    RETURN COALESCE(user_role, 'User') = p_role;
END;
 $$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- Helper: Is user CEO or Admin?
CREATE OR REPLACE FUNCTION core.is_ceo_or_admin()
RETURNS BOOLEAN AS $$ BEGIN
    RETURN core.has_role('CEO') OR core.has_role('Admin');
END;
 $$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- Helper: Is user Finance Head?
CREATE OR REPLACE FUNCTION core.is_finance_head()
RETURNS BOOLEAN AS $$ BEGIN
    RETURN core.has_role('CEO') 
        OR core.has_role('Admin') 
        OR core.has_role('HOD');
END;
 $$ LANGUAGE plpgsql STABLE SECURITY DEFINER;
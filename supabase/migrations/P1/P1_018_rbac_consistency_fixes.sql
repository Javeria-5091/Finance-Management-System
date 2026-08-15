-- =====================================================================
-- Migration: 018_rbac_consistency_fixes.sql
-- Purpose:   Fix CRITICAL role/permission inconsistencies:
--              (C4) public.profiles.role is a hardcoded 6-value enum
--                   that duplicates the configurable core.roles /
--                   core.user_roles system required by spec 5.1/7.2.
--              (C4b) profiles.role DEFAULT 'User' violates its own
--                   CHECK constraint (profiles_role_check does not
--                   include 'User' as an allowed value) -- any insert
--                   relying on the default currently fails.
--              (C7-new) core.has_role() reads only public.profiles.role,
--                   never core.user_roles -- so it is disconnected from
--                   the "real" configurable RBAC tables.
--              (C7-new) core.is_ceo_or_admin() and core.is_finance_head()
--                   check literal role strings 'Admin' and 'HOD', which
--                   are NOT in profiles_role_check's allowed value list
--                   ('CEO','FINANCE_HEAD','ACCOUNTANT','PROJECT_MANAGER',
--                   'EMPLOYEE','VIEWER'). This makes core.is_finance_head()
--                   return TRUE only for 'CEO' and NEVER for an actual
--                   Finance Head user -- a functional authorization bug.
-- Spec refs: 5.1, 7.1, 7.2, 10.1 (Section 30 of audit report: R9)
-- Non-destructive: yes. Does NOT drop profiles.role (application may
-- still read it) -- see "MANUAL DECISION" note at the end of this file.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- FIX 1 (C4b): profiles.role DEFAULT currently violates its own CHECK
-- constraint. Change the default to a value that is actually legal.
-- 'VIEWER' is chosen as the safest least-privileged default.
-- ---------------------------------------------------------------------
ALTER TABLE public.profiles ALTER COLUMN role SET DEFAULT 'VIEWER';

-- ---------------------------------------------------------------------
-- FIX 2: Seed core.roles with the six canonical role names already
-- encoded in profiles_role_check, so every existing profiles.role value
-- has a corresponding configurable-RBAC row. This is idempotent and
-- non-destructive -- it only inserts rows that don't already exist by
-- name, and never overwrites an existing core.roles row (an org may
-- have already customized display_name/description/level).
-- ---------------------------------------------------------------------
INSERT INTO core.roles (name, display_name, is_system, level)
VALUES
  ('CEO',              'Chief Executive Officer', true, 100),
  ('FINANCE_HEAD',     'Finance Head / CFO',       true, 90),
  ('ACCOUNTANT',       'Accountant',                true, 60),
  ('PROJECT_MANAGER',  'Project Manager',           true, 50),
  ('EMPLOYEE',         'Employee',                  true, 10),
  ('VIEWER',           'Viewer / Auditor (read-only)', true, 5)
ON CONFLICT (name) DO NOTHING;

-- ---------------------------------------------------------------------
-- FIX 4 (C7-new): Rewrite core.has_role() to check core.user_roles /
-- core.roles FIRST (the configurable, spec-correct source), falling
-- back to public.profiles.role ONLY if the user has no active
-- core.user_roles row yet. This preserves current behavior for any
-- user not yet migrated (safe/non-breaking) while making the
-- configurable system authoritative once populated.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "core"."has_role"("p_role" "text") RETURNS boolean
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'core', 'public'
    AS $$
DECLARE
  v_has_configured_role BOOLEAN;
  v_legacy_role TEXT;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM core.user_roles ur
    JOIN core.roles r ON r.id = ur.role_id
    WHERE ur.user_id = auth.uid()
      AND ur.is_active = true
      AND (ur.effective_to IS NULL OR ur.effective_to >= CURRENT_DATE)
      AND r.name = p_role
  ) INTO v_has_configured_role;

  IF v_has_configured_role THEN
    RETURN true;
  END IF;

  -- Fallback for users not yet represented in core.user_roles.
  IF NOT EXISTS (
    SELECT 1 FROM core.user_roles ur
    WHERE ur.user_id = auth.uid() AND ur.is_active = true
      AND (ur.effective_to IS NULL OR ur.effective_to >= CURRENT_DATE)
  ) THEN
    SELECT role INTO v_legacy_role FROM public.profiles WHERE user_id = auth.uid();
    RETURN COALESCE(v_legacy_role, 'VIEWER') = p_role;
  END IF;

  RETURN false;
END;
$$;

COMMENT ON FUNCTION "core"."has_role"("text") IS
  'Fixed 2026 (migration 018): now checks core.user_roles/core.roles first; falls back to public.profiles.role only for users not yet migrated. See audit issue C4/C7.';

-- ---------------------------------------------------------------------
-- FIX 5 (C7-new): is_ceo_or_admin() and is_finance_head() referenced
-- role literals ('Admin', 'HOD') that can never match any legal role
-- value, making is_finance_head() return TRUE only for CEO and never
-- for an actual Finance Head. Corrected to the real canonical names.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "core"."is_ceo_or_admin"() RETURNS boolean
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'core', 'public'
    AS $$ BEGIN
    RETURN core.has_role('CEO');
END;
$$;

CREATE OR REPLACE FUNCTION "core"."is_finance_head"() RETURNS boolean
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'core', 'public'
    AS $$ BEGIN
    RETURN core.has_role('CEO') OR core.has_role('FINANCE_HEAD');
END;
$$;

COMMENT ON FUNCTION "core"."is_ceo_or_admin"() IS
  'Fixed 2026 (migration 018): removed dead literal ''Admin'' which could never match profiles_role_check. See audit issue C7.';
COMMENT ON FUNCTION "core"."is_finance_head"() IS
  'Fixed 2026 (migration 018): removed dead literal ''HOD'' and added the correct ''FINANCE_HEAD'' check -- previously this function could NEVER return true for an actual Finance Head user. See audit issue C7.';

COMMIT;

-- MANUAL DECISION REQUIRED (not automated by this migration):
-- public.profiles.role is left in place because we cannot verify from
-- the schema alone whether application code reads it directly (e.g.
-- `SELECT role FROM profiles`). Full removal requires:
--   1. Confirming no frontend/API code reads profiles.role directly.
--   2. Repointing any such code to core.user_roles / core.has_role().
--   3. Only then: ALTER TABLE public.profiles DROP COLUMN role;
-- Until that is done, keep both in sync manually or via a future
-- trigger once the "true" source is confirmed with the dev team.
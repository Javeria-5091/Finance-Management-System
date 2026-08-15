-- =============================================================================
-- Migration: 027_lockdown_unrestricted_functions.sql
-- Purpose  : CRITICAL-6 (newly identified during independent verification of
--            the audit report — not called out in the compliance audit, but
--            fails Section 15.4's production gate: "any user can access
--            another scope... AI can... return unauthorized data"):
--
--            a) public.execute_sql_query(text) is SECURITY DEFINER, was
--               granted EXECUTE to `anon` (unauthenticated) and
--               `authenticated`, and contains NO permission/scope check and
--               NO schema/table allowlist. It runs arbitrary SELECT/CTE
--               statements as the function owner, which bypasses RLS on
--               every table in the database, including
--               public.payroll_compensation (salaries), finance.owners,
--               finance.financial_accounts, and auth.users. This directly
--               contradicts spec Section 9.5 ("Block access to system
--               catalogs, secrets, authentication tables, salary details,
--               owner details, and bank identifiers unless the user has
--               explicit permission") and 9.11's AI-authorization test gate.
--
--            b) public.find_auth_user_by_email, public.get_all_system_users,
--               and public.get_user_roles_by_id are SECURITY DEFINER, were
--               granted to `anon`, and have no internal permission check —
--               any caller (including unauthenticated ones, before this
--               migration) could enumerate every user's email/role or read
--               any other user's role-assignment history. This contradicts
--               Appendix A (role/permission administration restricted to
--               CEO / ADMIN_USERS) and Section 7.1 "deny by default".
--
--            c) public.create_user_by_admin already contains an internal
--               'Admin' role check, so it fails closed for unauthenticated
--               callers today, but it is still built on the legacy
--               profiles.role text column rather than the normalized RBAC
--               model, and it was granted to anon as a matter of blanket
--               practice. As defense in depth we remove the anon grant here;
--               the model-alignment fix (routing through core.has_permission)
--               is intentionally left to the application/service layer per
--               this project's "database + safe corrective migrations only"
--               scope, since rewriting user-provisioning logic is a business
--               workflow change, not a schema-integrity fix.
--
-- Safety   : REVOKE is non-destructive (no data changes). The two
--            CREATE OR REPLACE FUNCTION calls preserve the original return
--            type and parameter signature exactly, so no application code
--            that calls them needs to change its call shape — only callers
--            without permission now receive an explicit error/empty result
--            instead of the data.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. execute_sql_query: remove all end-user reachability. Arbitrary SQL
--    execution has no place being callable by anon/authenticated regardless
--    of the keyword blocklist inside it (blocklists are not an allowlist and
--    do not stop SELECT * FROM auth.users or SELECT * FROM
--    public.payroll_compensation). Only the trusted server-side service
--    account may retain this as an emergency/administrative tool.
-- -----------------------------------------------------------------------------
REVOKE ALL ON FUNCTION "public"."execute_sql_query"("query_string" "text") FROM PUBLIC;
REVOKE ALL ON FUNCTION "public"."execute_sql_query"("query_string" "text") FROM "anon";
REVOKE ALL ON FUNCTION "public"."execute_sql_query"("query_string" "text") FROM "authenticated";
GRANT EXECUTE ON FUNCTION "public"."execute_sql_query"("query_string" "text") TO "service_role";

COMMENT ON FUNCTION "public"."execute_sql_query"("query_string" "text") IS
  'RESTRICTED to service_role only (migration 027). This function has no schema/table allowlist and runs as the function owner, bypassing RLS. It must never be reachable from the AI gateway or any authenticated end-user session; use public.execute_ai_readonly_query (scoped to the ai_readonly_role and public/reporting schemas) for AI-driven querying instead, per spec Section 9.5.';

-- -----------------------------------------------------------------------------
-- 2. execute_ai_readonly_query: this is the correctly-designed AI entrypoint
--    (switches to ai_readonly_role, pins search_path, 5s timeout). It should
--    remain callable by authenticated users (the AI gateway runs in their
--    session context per spec 9.3), but never by anon.
-- -----------------------------------------------------------------------------
REVOKE ALL ON FUNCTION "public"."execute_ai_readonly_query"(text, uuid, uuid, boolean) FROM "anon";

-- -----------------------------------------------------------------------------
-- 3. Admin/user-enumeration helper functions: remove anon reachability and
--    add an internal ADMIN_USERS permission check so authenticated
--    non-admin users cannot enumerate other users or read other users'
--    role history.
-- -----------------------------------------------------------------------------
REVOKE ALL ON FUNCTION "public"."find_auth_user_by_email"("search_email" "text") FROM "anon";
REVOKE ALL ON FUNCTION "public"."get_all_system_users"() FROM "anon";
REVOKE ALL ON FUNCTION "public"."get_user_roles_by_id"("p_target_user_id" "uuid") FROM "anon";
REVOKE ALL ON FUNCTION "public"."create_user_by_admin"("p_email" "text", "p_password" "text", "p_role" "text", "p_full_name" "text") FROM "anon";

CREATE OR REPLACE FUNCTION "public"."find_auth_user_by_email"("search_email" "text")
RETURNS TABLE("user_id" "uuid", "email" "text")
LANGUAGE "plpgsql" STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, core
AS $$
BEGIN
  IF NOT core.has_permission(auth.uid(), 'ADMIN_USERS') THEN
    RAISE EXCEPTION 'Access denied: ADMIN_USERS permission required';
  END IF;

  RETURN QUERY
  SELECT u.id, u.email
  FROM auth.users u
  WHERE u.email ILIKE '%' || search_email || '%'
  LIMIT 10;
END;
$$;

CREATE OR REPLACE FUNCTION "public"."get_all_system_users"()
RETURNS TABLE("user_id" "uuid", "email" "text", "full_name" "text", "profile_role" "text", "has_profile" boolean)
LANGUAGE "plpgsql" STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, core
AS $$
BEGIN
  IF NOT core.has_permission(auth.uid(), 'ADMIN_USERS') THEN
    RAISE EXCEPTION 'Access denied: ADMIN_USERS permission required';
  END IF;

  RETURN QUERY
  SELECT
    u.id AS user_id,
    u.email,
    COALESCE(p.full_name, '') AS full_name,
    p.role AS profile_role,
    (p.id IS NOT NULL) AS has_profile
  FROM auth.users u
  LEFT JOIN public.profiles p ON p.user_id = u.id
  ORDER BY COALESCE(p.full_name, u.email);
END;
$$;

CREATE OR REPLACE FUNCTION "public"."get_user_roles_by_id"("p_target_user_id" "uuid")
RETURNS TABLE("id" "uuid", "user_id" "uuid", "role_id" "uuid", "role" "text", "role_display_name" "text", "role_level" integer, "is_active" boolean, "effective_from" "date", "effective_to" "date", "delegated_from" "uuid", "created_at" timestamp with time zone, "updated_at" timestamp with time zone, "created_by" "uuid")
LANGUAGE "plpgsql" STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, core
AS $$
BEGIN
  IF auth.uid() IS DISTINCT FROM p_target_user_id
     AND NOT core.has_permission(auth.uid(), 'ADMIN_USERS') THEN
    RAISE EXCEPTION 'Access denied: cannot view another user''s role history';
  END IF;

  RETURN QUERY
  SELECT
    ur.id, ur.user_id, ur.role_id, r.name, r.display_name, r.level,
    ur.is_active, ur.effective_from, ur.effective_to, ur.delegated_from,
    ur.created_at, ur.updated_at, ur.created_by
  FROM core.user_roles ur
  INNER JOIN core.roles r ON r.id = ur.role_id
  WHERE ur.user_id = p_target_user_id;
END;
$$;

ALTER FUNCTION "public"."find_auth_user_by_email"("search_email" "text") OWNER TO "postgres";
ALTER FUNCTION "public"."get_all_system_users"() OWNER TO "postgres";
ALTER FUNCTION "public"."get_user_roles_by_id"("p_target_user_id" "uuid") OWNER TO "postgres";

GRANT EXECUTE ON FUNCTION "public"."find_auth_user_by_email"("search_email" "text") TO "authenticated", "service_role";
GRANT EXECUTE ON FUNCTION "public"."get_all_system_users"() TO "authenticated", "service_role";
GRANT EXECUTE ON FUNCTION "public"."get_user_roles_by_id"("p_target_user_id" "uuid") TO "authenticated", "service_role";
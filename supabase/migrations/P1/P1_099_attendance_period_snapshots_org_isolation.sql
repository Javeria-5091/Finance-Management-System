-- ============================================================================
-- P1_099_aud_p1_004_attendance_period_snapshots_org_isolation.sql
--
-- AUD-P1-004 FIX: finance.attendance_period_snapshots has no organization_id
-- column, and its two RLS policies (attendance_period_snapshots_insert,
-- attendance_period_snapshots_select) are role-only -- is_ceo_or_admin() /
-- is_finance_head() / has_role('ACCOUNTANT') -- with no tenant predicate at
-- all. Any holder of those roles, in ANY organization, could SELECT every
-- other organization's attendance/payroll-input snapshots (which include
-- snapshot_payload, an immutable payroll-calculation input) and INSERT rows
-- referencing another tenant's shared_person_id, injecting bogus payroll
-- inputs into a tenant they don't belong to.
--
-- Per spec Appendix D, this table is scoped per-organization indirectly via
-- shared_person_id -> core.shared_people.organization_id (there is no direct
-- organization_id column on this table, by design -- see the FK
-- attendance_period_snapshots_shared_person_id_fkey).
--
-- IMPORTANT: core.shared_people itself has RLS (shared_people_select_self_org_scoped)
-- that only allows a row's own auth_user_id or a caller holding the ADMIN_USERS
-- permission -- FINANCE_HEAD and ACCOUNTANT do NOT hold ADMIN_USERS (see
-- seed_data.sql role_permissions: FINANCE_HEAD is explicitly granted
-- everything EXCEPT ADMIN_USERS/ADMIN_AUDIT/ADMIN_CONFIG/PERIOD_REOPEN, and
-- ACCOUNTANT's grants are scoped to income/expense/etc. codes only). A plain
-- "EXISTS (SELECT 1 FROM core.shared_people WHERE ...)" written directly
-- inside this table's policies would therefore itself be filtered by
-- shared_people's own RLS for the querying role, and would silently return
-- zero rows for FINANCE_HEAD/ACCOUNTANT even for their own organization's
-- data -- turning this fix into a functional regression instead of a
-- security fix. To avoid that, this migration adds a small SECURITY DEFINER
-- helper, core.shared_person_same_org(uuid), that performs the same-org
-- lookup as the table owner (bypassing shared_people's RLS, exactly the way
-- core.same_org()/core.has_permission()/etc. already bypass RLS on the
-- tables they inspect), and uses that helper -- rather than a raw EXISTS --
-- in both policies.
--
-- No organization_id column is added to the table itself, matching the
-- spec's indirect-scoping design and keeping the change minimal. Existing
-- role requirements on both policies are preserved verbatim; the new
-- conjunct can only narrow the rows an authenticated caller can see or
-- insert, never widen them.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION "core"."shared_person_same_org"("p_shared_person_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'core', 'public'
    AS $$
  SELECT EXISTS (
    SELECT 1
    FROM core.shared_people sp
    WHERE sp.id = p_shared_person_id
      AND core.same_org(sp.organization_id)
  );
$$;

COMMENT ON FUNCTION "core"."shared_person_same_org"("p_shared_person_id" "uuid") IS 'AUD-P1-004 fix: true only when p_shared_person_id resolves to a core.shared_people row in the caller''s own organization (via core.same_org(), which itself fails closed on NULL). SECURITY DEFINER so this evaluates safely inside RLS policies on other tables (e.g. finance.attendance_period_snapshots) without those policies also being subject to core.shared_people''s own, more restrictive SELECT policy (ADMIN_USERS permission or self-match) -- a plain EXISTS subquery against shared_people from a non-admin caller''s policy would otherwise silently return no rows and incorrectly deny same-organization access to roles like FINANCE_HEAD/ACCOUNTANT that do not hold ADMIN_USERS.';

REVOKE ALL ON FUNCTION "core"."shared_person_same_org"("p_shared_person_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "core"."shared_person_same_org"("p_shared_person_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "core"."shared_person_same_org"("p_shared_person_id" "uuid") TO "service_role";

DROP POLICY IF EXISTS "attendance_period_snapshots_insert" ON "finance"."attendance_period_snapshots";
CREATE POLICY "attendance_period_snapshots_insert" ON "finance"."attendance_period_snapshots" FOR INSERT
  WITH CHECK ((("core"."is_ceo_or_admin"() OR "core"."is_finance_head"()) AND "core"."shared_person_same_org"("shared_person_id")));

DROP POLICY IF EXISTS "attendance_period_snapshots_select" ON "finance"."attendance_period_snapshots";
CREATE POLICY "attendance_period_snapshots_select" ON "finance"."attendance_period_snapshots" FOR SELECT
  USING ((("core"."is_ceo_or_admin"() OR "core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text")) AND "core"."shared_person_same_org"("shared_person_id")));

COMMIT;
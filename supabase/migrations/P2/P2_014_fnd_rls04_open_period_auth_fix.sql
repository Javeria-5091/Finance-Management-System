-- =====================================================================
-- Finance Management System — Critical Fix
--   FND-RLS-04 (P1): finance.open_period is SECURITY DEFINER with no
--   auth.uid() check, no organization scoping in its query
--   (WHERE ap.id = p_period_id -- no organization_id filter at all), and
--   no explicit GRANT/REVOKE in the schema dump, which means it keeps
--   Postgres's default PUBLIC EXECUTE on functions. p_opened_by is an
--   ordinary client parameter used as COALESCE(p_opened_by, auth.uid())
--   for the audit trail, so a caller doesn't even need to be
--   authenticated to supply it.
--
-- Impact: any principal (including anon, and including an authenticated
-- user from a completely different organization) who knows or guesses a
-- period UUID can transition that period to OPEN, in any tenant.
--
-- Note on scope: as written, this specific function only transitions
-- PENDING -> OPEN (it raises if the period isn't PENDING), so it cannot
-- reopen an already SOFT_CLOSED/HARD_CLOSED period by itself -- but the
-- missing auth/org checks are exactly as described, and letting any
-- anonymous/cross-tenant caller flip on a period out of sequence still
-- defeats the period-lock every posting engine relies on. Fixed to the
-- same standard as the sibling finance.close_period(), which already
-- does this correctly: require authentication, scope to the caller's own
-- organization, and require the same role that's allowed to close a
-- period (CEO/Finance Head).
-- =====================================================================

BEGIN;

CREATE OR REPLACE FUNCTION "finance"."open_period"("p_period_id" "uuid", "p_opened_by" "uuid" DEFAULT NULL::"uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'public', 'core'
    AS $$
DECLARE
    v_period RECORD;
    v_user_id UUID;
    v_org_id UUID;
BEGIN
    -- FND-RLS-04 FIX: authenticate, scope to the caller's own
    -- organization, and require the same role finance.close_period()
    -- already requires -- instead of trusting p_opened_by and running an
    -- unscoped, unauthenticated UPDATE against any organization's period.

    v_org_id := core.current_user_org_id();
    v_user_id := auth.uid();

    IF v_org_id IS NULL OR v_user_id IS NULL THEN
        RAISE EXCEPTION 'Authentication and organization context are required';
    END IF;

    IF NOT core.is_finance_head() THEN
        RAISE EXCEPTION 'Only CEO or Finance Head may open an accounting period';
    END IF;

    -- p_opened_by, if supplied, must match the authenticated caller --
    -- it's only accepted at all for backward compatibility with existing
    -- callers; it can no longer be used to attribute the action to
    -- someone else.
    IF p_opened_by IS NOT NULL AND p_opened_by IS DISTINCT FROM v_user_id THEN
        RAISE EXCEPTION 'open_period: p_opened_by must match the authenticated caller'
          USING ERRCODE = '42501';
    END IF;

    PERFORM set_config('app.current_user_id', v_user_id::TEXT, true);

    SELECT ap.*, fy.status AS fy_status, fy.name AS fy_name
    INTO v_period
    FROM finance.accounting_periods ap
    JOIN finance.fiscal_years fy ON ap.fiscal_year_id = fy.id
    WHERE ap.id = p_period_id
      AND ap.organization_id = v_org_id
    FOR UPDATE OF ap;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Period not found or access denied';
    END IF;

    IF v_period.fy_status != 'OPEN' THEN
        RAISE EXCEPTION 'Cannot open period: fiscal year "%" is not open', v_period.fy_name;
    END IF;

    IF v_period.status != 'PENDING' THEN
        RAISE EXCEPTION 'Period is not in PENDING status (current: %)', v_period.status;
    END IF;

    UPDATE finance.accounting_periods
    SET status = 'OPEN',
        updated_at = NOW()
    WHERE id = p_period_id
      AND organization_id = v_org_id;
END;
 $$;

ALTER FUNCTION "finance"."open_period"("p_period_id" "uuid", "p_opened_by" "uuid") OWNER TO "postgres";

COMMENT ON FUNCTION "finance"."open_period"("p_period_id" "uuid", "p_opened_by" "uuid") IS
  'FND-RLS-04 fix: now requires auth.uid() IS NOT NULL, an organization context, and core.is_finance_head() before touching any period -- and the target period is looked up scoped to the caller''s own organization_id (previously unscoped, so any period UUID in any tenant could be matched). Previously had no explicit GRANT/REVOKE, leaving Postgres''s default PUBLIC EXECUTE in place, so anon could call it too.';

-- Explicit, restrictive grants -- close the default-PUBLIC-EXECUTE gap
-- directly, in addition to the auth check above.
REVOKE ALL ON FUNCTION "finance"."open_period"("p_period_id" "uuid", "p_opened_by" "uuid") FROM PUBLIC;
REVOKE ALL ON FUNCTION "finance"."open_period"("p_period_id" "uuid", "p_opened_by" "uuid") FROM "anon";

GRANT ALL ON FUNCTION "finance"."open_period"("p_period_id" "uuid", "p_opened_by" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "finance"."open_period"("p_period_id" "uuid", "p_opened_by" "uuid") TO "service_role";

COMMIT;

-- ---------------------------------------------------------------------
-- Verification:
--   1) As anon: rpc call now fails (no EXECUTE grant at all; would also
--      fail auth.uid() IS NULL if it somehow reached the body).
--   2) As an authenticated EMPLOYEE (not CEO/Finance Head), on a PENDING
--      period in their own org:
--        select finance.open_period('<period-id>');
--        -- expect: ERROR  Only CEO or Finance Head may open an accounting period
--   3) As an authenticated Finance Head, passing a PENDING period id that
--      belongs to a DIFFERENT organization:
--        -- expect: ERROR  Period not found or access denied
--   4) As an authenticated Finance Head, passing someone else's uuid as
--      p_opened_by:
--        -- expect: ERROR  p_opened_by must match the authenticated caller
--   5) Normal path (Finance Head/CEO, own org, target period is PENDING,
--      fiscal year is OPEN) still transitions the period to OPEN exactly
--      as before, including src/app/api/year-end-close/route.ts's use of
--      this function to open the next period (that route already
--      requires PERIOD_CLOSE and passes auth.userId as p_opened_by, so it
--      is unaffected by this tightening).
-- ---------------------------------------------------------------------
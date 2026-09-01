-- =====================================================================
-- Finance Management System — Critical Fix
--   AI-01 (P1): Organization-wide AI daily limit is RLS-neutered; the
--   company cost ceiling is unenforceable.
--
-- Root cause: checkOrgAiDailyLimit() (src/lib/api-auth.ts) is meant to
-- sum every user's AI usage for the org today, via:
--
--   supabase.schema('ai').from('ai_user_cost_tracking')
--     .select('request_count, estimated_cost')
--     .eq('organization_id', orgId)
--     .eq('period_date', today)
--
-- deliberately WITHOUT a user_id filter, so it aggregates across all
-- users. But `supabase` here is the request-scoped client from
-- getAuthSupabase() (createServerClient with the caller's own bearer
-- token/cookies) — every query it runs executes as the "authenticated"
-- Postgres role, subject to RLS, as the CURRENT user.
--
-- The only SELECT/UPDATE policy on ai.ai_user_cost_tracking is:
--
--   CREATE POLICY "users_own_cost" ON ai.ai_user_cost_tracking
--     TO authenticated
--     USING ((user_id = auth.uid()) AND core.same_org(organization_id))
--     WITH CHECK ((user_id = auth.uid()) AND core.same_org(organization_id));
--
-- RLS silently ANDs "user_id = auth.uid()" onto every row regardless of
-- what the application's own .eq('organization_id', orgId) filter says.
-- So checkOrgAiDailyLimit's "org-wide" query never actually sees any
-- other user's rows — it always returns (at most) the CURRENT user's
-- own single row, no matter how many other people in the org are
-- burning through the AI budget at the same time. Since a single user's
-- own daily totals are, by construction, already below their personal
-- cap (checkAiDailyLimit ran first and would have blocked them
-- otherwise), the "org-wide" check almost never trips: 50 different
-- users each safely under their own 100-request/day limit can collectively
-- blow through any company-wide ceiling with this check never once
-- returning false.
--
-- Fix: add a SECURITY DEFINER aggregation RPC,
-- ai.get_org_daily_ai_usage(p_organization_id, p_period_date), that
-- computes SUM(request_count)/SUM(estimated_cost) across every user in
-- the org for that date, bypassing the per-row RLS restriction the way
-- ai.increment_usage() already does for writes. It intentionally
-- returns ONLY the two aggregate totals — never the underlying
-- per-user rows — so this is strictly less exposure than granting a
-- broader SELECT policy would be (which would leak every individual
-- user's usage to every other user in the org); any authenticated
-- member of the org can call it (needed, since every AI request from
-- every user must pass this gate), but all they ever learn is "the
-- org used N requests / $X today", never who. Same auth checks as the
-- existing ai.increment_usage(): requires an authenticated caller and
-- core.same_org(p_organization_id).
--
-- checkOrgAiDailyLimit() in src/lib/api-auth.ts is updated to call this
-- RPC instead of a raw table SELECT, so the aggregate is computed
-- inside the SECURITY DEFINER function (which runs as the function
-- owner, outside this RLS policy) rather than in application code
-- fighting against it.
-- =====================================================================

BEGIN;

CREATE OR REPLACE FUNCTION "ai"."get_org_daily_ai_usage"("p_organization_id" "uuid", "p_period_date" "date" DEFAULT CURRENT_DATE) RETURNS TABLE("total_requests" bigint, "total_cost" numeric)
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'ai', 'core', 'public'
    AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF NOT core.same_org(p_organization_id) THEN
    RAISE EXCEPTION 'Cannot read AI usage for another organization';
  END IF;

  RETURN QUERY
  SELECT
    COALESCE(SUM(request_count), 0)::bigint AS total_requests,
    COALESCE(SUM(estimated_cost), 0)::numeric AS total_cost
  FROM ai.ai_user_cost_tracking
  WHERE organization_id = p_organization_id
    AND period_date = p_period_date;
END;
$$;

ALTER FUNCTION "ai"."get_org_daily_ai_usage"("p_organization_id" "uuid", "p_period_date" "date") OWNER TO "postgres";

COMMENT ON FUNCTION "ai"."get_org_daily_ai_usage"("p_organization_id" "uuid", "p_period_date" "date") IS
  'AI-01 FIX (P1): SECURITY DEFINER aggregation used by '
  'checkOrgAiDailyLimit() (src/lib/api-auth.ts) so the organization-wide '
  'daily request/cost totals can actually be computed. The request-scoped '
  'client that route handlers use runs as "authenticated", and the only '
  'policy on ai.ai_user_cost_tracking (users_own_cost) restricts every '
  'row read to user_id = auth.uid() regardless of any organization_id '
  'filter in the query — a raw SELECT from application code could only '
  'ever see the calling user''s own row, silently defeating the '
  'organization-wide cost ceiling entirely. This function returns only '
  'the two SUM() totals, never the underlying per-user rows, so it is '
  'no more exposing than the existing per-user check.';

GRANT ALL ON FUNCTION "ai"."get_org_daily_ai_usage"("p_organization_id" "uuid", "p_period_date" "date") TO "authenticated";

COMMENT ON POLICY "users_own_cost" ON "ai"."ai_user_cost_tracking" IS
  'AI-01 NOTE (P1): this policy intentionally restricts every row read/write '
  'to the caller''s own user_id -- per-user usage rows should not be readable '
  'by other org members. Any organization-WIDE aggregate (total requests/cost '
  'across all users today) must go through the SECURITY DEFINER RPC '
  'ai.get_org_daily_ai_usage(), which bypasses this policy on purpose and '
  'returns only SUM() totals, never per-user rows. A raw SELECT filtered only '
  'by organization_id from request-scoped application code will silently be '
  'narrowed to just the caller''s own row by this policy, which is exactly '
  'the bug that made the organization-wide AI cost ceiling unenforceable.';

COMMIT;
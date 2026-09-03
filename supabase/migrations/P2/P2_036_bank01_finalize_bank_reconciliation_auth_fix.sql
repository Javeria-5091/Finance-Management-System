-- =====================================================================
-- Finance Management System — Critical Fix
--   BANK-01 (P1, HIGH): finance.finalize_bank_reconciliation is SECURITY
--   DEFINER and trusts p_organization_id / p_user_id as ordinary client
--   parameters:
--
--     v_org := COALESCE(p_organization_id, core.current_user_org_id());
--     ...
--     UPDATE finance.bank_statements SET reconciled_by = p_user_id ...
--
--   The role check (is_finance_head() OR has_role('ACCOUNTANT')) is
--   correctly bound to auth.uid() and cannot be spoofed, but it only
--   proves the caller holds one of those roles SOMEWHERE -- it says
--   nothing about which organization's statement is being touched. The
--   target row is then selected using the caller-supplied v_org, inside a
--   SECURITY DEFINER function, so RLS never gets a chance to reject a
--   cross-tenant organization_id.
--
--   src/app/api/finance/banking/reconciliation/route.ts already passes
--   auth.userId/auth.orgId correctly, but this RPC is directly callable
--   via PostgREST by any authenticated principal, and the UI
--   (src/services/bank.service.ts, src/hooks/useBanking.ts) calls it
--   directly rather than through that route. A finance-head/accountant of
--   tenant A can therefore call the RPC directly with tenant B's
--   organization_id and finalize tenant B's reconciliation, and can pass
--   an arbitrary p_user_id to spoof who "approved" it (reconciled_by).
--
-- Fix: identical pattern to FND-RLS-03 (finance.finalize_platform_settlement)
-- -- derive/validate identity and organization inside the function itself,
-- so it is safe no matter how it is called. p_organization_id and
-- p_user_id are still accepted (so no application call site needs to
-- change its call shape), but are now verified against the authenticated
-- session rather than trusted outright.
-- =====================================================================

BEGIN;

CREATE OR REPLACE FUNCTION "finance"."finalize_bank_reconciliation"("p_statement_id" "uuid", "p_user_id" "uuid", "p_organization_id" "uuid" DEFAULT NULL::"uuid") RETURNS "finance"."bank_statements"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'public', 'core'
    AS $$
DECLARE
  -- BANK-01 FIX: v_org is now always derived from the authenticated
  -- session, never from the client-supplied parameter. p_organization_id
  -- is still accepted below purely to be validated against this value --
  -- it is never itself the source of truth.
  v_org uuid := core.current_user_org_id();
  v_statement RECORD;
  v_unresolved integer;
  v_result finance.bank_statements;
BEGIN
  -- BANK-01 FIX: authenticate inside the function itself instead of
  -- relying solely on the app route (bypassable via direct PostgREST/RPC
  -- calls, exactly as the UI itself already does).
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'finalize_bank_reconciliation: must be called by an authenticated user'
      USING ERRCODE = '28000';
  END IF;

  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Organization context is required';
  END IF;

  -- BANK-01 FIX: if the caller supplies p_organization_id at all, it must
  -- match their own organization -- never let it select a different
  -- tenant's statement. (A NULL/omitted value is fine and simply uses the
  -- caller's own organization, preserving the existing default-parameter
  -- call shape for every current call site, all of which already pass
  -- their own organization_id.)
  IF p_organization_id IS NOT NULL AND p_organization_id IS DISTINCT FROM v_org THEN
    RAISE EXCEPTION 'finalize_bank_reconciliation: p_organization_id does not match the caller''s organization'
      USING ERRCODE = '42501';
  END IF;

  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'Approving user is required';
  END IF;

  -- BANK-01 FIX: p_user_id must be the caller themselves. It is recorded
  -- verbatim as reconciled_by, so accepting an arbitrary value let a
  -- caller attribute the approval to someone else entirely.
  IF p_user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'finalize_bank_reconciliation: p_user_id must match the authenticated caller'
      USING ERRCODE = '42501';
  END IF;

  IF NOT (core.is_finance_head() OR core.has_role('ACCOUNTANT')) THEN
    RAISE EXCEPTION 'Access denied';
  END IF;

  SELECT * INTO v_statement
  FROM finance.bank_statements
  WHERE id = p_statement_id AND organization_id = v_org
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Bank statement not found or access denied';
  END IF;

  IF v_statement.reconciliation_status = 'COMPLETED' AND v_statement.reconciled_by IS NOT NULL THEN
    RAISE EXCEPTION 'This statement has already been reconciled and approved';
  END IF;

  SELECT COUNT(*) INTO v_unresolved
  FROM finance.statement_lines
  WHERE bank_statement_id = p_statement_id AND reconciliation_status = 'UNRECONCILED';

  IF v_unresolved > 0 THEN
    RAISE EXCEPTION 'Cannot finalize: % statement line(s) are still unresolved (unmatched, not excluded, not flagged as duplicate)', v_unresolved;
  END IF;

  UPDATE finance.bank_statements
  SET reconciliation_status = 'COMPLETED',
      reconciled_by = p_user_id,
      reconciled_at = now(),
      updated_at = now()
  WHERE id = p_statement_id AND organization_id = v_org
  RETURNING * INTO v_result;

  RETURN v_result;
END;
$$;

ALTER FUNCTION "finance"."finalize_bank_reconciliation"("p_statement_id" "uuid", "p_user_id" "uuid", "p_organization_id" "uuid") OWNER TO "postgres";

COMMENT ON FUNCTION "finance"."finalize_bank_reconciliation"("p_statement_id" "uuid", "p_user_id" "uuid", "p_organization_id" "uuid") IS
  'BANK-01 fix: now requires auth.uid() IS NOT NULL, rejects any p_organization_id that does not match core.current_user_org_id(), and requires p_user_id = auth.uid(). Previously trusted both as ordinary client parameters (v_org := COALESCE(p_organization_id, core.current_user_org_id())), which let an authenticated finance-head/accountant of one tenant finalize another tenant''s bank statement reconciliation and attribute the approval (reconciled_by) to an arbitrary user id.';

-- Defense-in-depth: explicit REVOKE FROM PUBLIC/anon, matching the
-- FND-RLS-03 fix on the sibling function. The function's own auth.uid()
-- check now makes it safe regardless of grants, but there is no
-- legitimate reason for this to be reachable by anything other than
-- `authenticated`.
REVOKE ALL ON FUNCTION "finance"."finalize_bank_reconciliation"("p_statement_id" "uuid", "p_user_id" "uuid", "p_organization_id" "uuid") FROM PUBLIC;
REVOKE ALL ON FUNCTION "finance"."finalize_bank_reconciliation"("p_statement_id" "uuid", "p_user_id" "uuid", "p_organization_id" "uuid") FROM "anon";

GRANT ALL ON FUNCTION "finance"."finalize_bank_reconciliation"("p_statement_id" "uuid", "p_user_id" "uuid", "p_organization_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "finance"."finalize_bank_reconciliation"("p_statement_id" "uuid", "p_user_id" "uuid", "p_organization_id" "uuid") TO "service_role";

COMMIT;

-- ---------------------------------------------------------------------
-- Verification:
--   1) As anon: rpc call fails at auth.uid() IS NULL (and is no longer
--      GRANTed at all).
--   2) As org-A finance head/accountant, calling directly via
--      /rest/v1/rpc/finalize_bank_reconciliation with p_statement_id of an
--      org-B statement, p_organization_id = org-B uuid, p_user_id = own
--      uid (the original repro):
--        -- expect: ERROR  p_organization_id does not match the caller's organization
--   3) As org-A finance head/accountant, p_organization_id omitted/NULL,
--      p_statement_id belongs to org B:
--        -- expect: ERROR  Bank statement not found or access denied
--      (v_org is always the caller's own org now, so the lookup itself
--      never matches a foreign statement regardless of what -- or
--      whether -- p_organization_id was supplied.)
--   4) As org-A finance head/accountant, own statement, p_user_id set to
--      an arbitrary/other uuid (the attribution-spoofing repro):
--        -- expect: ERROR  p_user_id must match the authenticated caller
--   5) Normal path (own org's statement, own uid, holds FINANCE_HEAD/CEO
--      or ACCOUNTANT role, no unresolved lines) still succeeds exactly as
--      before -- every existing call site (the safe API route,
--      bank.service.ts, useBanking.ts) already passes the caller's own
--      organization_id/user_id, so none of them are affected.
-- ---------------------------------------------------------------------
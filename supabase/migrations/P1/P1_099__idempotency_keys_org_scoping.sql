-- ============================================================================
-- P1_098_aud_p1_003_idempotency_keys_org_scoping.sql
--
-- AUD-P1-003 FIX: core.idempotency_keys_read_finance (the SELECT policy for
-- authenticated users on core.idempotency_keys) was `USING
-- (core.is_finance_head())` with no organization predicate at all, even
-- though the table's organization_id column is NOT NULL and FK'd to
-- core.organizations(id) (see idempotency_keys_org_fkey). Any FINANCE_HEAD
-- (or CEO, since core.is_finance_head() returns true for either -- see its
-- definition) could therefore SELECT every organization's idempotency
-- records, including response_snapshot (JSONB), which can contain payment
-- amounts, references, and raw provider/webhook responses for other
-- tenants' payment/import/posting commands.
--
-- Every other tenant-sensitive RLS policy in this schema pairs its role
-- check with core.same_org(organization_id) (which fails closed -- false --
-- if either side is NULL, per its own definition). This migration adds that
-- same conjunct here and changes nothing else: the role requirement
-- (is_finance_head()) is unchanged, core.idempotency_keys_service_all for
-- service_role is untouched, and no INSERT/UPDATE/DELETE policy exists on
-- this table to begin with (writes were never exposed by this bug, per the
-- audit finding). Adding an AND-ed predicate can only narrow the rows
-- returned, never widen them, so this carries no regression risk to
-- in-organization access.
-- ============================================================================

BEGIN;

DROP POLICY IF EXISTS "idempotency_keys_read_finance" ON "core"."idempotency_keys";
CREATE POLICY "idempotency_keys_read_finance" ON "core"."idempotency_keys" FOR SELECT TO "authenticated"
  USING (("core"."is_finance_head"() AND "core"."same_org"("organization_id")));

-- idempotency_keys_service_all (service_role, USING true / WITH CHECK true)
-- is untouched -- it never referenced the broken predicate.

COMMIT;
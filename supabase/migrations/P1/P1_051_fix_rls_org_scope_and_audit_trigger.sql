-- =============================================================================
-- Migration: 039_fix_rls_org_scope_and_audit_trigger.sql
-- Purpose:   Complete Finding 4.1 (CRITICAL) by replacing the RLS policies on
--            public.invoices/expenses/projects/budgets/clients so they
--            actually enforce organization isolation, and fix two related
--            issues discovered while implementing this fix (see notes below).
--            Also updates audit.trigger_audit_log() so every NEW audit_log
--            row going forward is organization-scoped (completes Finding 4.5).
--
-- Newly discovered issues fixed here (found while re-auditing RLS per the
-- current task's Section 17/18 instructions -- not invented scope creep,
-- these are in the same table set already being touched for Finding 4.1):
--
--   (a) public.clients had FOUR policies (clients_select/insert/update/delete)
--       defined as `USING (true)` / `WITH CHECK (true)` with NO `TO` clause,
--       meaning they apply to PUBLIC -- including the anon role, which also
--       holds a GRANT ALL on this table. This table was fully open to
--       unauthenticated requests. Fixed by dropping all four and replacing
--       with role- and organization-scoped policies restricted TO authenticated.
--
--   (b) public.projects had FOUR overlapping policies, two of which
--       ("All users can view projects", "projects_select") allowed ANY
--       authenticated user to SELECT every project regardless of role or
--       organization. Because Postgres OR's multiple permissive policies
--       together, adding an org check to the *other* two policies would not
--       have closed this gap. Fixed by dropping all four and replacing with
--       a single consistent, organization- and role-scoped policy per action,
--       matching the pattern already used by finance.journal_entries etc.
--
-- IMPORTANT: This migration is idempotent for policies via DROP POLICY IF
-- EXISTS + CREATE POLICY, but dropping and recreating policies is NOT purely
-- additive -- it briefly removes the named policy within the transaction.
-- Because this migration runs inside BEGIN/COMMIT, no window of unprotected
-- access is externally visible: either the whole transaction commits with
-- the new policies in place, or it rolls back entirely with the old policies
-- unchanged.
--
-- Prerequisite: migrations 036-038 must have already run (organization_id
-- columns must exist on these tables for core.same_org(organization_id) to
-- have anything to check).
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------
-- 1. public.invoices -- add organization scoping to existing predicates
-- -----------------------------------------------------------------------

DROP POLICY IF EXISTS "invoices_select_scoped" ON "public"."invoices";
DROP POLICY IF EXISTS "invoices_insert_scoped" ON "public"."invoices";
DROP POLICY IF EXISTS "invoices_update_scoped" ON "public"."invoices";
DROP POLICY IF EXISTS "invoices_delete_scoped" ON "public"."invoices";

CREATE POLICY "invoices_select_org_scoped" ON "public"."invoices"
  FOR SELECT TO "authenticated"
  USING (
    "core"."same_org"("organization_id") AND (
      "core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT') OR "core"."has_role"('VIEWER')
      OR ("user_id" = "auth"."uid"())
      OR (EXISTS (SELECT 1 FROM "public"."projects" "p" WHERE "p"."id" = "invoices"."project_id" AND "p"."user_id" = "auth"."uid"()))
    )
  );

CREATE POLICY "invoices_insert_org_scoped" ON "public"."invoices"
  FOR INSERT TO "authenticated"
  WITH CHECK (
    "core"."same_org"("organization_id") AND (
      "core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT') OR ("user_id" = "auth"."uid"())
    )
  );

CREATE POLICY "invoices_update_org_scoped" ON "public"."invoices"
  FOR UPDATE TO "authenticated"
  USING ("core"."same_org"("organization_id") AND (("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT')) AND "journal_entry_id" IS NULL))
  WITH CHECK ("core"."same_org"("organization_id") AND (("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT')) AND "journal_entry_id" IS NULL));

CREATE POLICY "invoices_delete_org_scoped" ON "public"."invoices"
  FOR DELETE TO "authenticated"
  USING ("core"."same_org"("organization_id") AND (("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT')) AND "journal_entry_id" IS NULL));

-- -----------------------------------------------------------------------
-- 2. public.expenses -- add organization scoping to existing predicates
--    (is_admin() left as-is: it is dead code today -- see the compliance
--    report's observation on public.is_admin() -- but replacing it is a
--    separate authorization-model decision, not an org-scoping fix, so it
--    is intentionally out of scope for this migration.)
-- -----------------------------------------------------------------------

DROP POLICY IF EXISTS "expenses_select_scoped" ON "public"."expenses";
DROP POLICY IF EXISTS "expenses_insert" ON "public"."expenses";
DROP POLICY IF EXISTS "expenses_update" ON "public"."expenses";
DROP POLICY IF EXISTS "expenses_delete" ON "public"."expenses";

CREATE POLICY "expenses_select_org_scoped" ON "public"."expenses"
  FOR SELECT TO "authenticated"
  USING (
    "core"."same_org"("organization_id") AND (
      "core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT') OR "core"."has_role"('VIEWER')
      OR ("user_id" = "auth"."uid"())
      OR ("project_id" IS NOT NULL AND EXISTS (SELECT 1 FROM "public"."projects" "p" WHERE "p"."id" = "expenses"."project_id" AND "p"."user_id" = "auth"."uid"()))
    )
  );

CREATE POLICY "expenses_insert_org_scoped" ON "public"."expenses"
  FOR INSERT TO "authenticated"
  WITH CHECK ("core"."same_org"("organization_id") AND (("auth"."uid"() = "user_id") OR "public"."is_admin"()));

CREATE POLICY "expenses_update_org_scoped" ON "public"."expenses"
  FOR UPDATE TO "authenticated"
  USING ("core"."same_org"("organization_id") AND (("auth"."uid"() = "user_id") OR "public"."is_admin"()))
  WITH CHECK ("core"."same_org"("organization_id") AND (("auth"."uid"() = "user_id") OR "public"."is_admin"()));

CREATE POLICY "expenses_delete_org_scoped" ON "public"."expenses"
  FOR DELETE TO "authenticated"
  USING ("core"."same_org"("organization_id") AND (("auth"."uid"() = "user_id") OR "public"."is_admin"()));

-- -----------------------------------------------------------------------
-- 3. public.budgets -- add organization scoping to existing predicates
-- -----------------------------------------------------------------------

DROP POLICY IF EXISTS "budgets_select_scoped" ON "public"."budgets";
DROP POLICY IF EXISTS "budgets_insert_scoped" ON "public"."budgets";
DROP POLICY IF EXISTS "budgets_update_scoped" ON "public"."budgets";

CREATE POLICY "budgets_select_org_scoped" ON "public"."budgets"
  FOR SELECT TO "authenticated"
  USING (
    "core"."same_org"("organization_id") AND (
      "core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT') OR "core"."has_role"('VIEWER')
      OR ("user_id" = "auth"."uid"())
      OR ("project_id" IS NOT NULL AND EXISTS (SELECT 1 FROM "public"."projects" "p" WHERE "p"."id" = "budgets"."project_id" AND "p"."user_id" = "auth"."uid"()))
    )
  );

CREATE POLICY "budgets_insert_org_scoped" ON "public"."budgets"
  FOR INSERT TO "authenticated"
  WITH CHECK ("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT') OR ("user_id" = "auth"."uid"())));

CREATE POLICY "budgets_update_org_scoped" ON "public"."budgets"
  FOR UPDATE TO "authenticated"
  USING ("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT') OR (("user_id" = "auth"."uid"()) AND "status" = 'DRAFT')))
  WITH CHECK ("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT') OR (("user_id" = "auth"."uid"()) AND "status" = 'DRAFT')));

-- -----------------------------------------------------------------------
-- 4. public.projects -- consolidate 4 overlapping policies into 4 clean,
--    organization- and role-scoped ones (see header note (b))
-- -----------------------------------------------------------------------

DROP POLICY IF EXISTS "All users can view projects" ON "public"."projects";
DROP POLICY IF EXISTS "Users can manage own projects" ON "public"."projects";
DROP POLICY IF EXISTS "projects_modify" ON "public"."projects";
DROP POLICY IF EXISTS "projects_select" ON "public"."projects";

CREATE POLICY "projects_select_org_scoped" ON "public"."projects"
  FOR SELECT TO "authenticated"
  USING (
    "core"."same_org"("organization_id") AND (
      "core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT') OR "core"."has_role"('VIEWER')
      OR "core"."has_role"('PROJECT_MANAGER') OR ("user_id" = "auth"."uid"())
    )
  );

CREATE POLICY "projects_insert_org_scoped" ON "public"."projects"
  FOR INSERT TO "authenticated"
  WITH CHECK (
    "core"."same_org"("organization_id") AND (
      "core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT') OR "core"."has_role"('PROJECT_MANAGER')
      OR ("user_id" = "auth"."uid"())
    )
  );

CREATE POLICY "projects_update_org_scoped" ON "public"."projects"
  FOR UPDATE TO "authenticated"
  USING ("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR ("user_id" = "auth"."uid"()) OR "public"."is_admin"()))
  WITH CHECK ("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR ("user_id" = "auth"."uid"()) OR "public"."is_admin"()));

CREATE POLICY "projects_delete_org_scoped" ON "public"."projects"
  FOR DELETE TO "authenticated"
  USING ("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR ("user_id" = "auth"."uid"()) OR "public"."is_admin"()));

-- -----------------------------------------------------------------------
-- 5. public.clients -- CRITICAL: replace the four USING(true)/no-TO-clause
--    policies (see header note (a)) with organization- and role-scoped,
--    authenticated-only policies.
-- -----------------------------------------------------------------------

DROP POLICY IF EXISTS "clients_select" ON "public"."clients";
DROP POLICY IF EXISTS "clients_insert" ON "public"."clients";
DROP POLICY IF EXISTS "clients_update" ON "public"."clients";
DROP POLICY IF EXISTS "clients_delete" ON "public"."clients";

CREATE POLICY "clients_select_org_scoped" ON "public"."clients"
  FOR SELECT TO "authenticated"
  USING (
    "core"."same_org"("organization_id") AND (
      "core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT') OR "core"."has_role"('VIEWER')
      OR "core"."has_role"('PROJECT_MANAGER') OR ("user_id" = "auth"."uid"())
    )
  );

CREATE POLICY "clients_insert_org_scoped" ON "public"."clients"
  FOR INSERT TO "authenticated"
  WITH CHECK ("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT')));

CREATE POLICY "clients_update_org_scoped" ON "public"."clients"
  FOR UPDATE TO "authenticated"
  USING ("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT')))
  WITH CHECK ("core"."same_org"("organization_id") AND ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT')));

CREATE POLICY "clients_delete_org_scoped" ON "public"."clients"
  FOR DELETE TO "authenticated"
  USING ("core"."same_org"("organization_id") AND "core"."is_finance_head"());

-- Defense-in-depth: this table no longer has any policy that applies to
-- anon (all four are now `TO authenticated`), so RLS alone already blocks
-- anonymous access. Revoking the table-level grant removes the second,
-- independent layer that previously made this table reachable at all.
REVOKE ALL ON TABLE "public"."clients" FROM "anon";

-- -----------------------------------------------------------------------
-- 6. audit.audit_log -- add organization scoping to the SELECT policies
--    that grant broad (CEO/FINANCE_HEAD/AUDITOR) read access, so a future
--    multi-organization deployment cannot see another organization's audit
--    trail. Per-own-record policies (audit_log_select_own/_limited/
--    _accountant) already filter by user_id, which is a stricter condition
--    than organization_id, so they are left as-is; INSERT/UPDATE/DELETE
--    policies are unrelated to this fix and are also left as-is.
-- -----------------------------------------------------------------------

DROP POLICY IF EXISTS "audit_log_select_full" ON "audit"."audit_log";
DROP POLICY IF EXISTS "audit_log_select_auditor" ON "audit"."audit_log";

CREATE POLICY "audit_log_select_full" ON "audit"."audit_log"
  FOR SELECT TO "authenticated"
  USING (
    "core"."same_org"("organization_id") AND EXISTS (
      SELECT 1 FROM "core"."user_roles" "ur" JOIN "core"."roles" "r" ON "r"."id" = "ur"."role_id"
      WHERE "ur"."user_id" = "auth"."uid"() AND "ur"."is_active" = true
        AND "r"."name" = ANY (ARRAY['CEO','FINANCE_HEAD'])
        AND ("ur"."effective_to" IS NULL OR "ur"."effective_to" >= CURRENT_DATE)
    )
  );

CREATE POLICY "audit_log_select_auditor" ON "audit"."audit_log"
  FOR SELECT TO "authenticated"
  USING (
    "core"."same_org"("organization_id") AND EXISTS (
      SELECT 1 FROM "core"."user_roles" "ur" JOIN "core"."roles" "r" ON "r"."id" = "ur"."role_id"
      WHERE "ur"."user_id" = "auth"."uid"() AND "ur"."is_active" = true
        AND "r"."name" = 'AUDITOR'
        AND ("ur"."effective_to" IS NULL OR "ur"."effective_to" >= CURRENT_DATE)
    )
  );

-- -----------------------------------------------------------------------
-- 7. audit.trigger_audit_log() -- populate organization_id on every new
--    audit event going forward, so migration 038's index and this
--    migration's org-scoped SELECT policies have real data to filter on
--    for all future activity (migration 036 already backfilled history).
-- -----------------------------------------------------------------------

CREATE OR REPLACE FUNCTION "audit"."trigger_audit_log"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'audit', 'public'
    AS $$
DECLARE
    v_old JSONB;
    v_new JSONB;
    v_columns TEXT[] := ARRAY[]::TEXT[];
    v_action TEXT;
    v_user_id UUID;
    v_user_email TEXT;
    v_user_name TEXT;
    v_role TEXT;
    v_organization_id UUID;
    v_key TEXT;
    v_prev_hash TEXT;
    v_hash TEXT;
    v_row JSONB;
    v_project_id UUID;
    v_amount NUMERIC;
    v_amount_currency TEXT;
BEGIN
    v_action := TG_OP;

    v_user_id := COALESCE(
        auth.uid(),
        NULLIF(current_setting('request.jwt.claims.sub', true), '')::UUID,
        NULLIF(current_setting('app.current_user_id', true), '')::UUID,
        NULL
    );

    IF v_user_id IS NOT NULL THEN
        SELECT email, full_name INTO v_user_email, v_user_name
        FROM public.profiles WHERE id = v_user_id;

        -- Migration 039: organization_id, looked up correctly via user_id
        -- (the pre-existing email/full_name lookup above uses `id =
        -- v_user_id`, which is a separate known issue -- public.profiles.id
        -- is not the same column as public.profiles.user_id -- left
        -- unchanged here since fixing it is outside this migration's scope
        -- and is not something Finding 4.1/4.5 asked for; flagged in the
        -- accompanying report as a manual follow-up item).
        SELECT organization_id INTO v_organization_id
        FROM public.profiles WHERE user_id = v_user_id;

        SELECT r.name INTO v_role
        FROM core.user_roles ur
        JOIN core.roles r ON r.id = ur.role_id
        WHERE ur.user_id = v_user_id AND ur.is_active = true
          AND (ur.effective_to IS NULL OR ur.effective_to >= CURRENT_DATE)
        ORDER BY ur.effective_from DESC LIMIT 1;
    END IF;

    IF TG_OP = 'INSERT' THEN
        v_new := to_jsonb(NEW);
        v_old := NULL;
        v_columns := NULL;
        v_row := v_new;
    ELSIF TG_OP = 'UPDATE' THEN
        v_old := to_jsonb(OLD);
        v_new := to_jsonb(NEW);
        v_row := v_new;

        FOR v_key IN
            SELECT k FROM (
                SELECT jsonb_object_keys(v_new) AS k
                UNION
                SELECT jsonb_object_keys(v_old) AS k
            ) all_keys
        LOOP
            IF v_old ->> v_key IS DISTINCT FROM v_new ->> v_key THEN
                v_columns := array_append(v_columns, v_key);
            END IF;
        END LOOP;

        IF array_length(v_columns, 1) IS NULL THEN
            RETURN NEW;
        END IF;

        IF v_old ? 'status' AND v_new ? 'status' AND v_old->>'status' != v_new->>'status' THEN
            v_action := 'STATUS_CHANGE';
        END IF;
    ELSIF TG_OP = 'DELETE' THEN
        v_old := to_jsonb(OLD);
        v_new := NULL;
        v_columns := NULL;
        v_row := v_old;
    END IF;

    BEGIN
        IF v_row ? 'project_id' THEN
            v_project_id := NULLIF(v_row->>'project_id','')::UUID;
        END IF;
    EXCEPTION WHEN OTHERS THEN v_project_id := NULL;
    END;

    -- Migration 039: prefer the audited row's own organization_id when the
    -- table being audited has one (now true for invoices/expenses/projects/
    -- budgets/clients per migration 036, and already true for most finance.*
    -- tables) -- falls back to the acting user's organization otherwise.
    BEGIN
        IF v_row ? 'organization_id' AND v_row->>'organization_id' IS NOT NULL THEN
            v_organization_id := (v_row->>'organization_id')::UUID;
        END IF;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;

    BEGIN
        IF v_row ? 'amount' THEN
            v_amount := NULLIF(v_row->>'amount','')::NUMERIC;
        ELSIF v_row ? 'total_amount' THEN
            v_amount := NULLIF(v_row->>'total_amount','')::NUMERIC;
        ELSIF v_row ? 'gross_amount' THEN
            v_amount := NULLIF(v_row->>'gross_amount','')::NUMERIC;
        ELSIF v_row ? 'base_amount' THEN
            v_amount := NULLIF(v_row->>'base_amount','')::NUMERIC;
        END IF;
    EXCEPTION WHEN OTHERS THEN v_amount := NULL;
    END;

    IF v_row ? 'currency' THEN
        v_amount_currency := v_row->>'currency';
    END IF;

    SELECT entry_hash INTO v_prev_hash
    FROM audit.audit_log ORDER BY created_at DESC, id DESC LIMIT 1;

    v_hash := encode(
        extensions.digest(
            (
                COALESCE(v_prev_hash, '') ||
                COALESCE(v_user_id::TEXT, '') || TG_OP || TG_TABLE_NAME ||
                COALESCE(NEW.id::TEXT, OLD.id::TEXT, '') || NOW()::TEXT
            )::bytea,
            'sha256'
        ),
        'hex'
    );

    INSERT INTO audit.audit_log (
        user_id, user_email, user_name, role_snapshot, organization_id,
        action, entity_type, entity_id, status, severity,
        description, old_values, new_values, changed_columns,
        previous_status, new_status,
        project_id, amount, amount_currency,
        ip_address, user_agent,
        source_module, source_schema, source_table,
        table_schema, table_name, record_id, changed_by,
        prev_hash, entry_hash
    ) VALUES (
        v_user_id, v_user_email, v_user_name, v_role, v_organization_id,
        v_action, TG_TABLE_NAME, COALESCE(NEW.id, OLD.id), 'success', 'info',
        TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME || ' ' || v_action,
        v_old, v_new, v_columns,
        CASE WHEN TG_OP = 'UPDATE' THEN v_old->>'status' END,
        CASE WHEN TG_OP = 'UPDATE' THEN v_new->>'status' END,
        v_project_id, v_amount, v_amount_currency,
        inet_client_addr(),
        current_setting('request.header.user-agent', true),
        TG_TABLE_SCHEMA, TG_TABLE_SCHEMA, TG_TABLE_NAME,
        TG_TABLE_SCHEMA, TG_TABLE_NAME, COALESCE(NEW.id, OLD.id), v_user_id,
        v_prev_hash, v_hash
    );

    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END;
$$;

ALTER FUNCTION "audit"."trigger_audit_log"() OWNER TO "postgres";

COMMENT ON FUNCTION "audit"."trigger_audit_log"() IS 'Migration 039: now populates audit_log.organization_id (prefers the audited row''s own organization_id, falls back to the acting user''s) so Finding 4.5''s org-scoped SELECT policies have data to filter on for all future events. No other behavior changed from the migration 030 version (same hash chaining, same columns).';

COMMIT;
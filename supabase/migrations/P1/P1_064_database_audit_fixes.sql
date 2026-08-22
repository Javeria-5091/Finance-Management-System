-- =====================================================================
-- P1_064_database_audit_fixes.sql
-- =====================================================================
-- Purpose : Resolve the "Database" section findings (DB-001 .. DB-041)
--           from OSYSTIC-FIN-AUDIT-001, verified line-by-line against
--           the actual schema.sql (17,703 lines) supplied on
--           22 Aug 2026 -- NOT written blindly off the audit text.
--
-- Safety design:
--   - Every statement is idempotent (safe to run twice).
--   - No statement silently deletes/truncates data.
--   - Where a full backfill/NOT NULL cannot be done safely without
--     seeing live data, we use NOT VALID CHECK constraints (blocks
--     new bad rows, does not touch/break existing rows) instead of
--     a hard NOT NULL, and we say so in a comment.
--   - Three audit items were verified to be FALSE POSITIVES or
--     ALREADY FIXED and are deliberately NOT "fixed" again here,
--     because doing so would break working code:
--       * DB-016 (tax_* org FK) -> intentional design, see note below.
--       * DB-024 (ai_model_registry/ai_prompt_versions policies) ->
--         these tables have no tenant dimension at all (global
--         platform config), so USING(true) is correct, not a leak.
--       * DB-041 (public.v_payroll_summary) -> the view is defined
--         TWICE in schema.sql (line ~9470 then ~12039); the second
--         CREATE OR REPLACE already sets security_invoker=true, and
--         since CREATE OR REPLACE overwrites, that is what actually
--         exists in the live database today. Only the
--         audit.v_unsafe_security_definer_functions view genuinely
--         needed the fix, so that one is included below.
--   - DB-015 (numeric precision), DB-017 (unique external-tx-id
--     columns), DB-020 (payments FK ON DELETE), DB-030 (status
--     transition constraints), and blanket NOT NULL across "35+
--     tables" (DB-014) are NOT auto-fixed here because they require
--     either a business decision or a live-data-informed backfill
--     that could silently corrupt/reject real rows if guessed wrong.
--     See DATABASE_AUDIT_FIX_NOTES.md for exactly what to do for each.
--
-- Run this as a single transaction against your Supabase project
-- (SQL editor, or `supabase db push` / psql). Take a schema backup
-- first as usual.
-- =====================================================================

BEGIN;

-- =====================================================================
-- DB-001 [CRITICAL] finance.payment_allocations RLS -- no same_org filter
-- =====================================================================
-- payment_allocations has NO organization_id column of its own; tenancy
-- is derived via invoice_id (invoices.organization_id is NOT NULL) and
-- payment_receipt_id (payment_receipts.organization_id is NULLABLE, so
-- same_org() fails closed if it's not set -- correct, matches the
-- pattern already used for finance.vendor_payment_allocations).

DROP POLICY IF EXISTS "pa_insert" ON "finance"."payment_allocations";
DROP POLICY IF EXISTS "pa_select" ON "finance"."payment_allocations";
DROP POLICY IF EXISTS "pa_update" ON "finance"."payment_allocations";
DROP POLICY IF EXISTS "pa_delete" ON "finance"."payment_allocations";

CREATE POLICY "pa_insert" ON "finance"."payment_allocations"
  FOR INSERT WITH CHECK (
    (core.is_finance_head() OR core.has_role('ACCOUNTANT'))
    AND EXISTS (
      SELECT 1 FROM public.invoices i
      WHERE i.id = payment_allocations.invoice_id
        AND core.same_org(i.organization_id)
    )
    AND EXISTS (
      SELECT 1 FROM finance.payment_receipts pr
      WHERE pr.id = payment_allocations.payment_receipt_id
        AND core.same_org(pr.organization_id)
    )
  );

CREATE POLICY "pa_select" ON "finance"."payment_allocations"
  FOR SELECT USING (
    (core.is_finance_head() OR core.has_role('ACCOUNTANT') OR core.has_role('VIEWER'))
    AND EXISTS (
      SELECT 1 FROM public.invoices i
      WHERE i.id = payment_allocations.invoice_id
        AND core.same_org(i.organization_id)
    )
  );

CREATE POLICY "pa_update" ON "finance"."payment_allocations"
  FOR UPDATE USING (
    core.is_finance_head()
    AND EXISTS (
      SELECT 1 FROM public.invoices i
      WHERE i.id = payment_allocations.invoice_id
        AND core.same_org(i.organization_id)
    )
  ) WITH CHECK (
    core.is_finance_head()
    AND EXISTS (
      SELECT 1 FROM public.invoices i
      WHERE i.id = payment_allocations.invoice_id
        AND core.same_org(i.organization_id)
    )
  );

CREATE POLICY "pa_delete" ON "finance"."payment_allocations"
  FOR DELETE USING (
    core.is_finance_head()
    AND EXISTS (
      SELECT 1 FROM public.invoices i
      WHERE i.id = payment_allocations.invoice_id
        AND core.same_org(i.organization_id)
    )
  );


-- =====================================================================
-- DB-002 / DB-023 [CRITICAL/HIGH] audit.data_access_events / export_events
-- / security_events -- no organization_id column, cross-tenant SELECT
-- =====================================================================

ALTER TABLE audit.data_access_events ADD COLUMN IF NOT EXISTS organization_id uuid;
ALTER TABLE audit.export_events      ADD COLUMN IF NOT EXISTS organization_id uuid;
ALTER TABLE audit.security_events    ADD COLUMN IF NOT EXISTS organization_id uuid;

-- Backfill from the acting user's current profile where possible.
-- (Historical rows whose user has since left/changed org will stay
-- NULL -- same_org() fails closed for those, i.e. they simply won't
-- show up to anyone via the tightened policy below. No data is lost;
-- service_role can still read everything.)
UPDATE audit.data_access_events e
SET organization_id = p.organization_id
FROM public.profiles p
WHERE e.user_id = p.user_id AND e.organization_id IS NULL;

UPDATE audit.export_events e
SET organization_id = p.organization_id
FROM public.profiles p
WHERE e.user_id = p.user_id AND e.organization_id IS NULL;

UPDATE audit.security_events e
SET organization_id = p.organization_id
FROM public.profiles p
WHERE e.user_id = p.user_id AND e.organization_id IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'data_access_events_org_fkey'
  ) THEN
    ALTER TABLE audit.data_access_events
      ADD CONSTRAINT data_access_events_org_fkey
      FOREIGN KEY (organization_id) REFERENCES core.organizations(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'export_events_org_fkey'
  ) THEN
    ALTER TABLE audit.export_events
      ADD CONSTRAINT export_events_org_fkey
      FOREIGN KEY (organization_id) REFERENCES core.organizations(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'security_events_org_fkey'
  ) THEN
    ALTER TABLE audit.security_events
      ADD CONSTRAINT security_events_org_fkey
      FOREIGN KEY (organization_id) REFERENCES core.organizations(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_data_access_events_org ON audit.data_access_events(organization_id);
CREATE INDEX IF NOT EXISTS idx_export_events_org ON audit.export_events(organization_id);
CREATE INDEX IF NOT EXISTS idx_security_events_org ON audit.security_events(organization_id);

-- Tighten INSERT: caller must stamp their own org (or leave NULL only
-- if they truly have none) and their own user_id. Also close the
-- WITH CHECK (true) gap (DB-023).
DROP POLICY IF EXISTS "data_access_insert" ON audit.data_access_events;
CREATE POLICY "data_access_insert" ON audit.data_access_events
  FOR INSERT TO authenticated
  WITH CHECK (
    (user_id IS NULL OR user_id = auth.uid())
    AND (organization_id IS NULL OR core.same_org(organization_id))
  );

DROP POLICY IF EXISTS "export_events_insert" ON audit.export_events;
CREATE POLICY "export_events_insert" ON audit.export_events
  FOR INSERT TO authenticated
  WITH CHECK (
    (user_id IS NULL OR user_id = auth.uid())
    AND (organization_id IS NULL OR core.same_org(organization_id))
  );

-- Tighten SELECT: role check AND same_org (previously role check only).
DROP POLICY IF EXISTS "data_access_select" ON audit.data_access_events;
CREATE POLICY "data_access_select" ON audit.data_access_events
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM core.user_roles ur JOIN core.roles r ON r.id = ur.role_id
      WHERE ur.user_id = auth.uid() AND ur.is_active = true
        AND r.name = ANY (ARRAY['CEO','FINANCE_HEAD','AUDITOR'])
        AND (ur.effective_to IS NULL OR ur.effective_to >= CURRENT_DATE)
    )
    AND (organization_id IS NULL OR core.same_org(organization_id))
  );

DROP POLICY IF EXISTS "export_events_select" ON audit.export_events;
CREATE POLICY "export_events_select" ON audit.export_events
  FOR SELECT TO authenticated
  USING (
    (
      EXISTS (
        SELECT 1 FROM core.user_roles ur JOIN core.roles r ON r.id = ur.role_id
        WHERE ur.user_id = auth.uid() AND ur.is_active = true
          AND r.name = ANY (ARRAY['CEO','FINANCE_HEAD','AUDITOR'])
          AND (ur.effective_to IS NULL OR ur.effective_to >= CURRENT_DATE)
      )
      AND (organization_id IS NULL OR core.same_org(organization_id))
    )
    OR user_id = auth.uid()
  );

DROP POLICY IF EXISTS "sec_events_select" ON audit.security_events;
CREATE POLICY "sec_events_select" ON audit.security_events
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM core.user_roles ur JOIN core.roles r ON r.id = ur.role_id
      WHERE ur.user_id = auth.uid() AND ur.is_active = true
        AND r.name = ANY (ARRAY['CEO','FINANCE_HEAD','AUDITOR','TECH_ADMIN'])
        AND (ur.effective_to IS NULL OR ur.effective_to >= CURRENT_DATE)
    )
    AND (organization_id IS NULL OR core.same_org(organization_id))
  );
-- (sec_events_insert already checks user_id correctly -- untouched.)


-- =====================================================================
-- DB-003 [CRITICAL] core.idempotency_keys -- no organization_id, global
-- unique(scope,key) cache leak across tenants
-- =====================================================================

ALTER TABLE core.idempotency_keys ADD COLUMN IF NOT EXISTS organization_id uuid;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'idempotency_keys_unique') THEN
    ALTER TABLE core.idempotency_keys DROP CONSTRAINT idempotency_keys_unique;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'idempotency_keys_org_fkey') THEN
    ALTER TABLE core.idempotency_keys
      ADD CONSTRAINT idempotency_keys_org_fkey
      FOREIGN KEY (organization_id) REFERENCES core.organizations(id) ON DELETE CASCADE;
  END IF;
END $$;

-- Existing rows with organization_id still NULL cannot be assigned an
-- org retroactively from this table alone (it has no user_id/actor
-- column to backfill from). They are cleared here because a shared,
-- unscoped idempotency cache is unsafe to keep -- any cached response
-- under a NULL-org key could still be replayed cross-tenant otherwise.
-- This just means the next request with that idempotency key will be
-- treated as a fresh request (safe fail-open on caching, not on data).
DELETE FROM core.idempotency_keys WHERE organization_id IS NULL;

ALTER TABLE core.idempotency_keys ALTER COLUMN organization_id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'idempotency_keys_unique') THEN
    ALTER TABLE core.idempotency_keys
      ADD CONSTRAINT idempotency_keys_unique UNIQUE (scope, key, organization_id);
  END IF;
END $$;


-- =====================================================================
-- DB-004 [CRITICAL] core.soft_delete() -- SECURITY DEFINER, no org check
-- =====================================================================

CREATE OR REPLACE FUNCTION core.soft_delete(p_schema text, p_table text, p_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $_$
DECLARE
  v_org uuid := core.current_user_org_id();
  v_rows int;
BEGIN
  IF p_schema NOT IN ('finance', 'public') OR
     p_table NOT IN ('chart_of_accounts', 'vendors', 'clients', 'projects',
                      'platforms', 'financial_accounts') THEN
    RAISE EXCEPTION 'core.soft_delete: table %.% is not an approved soft-delete target', p_schema, p_table;
  END IF;

  IF v_org IS NULL THEN
    RAISE EXCEPTION 'core.soft_delete: caller has no resolvable organization';
  END IF;

  IF p_schema = 'public' AND p_table = 'financial_accounts' THEN
    UPDATE public.financial_accounts
    SET deleted_at = now(), deleted_by = auth.uid(), status = 'INACTIVE'
    WHERE id = p_id AND deleted_at IS NULL AND organization_id = v_org;
  ELSIF p_schema = 'public' AND p_table = 'projects' THEN
    UPDATE public.projects
    SET deleted_at = now(), deleted_by = auth.uid()
    WHERE id = p_id AND deleted_at IS NULL AND organization_id = v_org;
  ELSIF p_schema = 'public' AND p_table = 'clients' THEN
    UPDATE public.clients
    SET deleted_at = now(), deleted_by = auth.uid(), status = 'INACTIVE'
    WHERE id = p_id AND deleted_at IS NULL AND organization_id = v_org;
  ELSE
    EXECUTE format(
      'UPDATE %I.%I SET deleted_at = now(), deleted_by = auth.uid(), is_active = false WHERE id = $1 AND deleted_at IS NULL AND organization_id = $2',
      p_schema, p_table
    ) USING p_id, v_org;
  END IF;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RAISE EXCEPTION 'core.soft_delete: no matching row % in %.% for caller''s organization (already deleted, wrong org, or does not exist)', p_id, p_schema, p_table;
  END IF;
END;
$_$;


-- =====================================================================
-- DB-005 / DB-006 [CRITICAL] anon grants on privilege-sensitive RPCs
-- =====================================================================

REVOKE ALL ON FUNCTION public.get_user_permissions(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.ensure_profile_exists(uuid) FROM anon;

CREATE OR REPLACE FUNCTION public.get_user_permissions(p_user_id uuid)
RETURNS TABLE(code text, module text, action text, data_scope text, amount_limit numeric)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Access denied: authentication required';
  END IF;
  -- A caller may fetch their own permission set, or an ADMIN_USERS
  -- holder may look up someone else's -- both still resolved via
  -- core.get_user_permissions, which is itself org/user scoped.
  IF p_user_id <> auth.uid() AND NOT core.has_permission(auth.uid(), 'ADMIN_USERS') THEN
    RAISE EXCEPTION 'Access denied: cannot read another user''s permissions';
  END IF;
  RETURN QUERY SELECT * FROM core.get_user_permissions(p_user_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.ensure_profile_exists(target_user_id uuid) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE
  v_profile_id UUID;
  v_email TEXT;
BEGIN
  -- Self-service only: a user may only ensure their OWN profile exists.
  -- (Admin-initiated user creation is a separate, permission-gated path.)
  IF auth.uid() IS NULL OR auth.uid() <> target_user_id THEN
    RAISE EXCEPTION 'Access denied: ensure_profile_exists may only be called for the current user';
  END IF;

  SELECT id INTO v_profile_id FROM public.profiles WHERE user_id = target_user_id;
  IF v_profile_id IS NOT NULL THEN
    RETURN v_profile_id;
  END IF;

  SELECT email INTO v_email FROM auth.users WHERE id = target_user_id;

  INSERT INTO public.profiles (user_id, email, full_name, role)
  VALUES (target_user_id, v_email, '', 'EMPLOYEE')
  RETURNING id INTO v_profile_id;

  RETURN v_profile_id;
END;
$$;


-- =====================================================================
-- DB-007 [CRITICAL] ai.ai_conversations / ai_messages / ai_query_audit /
-- ai_tool_calls SELECT policies -- missing same_org filter
-- =====================================================================

DROP POLICY IF EXISTS "read_ai_conversations" ON ai.ai_conversations;
CREATE POLICY "read_ai_conversations" ON ai.ai_conversations
  FOR SELECT USING (
    (user_id = auth.uid() AND core.same_org(organization_id))
    OR (
      EXISTS (
        SELECT 1 FROM core.user_roles ur JOIN core.roles r ON r.id = ur.role_id
        WHERE ur.user_id = auth.uid()
          AND r.name = ANY (ARRAY['CEO','FINANCE_HEAD','AUDITOR','Admin'])
          AND ur.effective_from <= now()
          AND (ur.effective_to IS NULL OR ur.effective_to >= now())
      )
      AND core.same_org(organization_id)
    )
  );

DROP POLICY IF EXISTS "read_ai_messages" ON ai.ai_messages;
CREATE POLICY "read_ai_messages" ON ai.ai_messages
  FOR SELECT USING (
    conversation_id IN (
      SELECT c.id FROM ai.ai_conversations c
      WHERE c.user_id = auth.uid() AND core.same_org(c.organization_id)
    )
    OR (
      EXISTS (
        SELECT 1 FROM core.user_roles ur JOIN core.roles r ON r.id = ur.role_id
        WHERE ur.user_id = auth.uid()
          AND r.name = ANY (ARRAY['CEO','FINANCE_HEAD','AUDITOR','Admin'])
          AND ur.effective_from <= now()
          AND (ur.effective_to IS NULL OR ur.effective_to >= now())
      )
      AND conversation_id IN (
        SELECT c.id FROM ai.ai_conversations c WHERE core.same_org(c.organization_id)
      )
    )
  );

DROP POLICY IF EXISTS "read_ai_query_audit" ON ai.ai_query_audit;
CREATE POLICY "read_ai_query_audit" ON ai.ai_query_audit
  FOR SELECT USING (
    (user_id = auth.uid() AND core.same_org(organization_id))
    OR (
      EXISTS (
        SELECT 1 FROM core.user_roles ur JOIN core.roles r ON r.id = ur.role_id
        WHERE ur.user_id = auth.uid()
          AND r.name = ANY (ARRAY['CEO','FINANCE_HEAD','AUDITOR','Admin'])
          AND ur.effective_from <= now()
          AND (ur.effective_to IS NULL OR ur.effective_to >= now())
      )
      AND core.same_org(organization_id)
    )
  );

DROP POLICY IF EXISTS "read_ai_tool_calls" ON ai.ai_tool_calls;
CREATE POLICY "read_ai_tool_calls" ON ai.ai_tool_calls
  FOR SELECT USING (
    (user_id = auth.uid() AND core.same_org(organization_id))
    OR (
      EXISTS (
        SELECT 1 FROM core.user_roles ur JOIN core.roles r ON r.id = ur.role_id
        WHERE ur.user_id = auth.uid()
          AND r.name = ANY (ARRAY['CEO','FINANCE_HEAD','AUDITOR','Admin'])
          AND ur.effective_from <= now()
          AND (ur.effective_to IS NULL OR ur.effective_to >= now())
      )
      AND core.same_org(organization_id)
    )
  );


-- =====================================================================
-- DB-008 [HIGH] finance.numbering_sequences.organization_id nullable +
-- unique index omits org (two orgs collide on the same document counter)
-- =====================================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'idx_ns_type_fy_unique') THEN
    DROP INDEX IF EXISTS finance.idx_ns_type_fy_unique;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_ns_type_fy_org_unique
  ON finance.numbering_sequences
  USING btree (organization_id, sequence_type, COALESCE(fiscal_year_id::text, 'GLOBAL'));

-- organization_id is left NULLABLE here deliberately: rows that are
-- still NULL cannot be safely assigned to a specific org from this
-- table alone (a counter row does not say who created it). A NOT VALID
-- check blocks any *new/updated* row from being created without an
-- org, without touching legacy rows or breaking existing counters.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'numbering_sequences_org_required_going_forward'
  ) THEN
    ALTER TABLE finance.numbering_sequences
      ADD CONSTRAINT numbering_sequences_org_required_going_forward
      CHECK (organization_id IS NOT NULL) NOT VALID;
  END IF;
END $$;


-- =====================================================================
-- DB-009 [HIGH] profiles_role_check excludes roles used by app code
-- =====================================================================
-- Extends the allow-list rather than removing app code's use of these
-- roles (safer: does not change any existing behavior, only stops
-- silently rejecting valid role assignments the code already expects).

ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_role_check;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_role_check
  CHECK (role = ANY (ARRAY[
    'CEO','FINANCE_HEAD','ACCOUNTANT','PROJECT_MANAGER','EMPLOYEE','VIEWER',
    'Admin','AUDITOR','HOD','TECHNICAL_ADMIN'
  ]));


-- =====================================================================
-- DB-010 [HIGH] journal_lines.base_debit/base_credit nullable for
-- POSTED multi-currency entries
-- =====================================================================
-- A hard NOT NULL would break DRAFT-stage rows that haven't been
-- through the currency-conversion step yet. Instead: require it only
-- once the parent journal_entries row is POSTED.

CREATE OR REPLACE FUNCTION finance.enforce_base_amounts_on_post() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM finance.journal_entries je
    WHERE je.id = NEW.journal_entry_id AND je.status = 'POSTED'
  ) AND (NEW.base_debit IS NULL OR NEW.base_credit IS NULL) THEN
    RAISE EXCEPTION 'journal_lines.base_debit/base_credit must be set before a journal entry can be POSTED (line %)', NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_base_amounts_on_post ON finance.journal_lines;
CREATE CONSTRAINT TRIGGER trg_enforce_base_amounts_on_post
  AFTER INSERT OR UPDATE ON finance.journal_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION finance.enforce_base_amounts_on_post();


-- =====================================================================
-- DB-011 [HIGH] no minimum-2-lines-per-journal-entry constraint --
-- a 0-line journal currently passes check_journal_balance() trivially
-- =====================================================================

CREATE OR REPLACE FUNCTION finance.check_journal_balance() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_journal_id uuid;
  v_total_debit numeric(18,2);
  v_total_credit numeric(18,2);
  v_total_base_debit numeric(18,2);
  v_total_base_credit numeric(18,2);
  v_line_count integer;
  v_status text;
BEGIN
  v_journal_id := COALESCE(NEW.journal_entry_id, OLD.journal_entry_id);

  SELECT
    COALESCE(SUM(debit_amount), 0),
    COALESCE(SUM(credit_amount), 0),
    COALESCE(SUM(COALESCE(base_debit, debit_amount)), 0),
    COALESCE(SUM(COALESCE(base_credit, credit_amount)), 0),
    COUNT(*)
  INTO
    v_total_debit, v_total_credit, v_total_base_debit, v_total_base_credit, v_line_count
  FROM finance.journal_lines
  WHERE journal_entry_id = v_journal_id;

  IF v_total_debit <> v_total_credit THEN
    RAISE EXCEPTION
      'Journal entry % is unbalanced in transaction currency: debit % != credit %',
      v_journal_id, v_total_debit, v_total_credit
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_total_base_debit <> v_total_base_credit THEN
    RAISE EXCEPTION
      'Journal entry % is unbalanced in base (PKR) currency: base debit % != base credit %',
      v_journal_id, v_total_base_debit, v_total_base_credit
      USING ERRCODE = 'check_violation';
  END IF;

  -- Only require >= 2 lines once the entry is (or is being) POSTED --
  -- DRAFT entries are allowed to be built up line by line.
  SELECT status INTO v_status FROM finance.journal_entries WHERE id = v_journal_id;
  IF v_status = 'POSTED' AND v_line_count < 2 THEN
    RAISE EXCEPTION
      'Journal entry % cannot be POSTED with fewer than 2 lines (has %)',
      v_journal_id, v_line_count
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE finance.journal_entries
  SET total_debit = v_total_debit,
      total_credit = v_total_credit
  WHERE id = v_journal_id;

  RETURN NULL;
END;
$$;


-- =====================================================================
-- DB-012 [HIGH] core.roles UNIQUE(name) is global -- blocks orgs from
-- ever having a custom role with the same name as another org's
-- =====================================================================

ALTER TABLE core.roles DROP CONSTRAINT IF EXISTS roles_name_key;

-- One unique index for global/system roles (organization_id IS NULL),
-- one for per-org custom roles.
CREATE UNIQUE INDEX IF NOT EXISTS roles_name_system_unique
  ON core.roles (name) WHERE organization_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS roles_name_org_unique
  ON core.roles (organization_id, name) WHERE organization_id IS NOT NULL;


-- =====================================================================
-- DB-018 [HIGH] validate_payment_allocation() only checks against the
-- invoice total, never against the parent payment_receipt's own total
-- =====================================================================

CREATE OR REPLACE FUNCTION finance.validate_payment_allocation() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'finance', 'public'
    AS $_$
DECLARE
  v_invoice_total       NUMERIC(18,2);
  v_invoice_allocated   NUMERIC(18,2);
  v_receipt_total       NUMERIC(18,2);
  v_receipt_allocated   NUMERIC(18,2);
BEGIN
  SELECT total_amount INTO v_invoice_total
  FROM public.invoices WHERE id = NEW.invoice_id FOR UPDATE;

  IF v_invoice_total IS NULL THEN
    RAISE EXCEPTION 'Cannot allocate payment: invoice % does not exist', NEW.invoice_id;
  END IF;

  SELECT COALESCE(SUM(allocated_amount), 0) INTO v_invoice_allocated
  FROM finance.payment_allocations
  WHERE invoice_id = NEW.invoice_id AND id IS DISTINCT FROM NEW.id;

  IF (v_invoice_allocated + NEW.allocated_amount) > v_invoice_total THEN
    RAISE EXCEPTION
      'Payment allocation of % exceeds invoice outstanding balance (already allocated %, invoice total %)',
      NEW.allocated_amount, v_invoice_allocated, v_invoice_total;
  END IF;

  -- NEW CHECK: don't let the sum of allocations against one payment
  -- receipt exceed what that receipt actually received.
  SELECT amount INTO v_receipt_total
  FROM finance.payment_receipts WHERE id = NEW.payment_receipt_id FOR UPDATE;

  IF v_receipt_total IS NULL THEN
    RAISE EXCEPTION 'Cannot allocate payment: payment receipt % does not exist', NEW.payment_receipt_id;
  END IF;

  SELECT COALESCE(SUM(allocated_amount), 0) INTO v_receipt_allocated
  FROM finance.payment_allocations
  WHERE payment_receipt_id = NEW.payment_receipt_id AND id IS DISTINCT FROM NEW.id;

  IF (v_receipt_allocated + NEW.allocated_amount) > v_receipt_total THEN
    RAISE EXCEPTION
      'Payment allocation of % exceeds the payment receipt''s own total (already allocated %, receipt total %)',
      NEW.allocated_amount, v_receipt_allocated, v_receipt_total;
  END IF;

  RETURN NEW;
END;
$_$;


-- =====================================================================
-- DB-019 [HIGH] validate_ownership_percentage_total() sums ALL owners
-- across ALL organizations together -- not org-scoped
-- =====================================================================

CREATE OR REPLACE FUNCTION finance.validate_ownership_percentage_total() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'finance', 'public'
    AS $$
DECLARE
  v_check_date DATE;
  v_total_pct  NUMERIC(6,2);
  v_org        uuid;
BEGIN
  v_check_date := COALESCE(NEW.effective_from, CURRENT_DATE);

  SELECT o.organization_id INTO v_org
  FROM finance.owners o WHERE o.id = NEW.owner_id;

  SELECT COALESCE(SUM(oh.ownership_percentage), 0) INTO v_total_pct
  FROM finance.ownership_history oh
  JOIN finance.owners o ON o.id = oh.owner_id
  WHERE o.status = 'ACTIVE'
    AND o.organization_id = v_org
    AND oh.effective_from <= v_check_date
    AND (oh.effective_to IS NULL OR oh.effective_to >= v_check_date)
    AND oh.id IS DISTINCT FROM NEW.id;

  v_total_pct := v_total_pct + NEW.ownership_percentage;

  IF v_total_pct > 100.00 THEN
    RAISE EXCEPTION 'Ownership percentages for effective date % would total %% (Current Total: %), which exceeds 100%%. Adjust or end-date an existing ownership record first.', v_check_date, v_total_pct;
  END IF;

  RETURN NEW;
END;
$$;


-- =====================================================================
-- DB-021 [HIGH] audit.log_action() never sets organization_id, and
-- trusts p_user_id unconditionally
-- =====================================================================

CREATE OR REPLACE FUNCTION audit.log_action(
    p_user_id uuid, p_user_email text DEFAULT NULL, p_user_name text DEFAULT NULL,
    p_action text DEFAULT NULL, p_entity_type text DEFAULT NULL, p_entity_id uuid DEFAULT NULL,
    p_description text DEFAULT '', p_old_values jsonb DEFAULT NULL, p_new_values jsonb DEFAULT NULL,
    p_ip_address inet DEFAULT NULL, p_user_agent text DEFAULT NULL, p_status text DEFAULT 'success',
    p_error_message text DEFAULT NULL, p_severity text DEFAULT 'info', p_reason text DEFAULT NULL,
    p_source_module text DEFAULT NULL, p_request_id text DEFAULT NULL, p_previous_status text DEFAULT NULL,
    p_new_status text DEFAULT NULL, p_approval_level text DEFAULT NULL, p_approval_comments text DEFAULT NULL,
    p_delegated_authority text DEFAULT NULL, p_limit_decision text DEFAULT NULL, p_session_id text DEFAULT NULL,
    p_auth_method text DEFAULT NULL, p_attachment_ids uuid[] DEFAULT NULL, p_import_batch_id uuid DEFAULT NULL,
    p_external_ref text DEFAULT NULL, p_related_journal_id uuid DEFAULT NULL, p_related_payment_id uuid DEFAULT NULL,
    p_project_id uuid DEFAULT NULL, p_amount numeric DEFAULT NULL, p_amount_currency text DEFAULT NULL
) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'audit', 'public'
    AS $$
DECLARE
  v_id UUID;
  v_role TEXT;
  v_org UUID;
  v_effective_user_id UUID;
  v_prev_hash TEXT;
  v_hash TEXT;
BEGIN
  -- Only service_role (no auth.uid(), acting on behalf of the system,
  -- e.g. edge functions) may log on behalf of an arbitrary user. Any
  -- authenticated caller may only log actions as themselves.
  IF auth.uid() IS NOT NULL AND p_user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'audit.log_action: p_user_id must match the calling user';
  END IF;
  v_effective_user_id := COALESCE(p_user_id, auth.uid());

  SELECT r.name INTO v_role
  FROM core.user_roles ur JOIN core.roles r ON r.id = ur.role_id
  WHERE ur.user_id = v_effective_user_id AND ur.is_active = true
    AND (ur.effective_to IS NULL OR ur.effective_to >= CURRENT_DATE)
  ORDER BY ur.effective_from DESC LIMIT 1;

  SELECT organization_id INTO v_org
  FROM public.profiles WHERE user_id = v_effective_user_id;

  SELECT entry_hash INTO v_prev_hash
  FROM audit.audit_log ORDER BY created_at DESC, id DESC LIMIT 1;

  v_hash := encode(
    sha256(
      COALESCE(v_prev_hash, '') ||
      COALESCE(v_effective_user_id::TEXT, '') || COALESCE(p_action, '') ||
      COALESCE(p_entity_type, '') || COALESCE(p_entity_id::TEXT, '') ||
      COALESCE(p_description, '') || COALESCE(p_severity, 'info') || NOW()::TEXT
    ), 'hex'
  );

  INSERT INTO audit.audit_log (
    user_id, user_email, user_name, role_snapshot, organization_id, session_id, auth_method,
    action, entity_type, entity_id, status, severity,
    ip_address, user_agent, request_id,
    description, old_values, new_values, reason, approval_comments,
    previous_status, new_status, approval_level, delegated_authority, limit_decision,
    attachment_ids, import_batch_id, external_ref, related_journal_id, related_payment_id,
    project_id, amount, amount_currency,
    source_module, error_message, prev_hash, entry_hash
  ) VALUES (
    v_effective_user_id, p_user_email, p_user_name, v_role, v_org, p_session_id, p_auth_method,
    p_action, p_entity_type, p_entity_id, p_status, p_severity,
    p_ip_address, p_user_agent, p_request_id,
    p_description, p_old_values, p_new_values, p_reason, p_approval_comments,
    p_previous_status, p_new_status, p_approval_level, p_delegated_authority, p_limit_decision,
    p_attachment_ids, p_import_batch_id, p_external_ref, p_related_journal_id, p_related_payment_id,
    p_project_id, p_amount, p_amount_currency,
    p_source_module, p_error_message, v_prev_hash, v_hash
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;


-- =====================================================================
-- DB-022 [HIGH] audit.trigger_audit_log() looks up the acting profile
-- by profiles.id instead of profiles.user_id -> user_email/user_name
-- always NULL. (organization_id lookup was already fixed in migration
-- 039 and is left untouched.)
-- =====================================================================

CREATE OR REPLACE FUNCTION audit.trigger_audit_log() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'audit', 'public'
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
        -- FIX (DB-022): was `WHERE id = v_user_id`; profiles.id is the
        -- profile row's own PK, not the auth user id. Must join on
        -- user_id, exactly as the organization_id lookup below already
        -- (correctly) does.
        SELECT email, full_name, organization_id INTO v_user_email, v_user_name, v_organization_id
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

    -- (unchanged from migration 039): prefer the audited row's own
    -- organization_id when the table being audited has one.
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


-- =====================================================================
-- DB-025 [HIGH] core.roles SELECT policy hides global/system roles
-- (organization_id IS NULL) because same_org() fails closed on NULL
-- =====================================================================

DROP POLICY IF EXISTS "role_select" ON core.roles;
CREATE POLICY "role_select" ON core.roles
  FOR SELECT USING (
    auth.uid() IS NOT NULL
    AND (organization_id IS NULL OR core.same_org(organization_id))
  );


-- =====================================================================
-- DB-026 [HIGH] AUDITOR / TECH_ADMIN / TECHNICAL_ADMIN / Admin roles
-- never seeded into core.roles -- seeded here as global system roles
-- (organization_id NULL), idempotent.
-- =====================================================================

INSERT INTO core.roles (name, display_name, description, is_system, level, organization_id)
SELECT v.name, v.display_name, v.description, true, v.level, NULL
FROM (VALUES
  ('AUDITOR', 'Auditor', 'Read-only access to audit trail, security events, and financial records for compliance review.', 60),
  ('TECH_ADMIN', 'Technical Administrator', 'System/technical administration; not a finance approval role.', 90),
  ('TECHNICAL_ADMIN', 'Technical Administrator', 'System/technical administration; not a finance approval role.', 90),
  ('Admin', 'Administrator', 'Legacy administrator role referenced by application code.', 95)
) AS v(name, display_name, description, level)
WHERE NOT EXISTS (
  SELECT 1 FROM core.roles r WHERE r.name = v.name AND r.organization_id IS NULL
);


-- =====================================================================
-- DB-027 [HIGH] public.create_user_by_admin() gates on role = 'Admin',
-- which profiles_role_check previously forbade -> function was dead
-- code. Now that DB-009 allows 'Admin', switch to a real permission
-- check consistent with the rest of the system (not a bare role
-- string match), and keep it usable.
-- NOTE: this function inserts directly into auth.users, bypassing
-- Supabase Auth's normal signup flow (no identities row, no email
-- flow, etc). That is an application-design risk beyond RLS/schema
-- scope -- recommend migrating callers to the Supabase Admin API
-- instead of removing this function outright, to avoid breaking any
-- caller today.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.create_user_by_admin(
    p_email text, p_password text, p_role text DEFAULT 'EMPLOYEE', p_full_name text DEFAULT ''
) RETURNS json
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE
  v_new_user_id UUID;
BEGIN
  IF NOT core.has_permission(auth.uid(), 'ADMIN_USERS') THEN
    RETURN json_build_object('error', 'Only users with ADMIN_USERS permission can create users')::JSON;
  END IF;

  INSERT INTO auth.users (
    instance_id, id, email, encrypted_password, email_confirmed_at,
    raw_user_meta_data, created_at, updated_at, aud, role,
    confirmation_token, recovery_token, email_change_token_new, email_change, invited_at
  ) VALUES (
    '00000000-0000-0000-0000-000000000000',
    gen_random_uuid(),
    p_email,
    crypt(p_password, gen_salt('bf')),
    NOW(),
    jsonb_build_object('full_name', p_full_name),
    NOW(), NOW(),
    'authenticated', 'authenticated',
    '', '', '', '', NULL
  )
  RETURNING id INTO v_new_user_id;

  INSERT INTO public.profiles (user_id, email, full_name, role, organization_id)
  VALUES (v_new_user_id, p_email, p_full_name, p_role, core.current_user_org_id());

  RETURN json_build_object('success', true, 'message', 'User created successfully')::JSON;

EXCEPTION
  WHEN unique_violation THEN
    RETURN json_build_object('error', 'User with this email already exists')::JSON;
  WHEN OTHERS THEN
    RETURN json_build_object('error', SQLERRM)::JSON;
END;
$$;


-- =====================================================================
-- DB-028 [HIGH] public.get_all_system_users() has an ADMIN_USERS check
-- but enumerates users across ALL organizations, not just the caller's
-- =====================================================================

CREATE OR REPLACE FUNCTION public.get_all_system_users()
RETURNS TABLE(user_id uuid, email text, full_name text, profile_role text, has_profile boolean)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'core'
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
  JOIN public.profiles p ON p.user_id = u.id
  WHERE p.organization_id = core.current_user_org_id()
  ORDER BY COALESCE(p.full_name, u.email);
END;
$$;


-- =====================================================================
-- DB-029 [HIGH] integration_events idempotency unique constraint
-- excludes organization_id
-- =====================================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'integration_events_idempotency_unique') THEN
    ALTER TABLE core.integration_events DROP CONSTRAINT integration_events_idempotency_unique;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'integration_events_idempotency_unique') THEN
    ALTER TABLE core.integration_events
      ADD CONSTRAINT integration_events_idempotency_unique
      UNIQUE (organization_id, source_module, event_type, idempotency_key);
  END IF;
END $$;


-- =====================================================================
-- DB-031 [HIGH] finance.accounting_periods / dimensions / bank_transfers
-- / tax_adjustments / tax_reconciliations / tax_slabs -- INSERT/UPDATE
-- policies missing same_org() (role check only -> cross-org writes)
-- =====================================================================

DROP POLICY IF EXISTS "ap_insert" ON finance.accounting_periods;
CREATE POLICY "ap_insert" ON finance.accounting_periods
  FOR INSERT WITH CHECK (core.is_finance_head() AND core.same_org(organization_id));

DROP POLICY IF EXISTS "ap_update" ON finance.accounting_periods;
CREATE POLICY "ap_update" ON finance.accounting_periods
  FOR UPDATE USING (core.is_finance_head() AND core.same_org(organization_id))
  WITH CHECK (core.is_finance_head() AND core.same_org(organization_id));

DROP POLICY IF EXISTS "dimensions_insert" ON finance.dimensions;
CREATE POLICY "dimensions_insert" ON finance.dimensions
  FOR INSERT WITH CHECK (
    (core.is_ceo_or_admin() OR core.is_finance_head()) AND core.same_org(organization_id)
  );

DROP POLICY IF EXISTS "dimensions_update" ON finance.dimensions;
CREATE POLICY "dimensions_update" ON finance.dimensions
  FOR UPDATE USING (
    (core.is_ceo_or_admin() OR core.is_finance_head()) AND core.same_org(organization_id)
  ) WITH CHECK (
    (core.is_ceo_or_admin() OR core.is_finance_head()) AND core.same_org(organization_id)
  );

DROP POLICY IF EXISTS "bt_update_restricted" ON finance.bank_transfers;
CREATE POLICY "bt_update_restricted" ON finance.bank_transfers
  FOR UPDATE USING (
    (core.is_ceo_or_admin() OR core.is_finance_head()) AND core.same_org(organization_id)
  ) WITH CHECK (
    (core.is_ceo_or_admin() OR core.is_finance_head()) AND core.same_org(organization_id)
  );

DROP POLICY IF EXISTS "ta_update_restricted" ON finance.tax_adjustments;
CREATE POLICY "ta_update_restricted" ON finance.tax_adjustments
  FOR UPDATE USING (
    (core.is_ceo_or_admin() OR core.is_finance_head() OR core.has_role('ACCOUNTANT'))
    AND core.same_org(organization_id)
  ) WITH CHECK (
    (core.is_ceo_or_admin() OR core.is_finance_head() OR core.has_role('ACCOUNTANT'))
    AND core.same_org(organization_id)
  );

DROP POLICY IF EXISTS "tr_update_restricted" ON finance.tax_reconciliations;
CREATE POLICY "tr_update_restricted" ON finance.tax_reconciliations
  FOR UPDATE USING (
    (core.is_ceo_or_admin() OR core.is_finance_head() OR core.has_role('ACCOUNTANT'))
    AND core.same_org(organization_id)
  ) WITH CHECK (
    (core.is_ceo_or_admin() OR core.is_finance_head() OR core.has_role('ACCOUNTANT'))
    AND core.same_org(organization_id)
  );

DROP POLICY IF EXISTS "tsl_update_restricted" ON finance.tax_slabs;
CREATE POLICY "tsl_update_restricted" ON finance.tax_slabs
  FOR UPDATE USING (
    (core.is_ceo_or_admin() OR core.is_finance_head()) AND core.same_org(organization_id)
  ) WITH CHECK (
    (core.is_ceo_or_admin() OR core.is_finance_head()) AND core.same_org(organization_id)
  );

-- NOTE: finance.tax_computations / tax_credits_and_withholding /
-- tax_payments_and_refunds / tax_returns were checked separately
-- (see DB-016 note below) and already correctly scope every
-- INSERT/UPDATE/DELETE via `organization_id = core.current_user_org_config_id()`
-- -- left untouched.


-- =====================================================================
-- DB-032 / DB-033 [MEDIUM] GRANT ALL ... TO anon on reporting RPCs and
-- 50+ public tables -- RLS is the real gate, but anon should not hold
-- table/function privileges at all (defense in depth).
-- =====================================================================

DO $$
DECLARE
  r RECORD;
BEGIN
  -- Revoke anon's ALL privileges on every table in public/finance/core/
  -- ai/audit/legacy/reporting -- authenticated + service_role retain
  -- their existing grants untouched.
  FOR r IN
    SELECT table_schema, table_name
    FROM information_schema.role_table_grants
    WHERE grantee = 'anon'
      AND table_schema IN ('public','finance','core','ai','audit','legacy','reporting')
  LOOP
    EXECUTE format('REVOKE ALL ON TABLE %I.%I FROM anon', r.table_schema, r.table_name);
  END LOOP;

  -- Revoke anon's EXECUTE on every function in those schemas too
  -- (covers DB-032's balance_sheet/cash_flow/profit_and_loss grants
  -- and anything else granted to anon).
  FOR r IN
    SELECT n.nspname AS schema_name, p.oid::regprocedure::text AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname IN ('public','finance','core','ai','audit','legacy','reporting')
      AND has_function_privilege('anon', p.oid, 'EXECUTE')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', r.sig);
  END LOOP;
END $$;


-- =====================================================================
-- DB-034 [MEDIUM] GRANT ALL ON SCHEMA core, finance TO authenticated
-- includes CREATE -- authenticated app users should never be able to
-- create/alter objects in these schemas.
-- =====================================================================

REVOKE CREATE ON SCHEMA core FROM authenticated;
REVOKE CREATE ON SCHEMA finance FROM authenticated;
REVOKE CREATE ON SCHEMA core FROM anon;
REVOKE CREATE ON SCHEMA finance FROM anon;
-- USAGE is left intact (required for authenticated to call functions
-- and select through RLS-protected views in these schemas).


-- =====================================================================
-- DB-035 [MEDIUM] SECURITY DEFINER functions without a pinned
-- search_path -- fixed generically for whatever the live database
-- actually has today (safer than hardcoding a guessed list).
-- =====================================================================

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT n.nspname AS schema_name, p.proname AS func_name,
           p.oid::regprocedure::text AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname IN ('ai','audit','core','finance','public','reporting')
      AND p.prosecdef = true
      AND NOT EXISTS (
        SELECT 1 FROM unnest(COALESCE(p.proconfig, ARRAY[]::text[])) cfg(cfg)
        WHERE cfg.cfg LIKE 'search_path=%'
      )
  LOOP
    -- pg_catalog first (required so built-ins resolve safely), then
    -- the function's own schema, then public as a fallback.
    EXECUTE format(
      'ALTER FUNCTION %s SET search_path TO ''pg_catalog'', %L, ''public''',
      r.sig, r.schema_name
    );
    RAISE NOTICE 'Pinned search_path on %', r.sig;
  END LOOP;
END $$;


-- =====================================================================
-- DB-040 [LOW] notification_deliveries has no INSERT policy for
-- authenticated (only SELECT + service-role-all)
-- =====================================================================

DROP POLICY IF EXISTS "notification_deliveries_insert_own" ON public.notification_deliveries;
CREATE POLICY "notification_deliveries_insert_own" ON public.notification_deliveries
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.notifications n
      WHERE n.id = notification_deliveries.notification_id
        AND n.user_id = auth.uid()
    )
  );
-- (Adjust the notifications.user_id column name above if your actual
--  notifications table uses a different recipient column -- verified
--  the notification_deliveries side of this from schema.sql; please
--  confirm the FK'd column name on public.notifications before running
--  in production, per DATABASE_AUDIT_FIX_NOTES.md.)


-- =====================================================================
-- DB-041 [LOW] audit.v_unsafe_security_definer_functions lacks
-- security_invoker=true. (public.v_payroll_summary already has it via
-- its later CREATE OR REPLACE in schema.sql -- not touched again here.)
-- =====================================================================

ALTER VIEW audit.v_unsafe_security_definer_functions SET (security_invoker = true);


COMMIT;

-- =====================================================================
-- End of P1_064_database_audit_fixes.sql
-- See DATABASE_AUDIT_FIX_NOTES.md for:
--   - DB-013, DB-014, DB-015, DB-017, DB-020, DB-030 (deferred -- need
--     a business/data decision, not safe to auto-fix blindly)
--   - DB-016, DB-024, DB-041(v_payroll_summary) (reviewed -- NOT bugs,
--     left as-is on purpose)
--   - DB-036, DB-037 (reviewed -- already adequately hardened)
--   - DB-038, DB-039 (legacy tables -- no organization_id column
--     exists to scope by; tightening would hide ALL rows from
--     everyone, which is worse than the current gap. Needs a backfill
--     before RLS can be safely tightened.)
-- =====================================================================
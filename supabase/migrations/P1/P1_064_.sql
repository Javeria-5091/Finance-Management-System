-- =============================================================================
-- remaining_database_bugs_safe_fix.sql
--
-- Fixes BUG-017 and BUG-068 in full.
-- Partially addresses BUG-006 (one table genuinely wrong; four tables
-- investigated and found NOT to be bugs -- see notes, no change made).
-- BUG-019 and BUG-067 are NOT changed by this file -- both require a
-- decision/verification outside the database layer; see the notes at
-- the end for exactly what is blocking each and why guessing would be
-- unsafe.
--
-- Verified against the UPDATED schema.sql (post-P1_062) supplied with
-- this request. All policy/constraint names below were confirmed to
-- exist in that file before being referenced.
-- =============================================================================

BEGIN;

-- =============================================================================
-- BUG-006 FIX -- public.payments.organization_id FK pointed at the wrong
-- parent table.
--
-- INVESTIGATION RESULT: only ONE of the five tables named in the ticket
-- is actually broken.
--
-- finance.tax_computations / tax_credits_and_withholding /
-- tax_payments_and_refunds / tax_returns (schema.sql ~13173-13334):
-- their organization_id FK correctly targets core.organization_config(id)
-- BY DESIGN. Their own RLS policies (ta_*, tr_*, trs_*, tsl_* and the
-- tax_computations/tax_credits_and_withholding/tax_payments_and_refunds/
-- tax_returns policies) compare organization_id against
-- core.current_user_org_config_id() -- a helper added in migration 031
-- specifically to resolve to organization_config.id, per its own
-- COMMENT ON FUNCTION. FK and RLS agree with each other. Repointing
-- these four FKs to core.organizations(id) as the ticket requests would
-- NOT fix anything -- it would instead desynchronize the FK from the
-- RLS policies that already correctly use the config-id semantics,
-- breaking every existing tax record's isolation check (same_org-style
-- comparisons would silently stop matching). NO CHANGE MADE to these
-- four tables in this patch.
--
-- public.payments (schema.sql line ~394 in the constraints block, well
-- within the cited 13173-13553 range): THIS one is genuinely broken.
-- Its FK targets core.organization_config(id), but its OWN RLS policies
-- (payments_modify_org_scoped, payments_select_org_scoped) compare
-- organization_id = core.current_user_org_id() -- which resolves to
-- core.organizations.id, NOT organization_config.id. FK and RLS
-- disagree. Since organization_config.id values are independent random
-- UUIDs from core.organizations.id values, that comparison can in
-- practice never match real data, so the organization-wide branch of
-- both payments policies is dead code today -- Finance Head/Accountant
-- users cannot see company-wide payments the way every sibling table
-- (invoices, expenses, budgets, clients -- all FK'd to
-- core.organizations(id) and compared with current_user_org_id())
-- already correctly allows. This is a real bug and is fixed below by
-- repointing the FK to match its own policy and its sibling tables.
--
-- SAFETY: a payments row can currently only satisfy its FK by holding a
-- value that exists in organization_config.id. Before dropping that FK,
-- we verify every existing non-null public.payments.organization_id
-- value also exists in core.organizations.id. If any row fails that
-- check, the migration raises an exception and changes nothing --
-- it will never silently drop/rewrite data.
-- =============================================================================

DO $$
DECLARE
  v_incompatible_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_incompatible_count
  FROM "public"."payments" p
  WHERE p."organization_id" IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM "core"."organizations" o WHERE o."id" = p."organization_id"
    );

  IF v_incompatible_count > 0 THEN
    RAISE EXCEPTION
      'BUG-006 FIX ABORTED: % row(s) in public.payments have an organization_id that does not exist in core.organizations.id. '
      'These values currently only resolve against core.organization_config.id. '
      'Reconcile them manually first -- e.g. '
      '''UPDATE public.payments p SET organization_id = oc.organization_id FROM core.organization_config oc WHERE oc.id = p.organization_id'' '
      '(after confirming that mapping is correct for your data) -- then re-run this migration. No data was changed.',
      v_incompatible_count;
  END IF;
END $$;

ALTER TABLE ONLY "public"."payments"
  DROP CONSTRAINT IF EXISTS "payments_organization_id_fkey";

ALTER TABLE ONLY "public"."payments"
  ADD CONSTRAINT "payments_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "core"."organizations"("id") ON DELETE SET NULL;

-- =============================================================================
-- BUG-017 FIX -- legacy.tax_returns / legacy.budget_lines /
-- legacy.numbering_sequences: unrestricted USING(true) SELECT policies.
--
-- All three tables are documented (COMMENT ON TABLE, migration 032) as
-- ARCHIVED, write-frozen duplicates retained only for historical
-- reference; every INSERT/UPDATE policy on them already correctly
-- returns false. The only gap is the SELECT policy. None of these
-- tables carry an organization_id column (they predate multi-tenancy),
-- so per-row scoping has to go through whatever real relationship each
-- table actually has -- not a guessed one:
--
--  - legacy.budget_lines.budget_id has a real FK to public.budgets(id),
--    and public.budgets.organization_id is a real, already-enforced
--    organization column. We scope through that FK.
--  - legacy.tax_returns.user_id and legacy.financial_accounts.user_id
--    (financial_accounts is already correctly role-restricted --
--    fa_pub_select -- and is not part of this ticket, left untouched)
--    have a real FK to auth.users(id). We scope tax_returns through
--    public.profiles.user_id = auth.users.id -> profiles.organization_id,
--    the same identity join every other same_org-based policy in this
--    schema relies on.
--  - legacy.numbering_sequences has NEITHER an organization_id NOR any
--    user/owner column of any kind -- it is a single pre-multi-tenant
--    global counter (one row per document_type). There is no real,
--    non-guessed relationship from this table to any organization, so
--    true per-row isolation cannot be constructed from the schema
--    alone. Per the "do not guess the organization relationship"
--    instruction, we do NOT invent one. Instead we replace USING(true)
--    with the same role restriction already used for its sibling
--    legacy.financial_accounts (fa_pub_select), which removes the
--    "any authenticated user, any organization" exposure and is a
--    strict tightening, not a guess. This does not claim to be organization
--    isolation for this table -- it cannot be, from the schema alone --
--    and that limitation is called out explicitly rather than hidden.
--
-- CRITICAL: PostgreSQL RLS policies are OR'd together (permissive by
-- default). The old USING(true) policies are DROPPED, not left in
-- place alongside a new one -- leaving both would mean the permissive
-- true still wins.
-- =============================================================================

DROP POLICY IF EXISTS "Anyone can view tax returns" ON "legacy"."tax_returns";
CREATE POLICY "tax_returns_pub_select_org_scoped" ON "legacy"."tax_returns"
  FOR SELECT TO "authenticated"
  USING (
    EXISTS (
      SELECT 1
      FROM "public"."profiles" p
      WHERE p."user_id" = "tax_returns"."user_id"
        AND "core"."same_org"(p."organization_id")
    )
  );

DROP POLICY IF EXISTS "Users can view budget lines" ON "legacy"."budget_lines";
CREATE POLICY "budget_lines_pub_select_org_scoped" ON "legacy"."budget_lines"
  FOR SELECT TO "authenticated"
  USING (
    EXISTS (
      SELECT 1
      FROM "public"."budgets" b
      WHERE b."id" = "budget_lines"."budget_id"
        AND "core"."same_org"(b."organization_id")
    )
  );

DROP POLICY IF EXISTS "numbering_select" ON "legacy"."numbering_sequences";
CREATE POLICY "numbering_select_role_restricted" ON "legacy"."numbering_sequences"
  FOR SELECT
  USING (
    "core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text") OR "core"."has_role"('VIEWER'::"text")
  );

-- =============================================================================
-- BUG-068 FIX -- finance.vendor_payment_allocations: vpa_select / vpa_insert
-- are pure role checks with no organization scoping at all, and (unlike
-- finance.journal_lines' EXISTS-based child policies, which transitively
-- inherit their parent's RLS) these two policies never join back to a
-- parent row, so they do NOT inherit the vendor_bills/vendor_payments
-- organization scoping fixed in P1_062 -- a Finance Head/Accountant of
-- ANY organization can currently read or create allocation rows linking
-- ANY organization's vendor_bill_id to ANY organization's
-- vendor_payment_id.
--
-- finance.vendor_bills.organization_id and
-- finance.vendor_payments.organization_id are both already
-- same_org-enforced (vb_select/vb_insert, vp_select/vp_insert -- the
-- latter fixed in P1_062). We scope vendor_payment_allocations through
-- both real FKs, and additionally require the referenced bill and
-- payment to belong to the SAME organization as each other -- closing
-- the same class of "insert a record linking your org to someone else's
-- parent row" gap the ticket describes for INSERT specifically.
-- =============================================================================

DROP POLICY IF EXISTS "vpa_select" ON "finance"."vendor_payment_allocations";
CREATE POLICY "vpa_select_org_scoped" ON "finance"."vendor_payment_allocations"
  FOR SELECT
  USING (
    ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text") OR "core"."has_role"('VIEWER'::"text"))
    AND EXISTS (
      SELECT 1 FROM "finance"."vendor_bills" vb
      WHERE vb."id" = "vendor_payment_allocations"."vendor_bill_id"
        AND "core"."same_org"(vb."organization_id")
    )
    AND EXISTS (
      SELECT 1 FROM "finance"."vendor_payments" vp
      WHERE vp."id" = "vendor_payment_allocations"."vendor_payment_id"
        AND "core"."same_org"(vp."organization_id")
    )
  );

DROP POLICY IF EXISTS "vpa_insert" ON "finance"."vendor_payment_allocations";
CREATE POLICY "vpa_insert_org_scoped" ON "finance"."vendor_payment_allocations"
  FOR INSERT
  WITH CHECK (
    ("core"."is_finance_head"() OR "core"."has_role"('ACCOUNTANT'::"text"))
    AND EXISTS (
      SELECT 1 FROM "finance"."vendor_bills" vb
      WHERE vb."id" = "vendor_payment_allocations"."vendor_bill_id"
        AND "core"."same_org"(vb."organization_id")
    )
    AND EXISTS (
      SELECT 1 FROM "finance"."vendor_payments" vp
      WHERE vp."id" = "vendor_payment_allocations"."vendor_payment_id"
        AND "core"."same_org"(vp."organization_id")
    )
    -- prevents linking an org-A bill to an org-B payment even if,
    -- hypothetically, both belonged to the caller's own org membership
    -- set (defense in depth against the "child record referencing a
    -- parent from another organization" attack class):
    AND EXISTS (
      SELECT 1
      FROM "finance"."vendor_bills" vb2
      JOIN "finance"."vendor_payments" vp2 ON vp2."organization_id" = vb2."organization_id"
      WHERE vb2."id" = "vendor_payment_allocations"."vendor_bill_id"
        AND vp2."id" = "vendor_payment_allocations"."vendor_payment_id"
    )
  );

COMMIT;

-- =============================================================================
-- NOT FIXED BY THIS FILE -- requires a decision/verification outside the
-- database layer:
--
-- BUG-019 (dual role systems on public.profiles):
-- Confirmed real. public.profiles carries a legacy `role` text column
-- (CHECK-constrained to CEO/FINANCE_HEAD/ACCOUNTANT/PROJECT_MANAGER/
-- EMPLOYEE/VIEWER) plus 13 `can_*` boolean columns, alongside the
-- normalized RBAC tables (core.roles/core.user_roles/
-- core.role_permissions/core.permissions). This is NOT inert legacy
-- baggage: core.has_role() (see its own COMMENT, migration 018)
-- explicitly still reads public.profiles.role as a FALLBACK for any
-- user with zero rows in core.user_roles. That means safely retiring
-- profiles.role requires first confirming every user row has an
-- equivalent core.user_roles assignment (an application/data question,
-- not something schema.sql alone can prove), and retiring the can_*
-- columns requires confirming no application code path still reads them
-- directly (grep of the provided source found no live reads of the
-- can_* columns, but that must be confirmed against the full,
-- currently-deployed application code, not just this schema). Per your
-- own instruction to stop rather than guess a business decision: this
-- needs (a) confirmation that 100% of active users have a core.user_roles
-- row, and (b) an application-code sign-off that nothing reads
-- profiles.can_*, before a safe migration to drop/deprecate them can be
-- written. No schema change made.
--
-- BUG-067 (ai_readonly_role):
-- Confirmed: this role is referenced extensively (SET LOCAL ROLE at
-- schema.sql:3812, plus 10+ GRANT ... TO "ai_readonly_role" statements
-- on reporting views) but there is no CREATE ROLE "ai_readonly_role" in
-- schema.sql. This is expected/normal for Supabase: schema-only dumps
-- (pg_dump --schema-only, which is what produced this file) intentionally
-- exclude cluster-level role objects (CREATE ROLE is not schema-scoped),
-- so this role most likely already exists in the live database and
-- simply isn't visible in this dump -- it is not necessarily missing.
-- Per your instruction not to blindly create a role or grant privileges:
-- please run this read-only check against the live database (not
-- included in this patch) to confirm:
--   SELECT rolname, rolcanlogin, rolbypassrls FROM pg_roles WHERE rolname = 'ai_readonly_role';
-- If that returns zero rows, the role genuinely needs to be created with
-- NOLOGIN (it should only ever be entered via SET LOCAL ROLE from a
-- SECURITY DEFINER function, never used for direct client login) and
-- NOBYPASSRLS, and the exact GRANTs already listed in schema.sql
-- reapplied -- nothing more. That is an application/ops decision
-- (confirming NOLOGIN is acceptable for the AI gateway's usage pattern)
-- best made with sight of the live cluster, so it is intentionally not
-- included here rather than guessed.
-- =============================================================================
-- =====================================================================
-- Migration 036: Budget "Committed" tracking
-- =====================================================================
-- FINDING (confirmed from prior analysis, HIGH-2):
--   finance.budget_lines only has budgeted_amount; finance.budget_revisions
--   covers "Approved Revisions" history. No table resembling a purchase
--   commitment / purchase-request / encumbrance ledger exists anywhere
--   in the schema (confirmed: zero matches for "commitment" prior to
--   this migration), and no committed_amount column exists on the
--   budget tables.
--
-- SPEC REQUIREMENT:
--   §5.4: "Track Original Budget, Approved Revisions, Committed,
--   Actual, Available, Forecast, and Variance." §2.1/§13.2 list
--   Committed as a first-class, separately reportable figure, distinct
--   from Actual.
--
-- SCOPE NOTE:
--   The specification's full purchase-request/purchase-order workflow
--   (§5.5 "purchase requests") is a larger application feature that
--   this schema does not yet implement end-to-end (no purchase_requests
--   table exists). This migration provides the minimum database-level
--   structure the spec requires so "Committed" has a real, queryable
--   data source and is not a phantom report field:
--     - finance.budget_commitments: an encumbrance ledger. A commitment
--       is created when a purchase request, approved-but-unposted
--       vendor bill, or other pre-spend obligation is raised against a
--       budget line, and is released (status -> RELEASED) when it is
--       either superseded by an actual posted transaction or cancelled.
--     - finance.budget_lines.committed_amount: a denormalized,
--       trigger-maintained running total for fast reporting, kept in
--       sync with the sum of OPEN finance.budget_commitments rows for
--       that budget line.
--   Building the full purchase-request UI/API/workflow (draft, submit,
--   approve, convert-to-bill) is an APPLICATION-LEVEL requirement and
--   is called out separately in the accompanying report; it is not
--   addressed by this database migration.
-- =====================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS finance.budget_commitments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    budget_line_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    source_type text NOT NULL,
    source_reference text,
    amount numeric(18,2) NOT NULL,
    base_amount numeric(18,2) NOT NULL,
    status text DEFAULT 'OPEN'::text NOT NULL,
    description text,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    released_by uuid,
    released_at timestamp with time zone,
    release_reason text,
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT budget_commitments_amount_check CHECK (amount > 0::numeric),
    CONSTRAINT budget_commitments_status_check
      CHECK (status = ANY (ARRAY['OPEN'::text, 'RELEASED'::text, 'CANCELLED'::text])),
    CONSTRAINT budget_commitments_source_type_check
      CHECK (source_type = ANY (ARRAY['PURCHASE_REQUEST'::text, 'VENDOR_BILL'::text, 'MANUAL'::text])),
    CONSTRAINT budget_commitments_release_requires_reason
      CHECK ((status = 'OPEN') OR (release_reason IS NOT NULL))
);

ALTER TABLE finance.budget_commitments OWNER TO postgres;

ALTER TABLE ONLY finance.budget_commitments
    ADD CONSTRAINT budget_commitments_pkey PRIMARY KEY (id);

ALTER TABLE ONLY finance.budget_commitments
    ADD CONSTRAINT budget_commitments_budget_line_id_fkey
    FOREIGN KEY (budget_line_id) REFERENCES finance.budget_lines(id) ON DELETE CASCADE;

ALTER TABLE ONLY finance.budget_commitments
    ADD CONSTRAINT budget_commitments_organization_id_fkey
    FOREIGN KEY (organization_id) REFERENCES core.organizations(id) ON DELETE RESTRICT;

CREATE INDEX idx_budget_commitments_budget_line ON finance.budget_commitments USING btree (budget_line_id);
CREATE INDEX idx_budget_commitments_status ON finance.budget_commitments USING btree (status);

CREATE OR REPLACE TRIGGER trg_updated_at
  BEFORE UPDATE ON finance.budget_commitments
  FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

CREATE OR REPLACE TRIGGER budget_commitments_audit
  AFTER INSERT OR DELETE OR UPDATE ON finance.budget_commitments
  FOR EACH ROW EXECUTE FUNCTION audit.trigger_audit_log();

ALTER TABLE finance.budget_commitments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "bc_select" ON finance.budget_commitments FOR SELECT
  USING (auth.uid() IS NOT NULL AND core.same_org(organization_id));

CREATE POLICY "bc_insert" ON finance.budget_commitments FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL AND core.same_org(organization_id));

CREATE POLICY "bc_update" ON finance.budget_commitments FOR UPDATE
  USING ((core.is_finance_head() OR core.has_role('ACCOUNTANT')) AND core.same_org(organization_id))
  WITH CHECK ((core.is_finance_head() OR core.has_role('ACCOUNTANT')) AND core.same_org(organization_id));

-- --- Denormalized running total on budget_lines, trigger-maintained ---
ALTER TABLE finance.budget_lines
  ADD COLUMN IF NOT EXISTS committed_amount numeric(18,2) DEFAULT 0 NOT NULL;

CREATE OR REPLACE FUNCTION finance.sync_budget_line_committed_amount() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_budget_line_id uuid;
  v_total numeric(18,2);
BEGIN
  v_budget_line_id := COALESCE(NEW.budget_line_id, OLD.budget_line_id);

  SELECT COALESCE(SUM(amount), 0) INTO v_total
  FROM finance.budget_commitments
  WHERE budget_line_id = v_budget_line_id
    AND status = 'OPEN';

  UPDATE finance.budget_lines
  SET committed_amount = v_total
  WHERE id = v_budget_line_id;

  RETURN COALESCE(NEW, OLD);
END;
$$;

ALTER FUNCTION finance.sync_budget_line_committed_amount() OWNER TO postgres;

CREATE OR REPLACE TRIGGER trg_sync_budget_line_committed_amount
  AFTER INSERT OR UPDATE OR DELETE ON finance.budget_commitments
  FOR EACH ROW EXECUTE FUNCTION finance.sync_budget_line_committed_amount();

COMMENT ON TABLE finance.budget_commitments IS
  'Encumbrance ledger giving the "Committed" figure required by spec §5.4/§2.1/§13.2 '
  'a real database source. budget_lines.committed_amount is a trigger-maintained sum '
  'of OPEN rows here, kept in sync automatically. Added in Migration 036.';

COMMIT;

-- Validation:
--   -- Open a commitment and confirm the budget line total updates:
--   -- INSERT INTO finance.budget_commitments (budget_line_id, organization_id, source_type, amount, base_amount, created_by)
--   --   VALUES ('<budget-line-uuid>', '<org-uuid>', 'MANUAL', 500, 500, '<user-uuid>');
--   -- SELECT committed_amount FROM finance.budget_lines WHERE id = '<budget-line-uuid>'; -- expect 500
--   -- Release it and confirm the total drops back to 0:
--   -- UPDATE finance.budget_commitments SET status = 'RELEASED', release_reason = 'converted to actual spend'
--   --   WHERE budget_line_id = '<budget-line-uuid>';
--   -- SELECT committed_amount FROM finance.budget_lines WHERE id = '<budget-line-uuid>'; -- expect 0
-- =============================================================================
-- Migration P1_061: AI Reporting-View Grants & Policy Documents Table
-- (supports Remediation ISS-07 / ISS-07b)
-- =============================================================================
-- PURPOSE
--   ISS-07/07b fixes budget-cash-alerts, fiscal-close-assistant, policy-qa,
--   and reconciliation-suggestions to call execute_ai_readonly_query() with
--   the correct parameters and add SQL-safety/permission checks (see the
--   updated route files). Fixing the call signature alone is NOT sufficient:
--   execute_ai_readonly_query() runs the query under a dedicated,
--   minimal-privilege `ai_readonly_role` (SET LOCAL ROLE), and that role
--   currently only has SELECT granted on THREE reporting views
--   (reporting.v_cash_position, reporting.v_project_profitability,
--   reporting.v_tax_computation_summary -- the ones used by chat/route.ts and
--   tax-assistant/route.ts). The other four views these four routes need
--   (reporting.budget_vs_actual, reporting.payable_aging,
--   reporting.receivable_aging, reporting.reconciliation_summary,
--   reporting.unreconciled_lines, reporting.general_ledger) have NO grant to
--   ai_readonly_role at all -- so even after the call-signature fix, these
--   routes would still fail at runtime with "permission denied" /
--   insufficient_privilege. This was found during this remediation pass by
--   reading execute_ai_readonly_query()'s body and the existing GRANT
--   statements directly; it is a necessary corollary of ISS-07, not a
--   separately-numbered audit finding.
--
--   Also fixes a real column gap in reporting.unreconciled_lines: the
--   reconciliation-suggestions route needs to filter unreconciled statement
--   lines by financial_account_id, but the view only exposed
--   financial_account_name (not the id), making it impossible to filter by
--   account without a fragile name match. This adds the id column
--   (additive -- does not remove or rename any existing column, so it cannot
--   break any existing consumer of this view).
--
--   Finally, creates public.policy_documents, which
--   src/app/api/ai/policy-qa/route.ts already queries by name but which does
--   not exist anywhere in schema.sql. This is a genuinely MISSING feature,
--   not a bug in the strict sense -- see the remediation matrix and the
--   comment on the route file for the scope note. It is created here as a
--   minimal, additive, low-risk table (standard org-scoped RLS, no
--   interaction with any posting/ledger logic) because: (a) the spec
--   explicitly requires "Policy/document Q&A" as a P1 AI capability (9.1,
--   Appendix B "search_finance_policies"), and (b) without it, policy-qa is
--   permanently unreachable regardless of any application-code fix. No
--   document-ingestion UI is built here -- populating this table is a
--   separate, explicitly out-of-scope product decision (see remediation
--   matrix).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- STEP 1: Grant ai_readonly_role SELECT on the additional reporting views
-- needed by budget-cash-alerts, fiscal-close-assistant, and
-- reconciliation-suggestions. All of these are already security_invoker
-- views (confirmed in schema.sql) restricted to the `reporting` schema, i.e.
-- exactly the controlled surface spec 9.5 requires the AI gateway to be
-- limited to.
-- -----------------------------------------------------------------------------

GRANT SELECT ON TABLE "reporting"."budget_vs_actual" TO "ai_readonly_role";
GRANT SELECT ON TABLE "reporting"."payable_aging" TO "ai_readonly_role";
GRANT SELECT ON TABLE "reporting"."receivable_aging" TO "ai_readonly_role";
GRANT SELECT ON TABLE "reporting"."reconciliation_summary" TO "ai_readonly_role";
GRANT SELECT ON TABLE "reporting"."unreconciled_lines" TO "ai_readonly_role";
GRANT SELECT ON TABLE "reporting"."general_ledger" TO "ai_readonly_role";

-- -----------------------------------------------------------------------------
-- STEP 2: reporting.unreconciled_lines — add financial_account_id (additive;
-- existing columns are untouched, so no existing consumer of this view can
-- break).
-- -----------------------------------------------------------------------------

CREATE OR REPLACE VIEW "reporting"."unreconciled_lines" WITH ("security_invoker"='true') AS
 SELECT "sl"."id",
    "sl"."line_number",
    "sl"."transaction_date",
    "sl"."description",
    "sl"."reference",
    "sl"."counterparty",
    "sl"."amount",
    "sl"."balance_after",
    "fa"."id" AS "financial_account_id",
    "fa"."account_name" AS "financial_account_name",
    "fa"."institution_name",
    "fa"."currency",
    "fa"."masked_identifier"
   FROM (("finance"."statement_lines" "sl"
     JOIN "finance"."bank_statements" "bs" ON (("bs"."id" = "sl"."bank_statement_id")))
     JOIN "finance"."financial_accounts" "fa" ON (("fa"."id" = "bs"."financial_account_id")))
  WHERE ("sl"."reconciliation_status" = 'UNRECONCILED'::"text")
  ORDER BY "sl"."transaction_date" DESC, "fa"."account_name";

ALTER VIEW "reporting"."unreconciled_lines" OWNER TO "postgres";

COMMENT ON VIEW "reporting"."unreconciled_lines" IS
  'P1_061: added financial_account_id (previously only financial_account_name was exposed, which made filtering a specific account from application code unreliable). Additive change only -- no existing column removed or renamed.';

-- -----------------------------------------------------------------------------
-- STEP 3: public.policy_documents — minimal, additive, org-scoped table
-- backing the "search_finance_policies" AI tool (spec 9.1/Appendix B) and the
-- existing (previously non-functional) policy-qa route.
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "public"."policy_documents" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL PRIMARY KEY,
    "organization_id" "uuid" NOT NULL,
    "title" "text" NOT NULL,
    "document_type" "text" DEFAULT 'POLICY'::"text" NOT NULL,
    "content" "text" NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "policy_documents_document_type_check" CHECK (("document_type" = ANY (ARRAY[
      'POLICY'::"text", 'PROCEDURE'::"text", 'CONTRACT'::"text", 'GUIDELINE'::"text", 'OTHER'::"text"
    ])))
);

ALTER TABLE "public"."policy_documents" OWNER TO "postgres";

COMMENT ON TABLE "public"."policy_documents" IS
  'Added P1_061 to support the spec 9.1/Appendix B "Policy/document Q&A" AI capability and the existing policy-qa route, which already queried this table by name before it existed. Minimal schema (title/content/document_type) -- document ingestion (upload, chunking, embeddings for real RAG) is explicitly out of scope for this migration; see remediation matrix.';

CREATE INDEX IF NOT EXISTS "idx_policy_documents_org" ON "public"."policy_documents" ("organization_id");
CREATE INDEX IF NOT EXISTS "idx_policy_documents_active" ON "public"."policy_documents" ("organization_id", "is_active") WHERE "is_active" = true;

ALTER TABLE "public"."policy_documents" ENABLE ROW LEVEL SECURITY;

-- Read: any authenticated member of the organization may read active policy
-- documents (matches spec 9.1's framing of policy Q&A as broadly available,
-- "permission-aware retrieval" being about which documents/ACLs apply, not a
-- privileged-roles-only feature). Write: Finance Head/CEO only, matching how
-- other organization-wide configuration/reference tables in this schema are
-- gated.
CREATE POLICY "policy_documents_select_org_scoped" ON "public"."policy_documents"
  FOR SELECT TO "authenticated"
  USING (core.same_org(organization_id));

CREATE POLICY "policy_documents_insert_org_scoped" ON "public"."policy_documents"
  FOR INSERT TO "authenticated"
  WITH CHECK (core.same_org(organization_id) AND core.is_finance_head());

CREATE POLICY "policy_documents_update_org_scoped" ON "public"."policy_documents"
  FOR UPDATE TO "authenticated"
  USING (core.same_org(organization_id) AND core.is_finance_head())
  WITH CHECK (core.same_org(organization_id) AND core.is_finance_head());

CREATE POLICY "policy_documents_delete_org_scoped" ON "public"."policy_documents"
  FOR DELETE TO "authenticated"
  USING (core.same_org(organization_id) AND core.is_finance_head());

CREATE POLICY "policy_documents_service_role" ON "public"."policy_documents"
  TO "service_role"
  USING (true)
  WITH CHECK (true);

GRANT SELECT ON TABLE "public"."policy_documents" TO "authenticated", "service_role";
GRANT INSERT, UPDATE, DELETE ON TABLE "public"."policy_documents" TO "authenticated", "service_role";

-- ai_readonly_role: SELECT only, so the policy-qa route's read-only AI query
-- can reach this table via execute_ai_readonly_query() the same way it
-- reaches every other AI-queryable table. execute_ai_readonly_query() always
-- wraps the caller's query with "WHERE organization_id = <caller's org>",
-- so this grant does not, by itself, allow cross-organization reads.
GRANT SELECT ON TABLE "public"."policy_documents" TO "ai_readonly_role";

CREATE OR REPLACE TRIGGER "policy_documents_set_updated_at"
  BEFORE UPDATE ON "public"."policy_documents"
  FOR EACH ROW EXECUTE FUNCTION "core"."set_updated_at"();

-- =============================================================================
-- END P1_061
-- =============================================================================
-- =============================================================================
-- Migration P1_061: AI Reporting-View Grants & Policy Documents Table
-- (supports Remediation ISS-07 / ISS-07b)
-- CORRECTED: financial_account_id moved to the end of the unreconciled_lines
-- column list. The original ordering (inserted before financial_account_name)
-- fails with "cannot change name of view column" -- confirmed by direct
-- execution against a restored copy of this schema. PostgreSQL's
-- CREATE OR REPLACE VIEW only permits appending new columns, never inserting
-- them mid-list, since every column after the insertion point is implicitly
-- renumbered. Everything else in this file is unchanged from the original.
-- =============================================================================

GRANT SELECT ON TABLE "reporting"."budget_vs_actual" TO "ai_readonly_role";
GRANT SELECT ON TABLE "reporting"."payable_aging" TO "ai_readonly_role";
GRANT SELECT ON TABLE "reporting"."receivable_aging" TO "ai_readonly_role";
GRANT SELECT ON TABLE "reporting"."reconciliation_summary" TO "ai_readonly_role";
GRANT SELECT ON TABLE "reporting"."unreconciled_lines" TO "ai_readonly_role";
GRANT SELECT ON TABLE "reporting"."general_ledger" TO "ai_readonly_role";

-- CORRECTED VIEW: fa.id AS financial_account_id appended at the end.
CREATE OR REPLACE VIEW "reporting"."unreconciled_lines" WITH ("security_invoker"='true') AS
 SELECT "sl"."id",
    "sl"."line_number",
    "sl"."transaction_date",
    "sl"."description",
    "sl"."reference",
    "sl"."counterparty",
    "sl"."amount",
    "sl"."balance_after",
    "fa"."account_name" AS "financial_account_name",
    "fa"."institution_name",
    "fa"."currency",
    "fa"."masked_identifier",
    "fa"."id" AS "financial_account_id"
   FROM (("finance"."statement_lines" "sl"
     JOIN "finance"."bank_statements" "bs" ON (("bs"."id" = "sl"."bank_statement_id")))
     JOIN "finance"."financial_accounts" "fa" ON (("fa"."id" = "bs"."financial_account_id")))
  WHERE ("sl"."reconciliation_status" = 'UNRECONCILED'::"text")
  ORDER BY "sl"."transaction_date" DESC, "fa"."account_name";

ALTER VIEW "reporting"."unreconciled_lines" OWNER TO "postgres";

COMMENT ON VIEW "reporting"."unreconciled_lines" IS
  'P1_061 (corrected): added financial_account_id, appended as the last column so CREATE OR REPLACE VIEW does not attempt to rename/renumber any existing column. No existing column removed, renamed, or reordered.';

-- -----------------------------------------------------------------------------
-- public.policy_documents -- minimal, additive, org-scoped table backing the
-- "search_finance_policies" AI tool (spec 9.1/Appendix B) and the previously
-- non-functional policy-qa route.
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

GRANT SELECT ON TABLE "public"."policy_documents" TO "ai_readonly_role";

CREATE OR REPLACE TRIGGER "policy_documents_set_updated_at"
  BEFORE UPDATE ON "public"."policy_documents"
  FOR EACH ROW EXECUTE FUNCTION "core"."set_updated_at"();

-- =============================================================================
-- END P1_061 (corrected)
-- =============================================================================
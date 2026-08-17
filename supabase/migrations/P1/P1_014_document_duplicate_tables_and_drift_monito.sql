-- =============================================================================
-- Migration 023: Document the duplicate finance/public tables and add a
--                drift-monitoring view (NO merge or drop performed)
-- =============================================================================
-- PURPOSE
--   The compliance audit found four entities implemented as two independent,
--   actively-writable tables each:
--     finance.financial_accounts  vs  public.financial_accounts
--     finance.budget_lines        vs  public.budget_lines
--     finance.tax_returns         vs  public.tax_returns
--     finance.numbering_sequences vs  public.numbering_sequences
--
-- WHY THIS MIGRATION DOES NOT MERGE OR DROP EITHER SIDE
--   This is explicitly the kind of "destructive behavior... genuinely
--   required to satisfy the specification" the task instructions say to
--   STOP and explain rather than perform automatically (Section 5), because:
--     - I cannot determine from schema.sql alone which table the frontend
--       application actually reads/writes for financial_accounts and
--       budget_lines. Both have their own RLS policies and both are
--       reachable through PostgREST today. Dropping or renaming the "wrong"
--       one would break a currently-working screen.
--     - finance.tax_returns and finance.numbering_sequences ARE confirmed,
--       from the FK graph, to be the tables the posting engine and numbering
--       generator actually use -- their public.* counterparts appear
--       structurally orphaned (no inbound FK) -- but "appears orphaned in
--       this schema file" is not the same certainty as "confirmed unused by
--       the deployed application", which may still query them directly.
--
--   Rather than guess, this migration makes the duplication impossible to
--   miss during testing (a monitoring view that surfaces row-count drift
--   between each pair) and leaves the actual consolidation decision -- and
--   the corresponding one-line application change once made -- to the team.
--
-- ISSUES ADDRESSED
--   - Makes the known duplication actively visible/testable rather than a
--     silent trap (directly supports Section 25/26 "internal consistency"
--     and gives QA a concrete query to run before sign-off)
--   - COMMENT ON TABLE marks each duplicate pair so anyone inspecting the
--     schema (via \dt+, psql, or a GUI) sees the warning in place
--
-- SAFETY
--   Comments and a read-only view only. No table, column, row, or policy is
--   changed.
-- =============================================================================

BEGIN;

COMMENT ON TABLE "finance"."financial_accounts" IS
  'Canonical (spec-aligned) financial accounts table -- has ledger mapping, reconciliation method, dual-approval fields. NOTE: public.financial_accounts is a separate, independently-writable legacy table covering the same entity. See Migration 023 / compliance audit Section 3.2 for the required consolidation decision before further schema changes.';

COMMENT ON TABLE "public"."financial_accounts" IS
  'LEGACY financial accounts table (predates finance.financial_accounts). Independently writable via its own RLS policies -- NOT automatically kept in sync with finance.financial_accounts. See Migration 023 / compliance audit Section 3.2 for the required consolidation decision before further schema changes.';

COMMENT ON TABLE "finance"."budget_lines" IS
  'Budget line items. NOTE: public.budget_lines is a separate, independently-writable table referencing the same public.budgets parent. See Migration 023 / compliance audit Section 3.2 for the required consolidation decision.';

COMMENT ON TABLE "public"."budget_lines" IS
  'LEGACY budget line items table. NOTE: finance.budget_lines is a separate, independently-writable table referencing the same public.budgets parent. See Migration 023 / compliance audit Section 3.2 for the required consolidation decision.';

COMMENT ON TABLE "finance"."tax_returns" IS
  'Canonical tax returns table -- referenced by finance.tax_computations, finance.tax_credits_and_withholding, finance.tax_payments_and_refunds. public.tax_returns is a structurally orphaned duplicate (no inbound FK found); confirm it is unused by the application, then deprecate it. See Migration 023.';

COMMENT ON TABLE "public"."tax_returns" IS
  'LEGACY tax returns table. Appears structurally orphaned (no inbound foreign keys) as of this audit -- finance.tax_returns is the table actually referenced by the tax computation/credit/payment chain. Confirm this table is unused by the application before removing it. See Migration 023.';

COMMENT ON TABLE "finance"."numbering_sequences" IS
  'Canonical document-numbering table -- used by finance.get_next_number(), which every post_* function calls. public.numbering_sequences is a separate, disconnected numbering authority; do not write to it expecting it to affect finance.* document numbers. See Migration 023.';

COMMENT ON TABLE "public"."numbering_sequences" IS
  'LEGACY numbering table, NOT read by finance.get_next_number(). Writing to this table has no effect on invoice/journal/bill numbering. Confirm it is unused by the application before removing it. See Migration 023.';

-- -----------------------------------------------------------------------
-- Drift-monitoring view: run this before every release / test cycle to
-- confirm the duplication hasn't silently accumulated divergent data.
-- Read-only, safe to query at any time.
-- -----------------------------------------------------------------------
CREATE OR REPLACE VIEW "reporting"."v_duplicate_table_drift" WITH ("security_invoker" = 'true') AS
SELECT 'financial_accounts' AS entity,
       (SELECT COUNT(*) FROM finance.financial_accounts) AS finance_schema_rows,
       (SELECT COUNT(*) FROM public.financial_accounts) AS public_schema_rows
UNION ALL
SELECT 'budget_lines',
       (SELECT COUNT(*) FROM finance.budget_lines),
       (SELECT COUNT(*) FROM public.budget_lines)
UNION ALL
SELECT 'tax_returns',
       (SELECT COUNT(*) FROM finance.tax_returns),
       (SELECT COUNT(*) FROM public.tax_returns)
UNION ALL
SELECT 'numbering_sequences',
       (SELECT COUNT(*) FROM finance.numbering_sequences),
       (SELECT COUNT(*) FROM public.numbering_sequences);

ALTER VIEW "reporting"."v_duplicate_table_drift" OWNER TO "postgres";

COMMIT;
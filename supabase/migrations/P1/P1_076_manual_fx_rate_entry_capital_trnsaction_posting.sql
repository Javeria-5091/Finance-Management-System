-- ================================================================
-- BUG-017 FIX: No working manual exchange-rate entry path
--
-- Root causes fixed here (application-code fixes for
-- src/app/api/admin/exchange-rates/route.ts and
-- src/app/dashboard/settings/exchange-rates/page.tsx are in the same
-- change set):
--
--   1. The real table is finance.exchange_rates, which has NO
--      effective_date / valid_until / is_active / source / notes
--      columns. The admin route was reading/writing those against
--      `core.exchange_rates`, which isn't the table used anywhere else
--      in the system.
--   2. public.exchange_rates (the view the settings page inserted
--      through directly) did not expose organization_id, so every
--      insert failed the moment the client tried to set it.
--   3. finance.exchange_rates had no evidence/reference column at all,
--      so spec 5.12 ("rates are never assumed" — every manual rate must
--      be evidenced) was structurally unenforceable.
--   4. There was no approval workflow: no constraint stopped the same
--      user who entered a rate from also approving it, and there was
--      no UPDATE policy that would even let an approval happen through
--      RLS in the first place.
--
-- Fix:
--   - Add finance.exchange_rates.evidence_reference (required).
--   - Extend the existing maker-checker trigger/function to cover
--     exchange_rates (entered_by <> approved_by), matching the pattern
--     already used for vendor_bills/journal_entries/bank_transfers/
--     profit_distributions.
--   - Add an UPDATE RLS policy (fx_approve) scoped to Finance Head/CEO
--     so an approval can actually be persisted.
--   - Seed the FX_RATE_READ / FX_RATE_CREATE / FX_RATE_APPROVE
--     permissions and map them to roles — previously the route required
--     'SETTINGS_READ'/'SETTINGS_UPDATE', which were never seeded
--     anywhere, so only the CEO bypass in requirePermission() could
--     ever reach the route at all (no separate proposer/approver was
--     possible).
-- ================================================================

-- ── 1. Evidence column ──────────────────────────────────────────────
ALTER TABLE finance.exchange_rates ADD COLUMN IF NOT EXISTS evidence_reference TEXT;

UPDATE finance.exchange_rates
SET evidence_reference = 'LEGACY - evidence not recorded prior to BUG-017 fix'
WHERE evidence_reference IS NULL;

ALTER TABLE finance.exchange_rates
  ALTER COLUMN evidence_reference SET NOT NULL;

ALTER TABLE finance.exchange_rates
  DROP CONSTRAINT IF EXISTS exchange_rates_evidence_reference_not_blank;
ALTER TABLE finance.exchange_rates
  ADD CONSTRAINT exchange_rates_evidence_reference_not_blank
  CHECK (length(trim(evidence_reference)) > 0);

COMMENT ON COLUMN finance.exchange_rates.evidence_reference IS
  'BUG-017 FIX: required citation for a manually entered rate (bank/platform screenshot reference, invoice number, source URL, etc.). Spec 5.12: rates are never assumed or auto-refreshed, only entered against evidence.';

-- ── 2. Maker-checker: entered_by must differ from approved_by ──────
CREATE OR REPLACE FUNCTION finance.enforce_maker_checker() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'finance', 'public'
    AS $$
DECLARE
  v_creator_id UUID;
  v_approver_id UUID;
  v_second_approver_id UUID;
  v_table TEXT;
  v_schema TEXT;
BEGIN
  v_table := TG_TABLE_NAME;
  v_schema := TG_TABLE_SCHEMA;

  IF v_table IN ('expenses', 'incomes', 'invoices') THEN
    v_creator_id := COALESCE(OLD.user_id, NEW.user_id);
    v_approver_id := NEW.approved_by;
  ELSIF v_table IN ('vendor_bills', 'journal_entries') THEN
    v_creator_id := COALESCE(OLD.created_by, NEW.created_by);
    v_approver_id := NEW.approved_by;
  ELSIF v_table = 'bank_transfers' THEN
    v_creator_id := COALESCE(OLD.created_by, NEW.created_by);
    v_approver_id := NEW.approved_by;
    v_second_approver_id := NEW.second_approved_by;
  ELSIF v_table = 'profit_distributions' THEN
    v_creator_id := COALESCE(OLD.declared_by, NEW.declared_by);
    v_approver_id := NEW.approved_by;
  ELSIF v_table = 'exchange_rates' THEN
    -- BUG-017 FIX: the person who entered a manual FX rate must not be
    -- the same person who approves/locks it (spec 5.12).
    v_creator_id := COALESCE(OLD.entered_by, NEW.entered_by);
    v_approver_id := NEW.approved_by;
  ELSE
    RETURN NEW;
  END IF;

  IF v_approver_id IS NOT NULL AND v_creator_id IS NOT NULL AND v_approver_id = v_creator_id THEN
    RAISE EXCEPTION 'MAKER_CHECKER_VIOLATION: Creator (user %) cannot approve their own record in %',
      v_creator_id, v_table;
  END IF;

  IF v_table = 'bank_transfers' AND v_second_approver_id IS NOT NULL THEN
    IF v_creator_id IS NOT NULL AND v_second_approver_id = v_creator_id THEN
      RAISE EXCEPTION 'MAKER_CHECKER_VIOLATION: Creator (user %) cannot be the second approver on a bank transfer', v_creator_id;
    END IF;
    IF v_approver_id IS NOT NULL AND v_second_approver_id = v_approver_id THEN
      RAISE EXCEPTION 'MAKER_CHECKER_VIOLATION: The first and second approver on a bank transfer must be different users (user %)', v_approver_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION finance.enforce_maker_checker() IS 'BUG-017 FIX: extended to cover finance.exchange_rates (entered_by <> approved_by), completing the FX approval workflow required by spec 5.12. Original expenses/incomes/invoices/vendor_bills/journal_entries/bank_transfers/profit_distributions behavior is unchanged.';

DROP TRIGGER IF EXISTS trg_maker_checker ON finance.exchange_rates;
CREATE TRIGGER trg_maker_checker BEFORE INSERT OR UPDATE ON finance.exchange_rates
  FOR EACH ROW EXECUTE FUNCTION finance.enforce_maker_checker();

-- ── 3. RLS: allow an approver to lock/approve a rate ────────────────
-- There was previously NO update policy at all on finance.exchange_rates,
-- so an approval could never be persisted through the authenticated
-- client regardless of role.
DROP POLICY IF EXISTS fx_approve ON finance.exchange_rates;
CREATE POLICY fx_approve ON finance.exchange_rates FOR UPDATE
  USING (core.is_finance_head() AND core.same_org(organization_id))
  WITH CHECK (core.is_finance_head() AND core.same_org(organization_id));

COMMENT ON POLICY fx_approve ON finance.exchange_rates IS 'BUG-017 FIX: Finance Head/CEO may approve/lock a manually entered rate. trg_maker_checker separately blocks the same user who entered the rate from approving it, so approval is never self-service.';

-- ── 4. Permission catalog ───────────────────────────────────────────
-- 'SETTINGS_READ'/'SETTINGS_UPDATE' (used by the old route) were never
-- seeded anywhere, so only the CEO bypass in requirePermission() could
-- reach this route — meaning no distinct proposer/approver pair was
-- even possible. Seed real, scoped permissions instead.
INSERT INTO core.permissions (id, code, name, module, action, is_system, description)
VALUES
  (gen_random_uuid(), 'FX_RATE_READ',    'Exchange Rate: Read',    'FX', 'READ',    true, 'View manually entered FX rates'),
  (gen_random_uuid(), 'FX_RATE_CREATE',  'Exchange Rate: Propose', 'FX', 'CREATE',  true, 'Enter a manual FX rate for approval'),
  (gen_random_uuid(), 'FX_RATE_APPROVE', 'Exchange Rate: Approve', 'FX', 'APPROVE', true, 'Approve/lock a proposed FX rate (must not be the person who entered it)')
ON CONFLICT (code) DO NOTHING;

-- CEO: read/create/approve
INSERT INTO core.role_permissions (role_id, permission_id, data_scope, amount_limit)
SELECT r.id, p.id, 'ALL'::text, NULL::numeric
FROM core.roles r CROSS JOIN core.permissions p
WHERE r.name = 'CEO' AND p.code IN ('FX_RATE_READ','FX_RATE_CREATE','FX_RATE_APPROVE')
ON CONFLICT DO NOTHING;

-- FINANCE_HEAD: read/create/approve
INSERT INTO core.role_permissions (role_id, permission_id, data_scope, amount_limit)
SELECT r.id, p.id, 'ALL'::text, NULL::numeric
FROM core.roles r CROSS JOIN core.permissions p
WHERE r.name = 'FINANCE_HEAD' AND p.code IN ('FX_RATE_READ','FX_RATE_CREATE','FX_RATE_APPROVE')
ON CONFLICT DO NOTHING;

-- ACCOUNTANT: read/create (proposer only — cannot self-approve, matches fx_approve RLS)
INSERT INTO core.role_permissions (role_id, permission_id, data_scope, amount_limit)
SELECT r.id, p.id, 'ALL'::text, NULL::numeric
FROM core.roles r CROSS JOIN core.permissions p
WHERE r.name = 'ACCOUNTANT' AND p.code IN ('FX_RATE_READ','FX_RATE_CREATE')
ON CONFLICT DO NOTHING;

-- VIEWER: read only
INSERT INTO core.role_permissions (role_id, permission_id, data_scope, amount_limit)
SELECT r.id, p.id, 'ALL'::text, NULL::numeric
FROM core.roles r CROSS JOIN core.permissions p
WHERE r.name = 'VIEWER' AND p.code IN ('FX_RATE_READ')
ON CONFLICT DO NOTHING;

-- ================================================================
-- BUG-018 FIX: Equity capital transactions (contributions, owner loans,
-- drawings) are fully dead.
--
-- Root causes fixed here (application-code fix for
-- src/app/api/finance/capital-transactions/route.ts is in the same
-- change set):
--
--   1. The route inserted `debit_account_id`/`credit_account_id`, which
--      do not exist on finance.capital_transactions — the real table
--      only has `financial_account_id` (the bank/cash leg) and
--      `journal_entry_id` (populated once posted). Every create failed.
--   2. The route's "post" action called finance.post_capital_transaction(),
--      an RPC that doesn't exist anywhere in the schema. Every post failed.
--
-- Fix:
--   - Add finance.capital_transactions.equity_account_id — the specific
--     owner-capital / owner-loan-payable / drawings GL account this
--     transaction posts against. financial_account_id already carries
--     the bank/cash leg; together the two legs fully determine the
--     journal entry once the transaction_type says which side is
--     debited vs credited.
--   - A CHECK constraint ensures a transaction can never reach APPROVED
--     or POSTED without both legs set (spec 5.13: capital transactions
--     must have real ledger postings, not just a status field).
--   - No new posting RPC is introduced: the route now builds the two
--     journal lines itself and posts through the existing, already
--     audited finance.post_journal_entry() RPC — the same pattern
--     already used by post-vendor-bill and year-end-close, rather than
--     duplicating posting logic in a second bespoke SQL function.
-- ================================================================

ALTER TABLE finance.capital_transactions
  ADD COLUMN IF NOT EXISTS equity_account_id UUID REFERENCES finance.chart_of_accounts(id);

COMMENT ON COLUMN finance.capital_transactions.equity_account_id IS
  'BUG-018 FIX: the owner-capital / owner-loan-payable / drawings GL account for this transaction. Paired with financial_account_id (the bank/cash leg) to form the two-line journal entry at posting time; transaction_type determines which side is debited vs credited.';

ALTER TABLE finance.capital_transactions
  DROP CONSTRAINT IF EXISTS capital_txn_ready_to_leave_draft;
ALTER TABLE finance.capital_transactions
  ADD CONSTRAINT capital_txn_ready_to_leave_draft
  CHECK (
    status NOT IN ('APPROVED', 'POSTED')
    OR (financial_account_id IS NOT NULL AND equity_account_id IS NOT NULL)
  );

COMMENT ON CONSTRAINT capital_txn_ready_to_leave_draft ON finance.capital_transactions IS
  'BUG-018 FIX: a capital transaction cannot be approved or posted without both the bank/cash leg (financial_account_id) and the equity/loan leg (equity_account_id) set.';

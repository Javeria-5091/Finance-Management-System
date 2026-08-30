-- ═════════════════════════════════════════════════════════════════════
--  BUG-020 FIX: Refunds and milestones reference tables that do not
--  exist.
--
--  src/app/api/finance/invoices/refunds/route.ts,
--  refunds/[id]/route.ts, and invoices/milestones/route.ts all query
--  finance.invoice_refunds / finance.invoice_milestones — neither table
--  exists anywhere in the schema (confirmed: zero occurrences), so both
--  features fail at runtime on every call. This migration adds them.
-- ═════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS finance.invoice_refunds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES core.organizations(id) ON DELETE CASCADE,
  invoice_id UUID NOT NULL REFERENCES public.invoices(id),
  refund_number TEXT NOT NULL,
  amount NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  currency TEXT NOT NULL DEFAULT 'PKR' CHECK (currency ~ '^[A-Z]{3}$'),
  exchange_rate NUMERIC(18,6) NOT NULL DEFAULT 1 CHECK (exchange_rate > 0),
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'POSTED', 'PAID', 'REJECTED')),
  financial_account_id UUID REFERENCES finance.financial_accounts(id),
  journal_entry_id UUID,
  created_by UUID REFERENCES auth.users(id),
  approved_by UUID REFERENCES auth.users(id),
  approved_at TIMESTAMPTZ,
  posted_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT invoice_refunds_number_unique UNIQUE (organization_id, refund_number)
);

CREATE INDEX IF NOT EXISTS idx_invoice_refunds_invoice ON finance.invoice_refunds (invoice_id);
CREATE INDEX IF NOT EXISTS idx_invoice_refunds_org_status ON finance.invoice_refunds (organization_id, status);

ALTER TABLE finance.invoice_refunds ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS invoice_refunds_select_org_scoped ON finance.invoice_refunds;
CREATE POLICY invoice_refunds_select_org_scoped ON finance.invoice_refunds
  FOR SELECT USING ((auth.uid() IS NOT NULL) AND core.same_org(organization_id));

DROP POLICY IF EXISTS invoice_refunds_insert_org_scoped ON finance.invoice_refunds;
CREATE POLICY invoice_refunds_insert_org_scoped ON finance.invoice_refunds
  FOR INSERT WITH CHECK ((auth.uid() IS NOT NULL) AND core.same_org(organization_id));

DROP POLICY IF EXISTS invoice_refunds_update_org_scoped ON finance.invoice_refunds;
CREATE POLICY invoice_refunds_update_org_scoped ON finance.invoice_refunds
  FOR UPDATE USING ((auth.uid() IS NOT NULL) AND core.same_org(organization_id))
  WITH CHECK ((auth.uid() IS NOT NULL) AND core.same_org(organization_id));

COMMENT ON TABLE finance.invoice_refunds IS 'BUG-020 fix: table did not exist; src/app/api/finance/invoices/refunds/route.ts failed at runtime on every call.';

-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS finance.invoice_milestones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES core.organizations(id) ON DELETE CASCADE,
  invoice_id UUID NOT NULL REFERENCES public.invoices(id),
  milestone_ref TEXT NOT NULL,
  description TEXT NOT NULL,
  milestone_date DATE NOT NULL,
  amount NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  percentage NUMERIC(5,2) CHECK (percentage IS NULL OR (percentage > 0 AND percentage <= 100)),
  evidence_ref TEXT,
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT invoice_milestones_ref_unique UNIQUE (invoice_id, milestone_ref)
);

CREATE INDEX IF NOT EXISTS idx_invoice_milestones_invoice ON finance.invoice_milestones (invoice_id);

ALTER TABLE finance.invoice_milestones ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS invoice_milestones_select_org_scoped ON finance.invoice_milestones;
CREATE POLICY invoice_milestones_select_org_scoped ON finance.invoice_milestones
  FOR SELECT USING ((auth.uid() IS NOT NULL) AND core.same_org(organization_id));

DROP POLICY IF EXISTS invoice_milestones_insert_org_scoped ON finance.invoice_milestones;
CREATE POLICY invoice_milestones_insert_org_scoped ON finance.invoice_milestones
  FOR INSERT WITH CHECK ((auth.uid() IS NOT NULL) AND core.same_org(organization_id));

DROP POLICY IF EXISTS invoice_milestones_update_org_scoped ON finance.invoice_milestones;
CREATE POLICY invoice_milestones_update_org_scoped ON finance.invoice_milestones
  FOR UPDATE USING ((auth.uid() IS NOT NULL) AND core.same_org(organization_id))
  WITH CHECK ((auth.uid() IS NOT NULL) AND core.same_org(organization_id));

COMMENT ON TABLE finance.invoice_milestones IS 'BUG-020 fix: table did not exist; src/app/api/finance/invoices/milestones/route.ts failed at runtime on every call.';

-- ═════════════════════════════════════════════════════════════════════
--  BUG-032 FIX: Income vs invoice double counting is unguarded.
--
--  public.incomes had no invoice/client linkage at all, and
--  post-income/route.ts posted DR Receivable / CR Revenue for any
--  APPROVED income with no check for whether that same revenue event
--  had already been recognized via the invoices module — spec 10.6
--  requires incomes to be "mapped to invoice/payment sources to avoid
--  double counting."
--
--  Fix: add an optional invoice_id linkage, and make it load-bearing —
--  once an income is linked to an invoice, post-income refuses to also
--  post a fresh Receivable/Revenue entry for it (see route.ts), because
--  that revenue was already recognized when the invoice itself was
--  posted. A partial unique index adds a second line of defense at the
--  DB level against the same invoice ever being linked from more than
--  one POSTED income row, in case that ever changes.
-- ═════════════════════════════════════════════════════════════════════

ALTER TABLE public.incomes
  ADD COLUMN IF NOT EXISTS invoice_id UUID REFERENCES public.invoices(id),
  ADD COLUMN IF NOT EXISTS client_id UUID;

CREATE INDEX IF NOT EXISTS idx_incomes_invoice_id ON public.incomes (invoice_id) WHERE invoice_id IS NOT NULL;

-- At most one POSTED income may ever reference a given invoice.
CREATE UNIQUE INDEX IF NOT EXISTS uq_incomes_invoice_posted
  ON public.incomes (invoice_id)
  WHERE invoice_id IS NOT NULL AND status = 'POSTED';

COMMENT ON COLUMN public.incomes.invoice_id IS 'BUG-032 fix: optional link to the invoice this income represents payment/revenue for. post-income/route.ts refuses to GL-post an income with invoice_id set, since that revenue is already recognized by the invoice — link it here instead of double-recording it as separate income.';
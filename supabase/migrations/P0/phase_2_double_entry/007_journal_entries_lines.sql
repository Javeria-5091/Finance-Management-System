-- ==========================================
-- JOURNAL ENTRIES (Header Table)
-- ==========================================
CREATE TABLE IF NOT EXISTS finance.journal_entries (
    -- Default columns
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL NOT NULL,
    
    -- Business columns
    reference TEXT NOT NULL,
    description TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN (
        'DRAFT', 'SUBMITTED', 'VERIFIED', 'APPROVED', 'POSTED', 
        'REVERSED', 'REJECTED', 'CANCELLED'
    )),
    transaction_date DATE NOT NULL,
    posting_date DATE,
    period_id UUID NOT NULL REFERENCES finance.accounting_periods(id),
    fiscal_year_id UUID NOT NULL REFERENCES finance.fiscal_years(id),
    
    -- Multi-currency
    currency TEXT NOT NULL DEFAULT 'PKR',
    exchange_rate NUMERIC(18,4) DEFAULT 1.0000,
    base_currency TEXT NOT NULL DEFAULT 'PKR',
    
    -- Totals (Maintained by trigger)
    total_debit NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (total_debit >= 0),
    total_credit NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (total_credit >= 0),
    
    -- Source tracking (Kis cheez ne yeh journal generate kiya?)
    source_type TEXT, -- 'INCOME', 'EXPENSE', 'INVOICE', 'MANUAL'
    source_id UUID,
    
    -- Dimensions
    project_id UUID REFERENCES public.projects(id) ON DELETE SET NULL,
    department_id UUID,
    cost_center_id UUID,
    attachment_ids UUID[],
    
    -- Notes & Rejection
    notes TEXT,
    rejection_reason TEXT,
    
    -- Reversal tracking
    reversal_of_id UUID REFERENCES finance.journal_entries(id) ON DELETE SET NULL,
    reversal_reason TEXT,
    
    -- Workflow stamps (Rule 3 & Workflow requirement)
    submitted_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    submitted_at TIMESTAMPTZ,
    verified_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    verified_at TIMESTAMPTZ,
    approved_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    approved_at TIMESTAMPTZ,
    posted_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    posted_at TIMESTAMPTZ,
    reversed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    reversed_at TIMESTAMPTZ,
    
    -- Constraints
    CONSTRAINT je_reference_unique UNIQUE (reference),
    CONSTRAINT je_date_not_null CHECK (transaction_date IS NOT NULL)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_je_status ON finance.journal_entries(status);
CREATE INDEX IF NOT EXISTS idx_je_date ON finance.journal_entries(transaction_date DESC);
CREATE INDEX IF NOT EXISTS idx_je_period ON finance.journal_entries(period_id);
CREATE INDEX IF NOT EXISTS idx_je_source ON finance.journal_entries(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_je_project ON finance.journal_entries(project_id);
CREATE INDEX IF NOT EXISTS idx_je_created_by ON finance.journal_entries(created_by);

-- Updated_at trigger
DROP TRIGGER IF EXISTS je_updated_at ON finance.journal_entries;
CREATE TRIGGER je_updated_at BEFORE UPDATE ON finance.journal_entries
    FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

-- ==========================================
-- JOURNAL LINES (Detail Table)
-- ==========================================
CREATE TABLE IF NOT EXISTS finance.journal_lines (
    -- Default columns
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    
    -- Business columns
    journal_entry_id UUID NOT NULL REFERENCES finance.journal_entries(id) ON DELETE CASCADE,
    line_number INTEGER NOT NULL CHECK (line_number > 0),
    account_id UUID NOT NULL REFERENCES finance.chart_of_accounts(id),
    description TEXT,
    
    -- Amounts (RULE 2: Strict NUMERIC)
    debit_amount NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (debit_amount >= 0),
    credit_amount NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (credit_amount >= 0),
    
    -- Multi-currency at line level (rarely different from header, but standard practice)
    currency TEXT NOT NULL DEFAULT 'PKR',
    exchange_rate NUMERIC(18,4),
    base_debit NUMERIC(18,2),
    base_credit NUMERIC(18,2),
    
    -- Dimensions at line level
    project_id UUID,
    department_id UUID,
    cost_center_id UUID,
    tax_code_id UUID, -- Future use
    matching_ref TEXT, -- For bank reconciliation
    
    -- Constraints
    CONSTRAINT jl_one_side_only CHECK (debit_amount = 0 OR credit_amount = 0),
    CONSTRAINT jl_entry_line_unique UNIQUE (journal_entry_id, line_number)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_jl_entry_id ON finance.journal_lines(journal_entry_id);
CREATE INDEX IF NOT EXISTS idx_jl_account_id ON finance.journal_lines(account_id);

-- Updated_at trigger
DROP TRIGGER IF EXISTS jl_updated_at ON finance.journal_lines;
CREATE TRIGGER jl_updated_at BEFORE UPDATE ON finance.journal_lines
    FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

-- ==========================================
-- CRITICAL TRIGGERS
-- ==========================================

-- 1. BALANCE CHECK TRIGGER (Dr must equal Cr)
CREATE OR REPLACE FUNCTION finance.check_journal_balance()
RETURNS TRIGGER AS $$ DECLARE
  v_total_dr NUMERIC(18,2);
  v_total_cr NUMERIC(18,2);
  v_diff NUMERIC(18,4);
BEGIN
  SELECT 
    COALESCE(SUM(debit_amount), 0),
    COALESCE(SUM(credit_amount), 0)
  INTO v_total_dr, v_total_cr
  FROM finance.journal_lines
  WHERE journal_entry_id = COALESCE(NEW.journal_entry_id, OLD.journal_entry_id);

  v_diff := ABS(v_total_dr - v_total_cr);

  -- Allow 0.01 tolerance for rounding
  IF v_diff > 0.01 THEN
    RAISE EXCEPTION 'Journal entry unbalanced: Debit=%, Credit=%, Diff=%', 
      v_total_dr, v_total_cr, v_diff;
  END IF;

  -- Update header totals
  UPDATE finance.journal_entries
  SET total_debit = v_total_dr,
      total_credit = v_total_cr
  WHERE id = COALESCE(NEW.journal_entry_id, OLD.journal_entry_id);

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
 $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_journal_balance ON finance.journal_lines;
CREATE TRIGGER trg_journal_balance
AFTER INSERT OR UPDATE OR DELETE ON finance.journal_lines
FOR EACH ROW EXECUTE FUNCTION finance.check_journal_balance();

-- 2. POSTED ENTRY PROTECTION (Cannot edit lines if Posted)
CREATE OR REPLACE FUNCTION finance.prevent_posted_edit()
RETURNS TRIGGER AS $$ BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    IF EXISTS (
      SELECT 1 FROM finance.journal_entries 
      WHERE id = OLD.journal_entry_id AND status = 'POSTED'
    ) THEN
      RAISE EXCEPTION 'Cannot modify journal lines of a POSTED entry. Create a Reversal.';
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.account_id != NEW.account_id THEN
    IF EXISTS (
      SELECT 1 FROM finance.journal_entries 
      WHERE id = OLD.journal_entry_id AND status IN ('VERIFIED', 'APPROVED')
    ) THEN
      RAISE EXCEPTION 'Cannot change account on a verified/approved journal.';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
 $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prevent_posted_line_edit ON finance.journal_lines;
CREATE TRIGGER trg_prevent_posted_line_edit
BEFORE UPDATE OR DELETE ON finance.journal_lines
FOR EACH ROW EXECUTE FUNCTION finance.prevent_posted_edit();

-- 3. CLOSED PERIOD PROTECTION
CREATE OR REPLACE FUNCTION finance.prevent_closed_period_posting()
RETURNS TRIGGER AS $$ DECLARE
  v_period_status TEXT;
BEGIN
  SELECT status INTO v_period_status
  FROM finance.accounting_periods WHERE id = NEW.period_id;

  IF v_period_status = 'HARD_CLOSED' THEN
    RAISE EXCEPTION 'Cannot post to a HARD CLOSED period.';
  END IF;

  IF v_period_status = 'SOFT_CLOSED' AND NEW.status = 'POSTED' THEN
    RAISE EXCEPTION 'Cannot post to a SOFT CLOSED period without special authorization.';
  END IF;

  RETURN NEW;
END;
 $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prevent_closed_period ON finance.journal_entries;
CREATE TRIGGER trg_prevent_closed_period
BEFORE UPDATE ON finance.journal_entries
FOR EACH ROW 
WHEN (NEW.status = 'POSTED' AND OLD.status != 'POSTED')
EXECUTE FUNCTION finance.prevent_closed_period_posting();

-- ==========================================
-- RLS POLICIES
-- ==========================================
ALTER TABLE finance.journal_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance.journal_lines ENABLE ROW LEVEL SECURITY;

-- Journal Entries Policies
CREATE POLICY "je_select_own" ON finance.journal_entries FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "je_insert" ON finance.journal_entries FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
-- Update restricted by triggers, but RLS needs base policy
CREATE POLICY "je_update" ON finance.journal_entries FOR UPDATE USING (auth.uid() IS NOT NULL);
-- DELETE only allowed if DRAFT (Enforced in app logic, RLS allows own)
CREATE POLICY "je_delete" ON finance.journal_entries FOR DELETE USING (
    auth.uid() = created_by AND status = 'DRAFT'
);

-- Journal Lines Policies (Inherits logic from entry)
CREATE POLICY "jl_select" ON finance.journal_lines FOR SELECT USING (
    EXISTS (SELECT 1 FROM finance.journal_entries WHERE id = journal_entry_id)
);
CREATE POLICY "jl_insert" ON finance.journal_lines FOR INSERT WITH CHECK (
    EXISTS (SELECT 1 FROM finance.journal_entries WHERE id = journal_entry_id AND status = 'DRAFT')
);
CREATE POLICY "jl_update" ON finance.journal_lines FOR UPDATE USING (
    EXISTS (SELECT 1 FROM finance.journal_entries WHERE id = journal_entry_id AND status = 'DRAFT')
);
CREATE POLICY "jl_delete" ON finance.journal_lines FOR DELETE USING (
    EXISTS (SELECT 1 FROM finance.journal_entries WHERE id = journal_entry_id AND status = 'DRAFT')
);

-- Apply Audit Triggers
DROP TRIGGER IF EXISTS je_audit ON finance.journal_entries;
CREATE TRIGGER je_audit AFTER INSERT OR UPDATE ON finance.journal_entries
    FOR EACH ROW EXECUTE FUNCTION audit.trigger_audit_log();

DROP TRIGGER IF EXISTS jl_audit ON finance.journal_lines;
CREATE TRIGGER jl_audit AFTER INSERT OR UPDATE OR DELETE ON finance.journal_lines
    FOR EACH ROW EXECUTE FUNCTION audit.trigger_audit_log();
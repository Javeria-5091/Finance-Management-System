-- ==========================================
-- PHASE 1 - STEP 1.6: Numbering Sequences
-- FIXED: Replaced UNIQUE constraint with UNIQUE INDEX
-- ==========================================

-- Drop existing
DROP TABLE IF EXISTS finance.numbering_sequences CASCADE;
DROP VIEW IF EXISTS finance.sequence_status CASCADE;

-- ==========================================
-- TABLE CREATION
-- ==========================================
CREATE TABLE finance.numbering_sequences (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    
    sequence_type TEXT NOT NULL,
    prefix TEXT NOT NULL,
    current_number INTEGER NOT NULL DEFAULT 0,
    padding INTEGER NOT NULL DEFAULT 4 CHECK (padding BETWEEN 1 AND 10),
    fiscal_year_id UUID REFERENCES finance.fiscal_years(id) ON DELETE SET NULL,
    reset_per_period BOOLEAN DEFAULT false,
    format TEXT NOT NULL DEFAULT '{PREFIX}{NUMBER}',
    
    -- Other constraints
    CONSTRAINT ns_format_valid CHECK (format LIKE '%{PREFIX}%' AND format LIKE '%{NUMBER}%'),
    CONSTRAINT ns_current_non_negative CHECK (current_number >= 0)
);

-- ==========================================
-- INDEXES
-- ==========================================
CREATE INDEX idx_ns_type ON finance.numbering_sequences(sequence_type);

-- FIX: Unique index instead of constraint (allows COALESCE)
CREATE UNIQUE INDEX idx_ns_type_fy_unique ON finance.numbering_sequences (
    sequence_type, 
    COALESCE(fiscal_year_id::TEXT, 'GLOBAL')
);

-- Trigger
CREATE TRIGGER ns_updated_at
    BEFORE UPDATE ON finance.numbering_sequences
    FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

-- ==========================================
-- FUNCTION: Get Next Number (Thread-Safe)
-- ==========================================
CREATE OR REPLACE FUNCTION finance.get_next_number(p_type TEXT)
RETURNS TEXT AS $$ DECLARE
    v_seq RECORD;
    v_next_num INTEGER;
    v_result TEXT;
    v_fy_id UUID;
BEGIN
    SELECT id INTO v_fy_id 
    FROM finance.fiscal_years 
    WHERE status = 'OPEN' 
    ORDER BY start_date DESC 
    LIMIT 1;
    
    SELECT * INTO v_seq 
    FROM finance.numbering_sequences 
    WHERE sequence_type = p_type 
      AND (fiscal_year_id = v_fy_id OR fiscal_year_id IS NULL)
    ORDER BY fiscal_year_id DESC NULLS LAST
    LIMIT 1
    FOR UPDATE;
    
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Numbering sequence not found for type: %', p_type;
    END IF;
    
    v_next_num := v_seq.current_number + 1;
    
    UPDATE finance.numbering_sequences 
    SET current_number = v_next_num 
    WHERE id = v_seq.id;
    
    v_result := REPLACE(v_seq.format, '{PREFIX}', v_seq.prefix);
    v_result := REPLACE(v_result, '{NUMBER}', LPAD(v_next_num::TEXT, v_seq.padding, '0'));
    
    RETURN v_result;
END;
 $$ LANGUAGE plpgsql;

-- ==========================================
-- FUNCTION: Peek Next Number
-- ==========================================
CREATE OR REPLACE FUNCTION finance.peek_next_number(p_type TEXT)
RETURNS TEXT AS $$ DECLARE
    v_seq RECORD;
    v_next_num INTEGER;
    v_result TEXT;
    v_fy_id UUID;
BEGIN
    SELECT id INTO v_fy_id 
    FROM finance.fiscal_years 
    WHERE status = 'OPEN' 
    ORDER BY start_date DESC 
    LIMIT 1;
    
    SELECT * INTO v_seq 
    FROM finance.numbering_sequences 
    WHERE sequence_type = p_type 
      AND (fiscal_year_id = v_fy_id OR fiscal_year_id IS NULL)
    ORDER BY fiscal_year_id DESC NULLS LAST
    LIMIT 1;
    
    IF NOT FOUND THEN
        RETURN 'N/A';
    END IF;
    
    v_next_num := v_seq.current_number + 1;
    
    v_result := REPLACE(v_seq.format, '{PREFIX}', v_seq.prefix);
    v_result := REPLACE(v_result, '{NUMBER}', LPAD(v_next_num::TEXT, v_seq.padding, '0'));
    
    RETURN v_result;
END;
 $$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- ==========================================
-- FUNCTION: Reset Sequence
-- ==========================================
CREATE OR REPLACE FUNCTION finance.reset_sequence(p_type TEXT, p_fy_id UUID)
RETURNS VOID AS $$ BEGIN
    INSERT INTO finance.numbering_sequences (sequence_type, prefix, padding, fiscal_year_id, reset_per_period, format, created_by)
    SELECT 
        sequence_type, prefix, padding, p_fy_id, reset_per_period, format, auth.uid()
    FROM finance.numbering_sequences 
    WHERE sequence_type = p_type 
      AND fiscal_year_id IS NULL
    ON CONFLICT DO NOTHING;
END;
 $$ LANGUAGE plpgsql SECURITY DEFINER;

-- ==========================================
-- SEED DATA
-- ==========================================
INSERT INTO finance.numbering_sequences (sequence_type, prefix, padding, reset_per_period, format, created_by) VALUES
('INVOICE', 'INV-', 4, false, '{PREFIX}{NUMBER}', (SELECT id FROM auth.users LIMIT 1)),
('CREDIT_NOTE', 'CN-', 4, false, '{PREFIX}{NUMBER}', (SELECT id FROM auth.users LIMIT 1)),
('VENDOR_BILL', 'VB-', 4, false, '{PREFIX}{NUMBER}', (SELECT id FROM auth.users LIMIT 1)),
('JOURNAL_ENTRY', 'JE-', 4, false, '{PREFIX}{NUMBER}', (SELECT id FROM auth.users LIMIT 1)),
('EXPENSE', 'EXP-', 4, false, '{PREFIX}{NUMBER}', (SELECT id FROM auth.users LIMIT 1)),
('INCOME', 'INC-', 4, false, '{PREFIX}{NUMBER}', (SELECT id FROM auth.users LIMIT 1)),
('PAYMENT', 'PAY-', 4, false, '{PREFIX}{NUMBER}', (SELECT id FROM auth.users LIMIT 1)),
('VENDOR_PAYMENT', 'VP-', 4, false, '{PREFIX}{NUMBER}', (SELECT id FROM auth.users LIMIT 1)),
('BANK_TRANSFER', 'BT-', 4, false, '{PREFIX}{NUMBER}', (SELECT id FROM auth.users LIMIT 1)),
('RECONCILIATION', 'REC-', 4, false, '{PREFIX}{NUMBER}', (SELECT id FROM auth.users LIMIT 1));

-- ==========================================
-- VIEW
-- ==========================================
CREATE OR REPLACE VIEW finance.sequence_status AS
SELECT 
    ns.id,
    ns.sequence_type,
    ns.prefix,
    ns.current_number,
    ns.padding,
    ns.format,
    finance.peek_next_number(ns.sequence_type) AS next_number_preview
FROM finance.numbering_sequences ns
ORDER BY ns.sequence_type;

-- ==========================================
-- ROW LEVEL SECURITY
-- ==========================================
ALTER TABLE finance.numbering_sequences ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ns_select" ON finance.numbering_sequences
    FOR SELECT USING (auth.uid() IS NOT NULL);

-- Functions need SECURITY DEFINER
ALTER FUNCTION finance.get_next_number(TEXT) SECURITY DEFINER;
ALTER FUNCTION finance.peek_next_number(TEXT) SECURITY DEFINER;
ALTER FUNCTION finance.reset_sequence(TEXT, UUID) SECURITY DEFINER;

GRANT SELECT ON finance.sequence_status TO authenticated;
-- ==========================================
-- PHASE 4: AGING VIEW & AUTO-STATUS TRIGGER
-- ==========================================

-- 1. RECEIVABLE AGING VIEW
CREATE OR REPLACE VIEW reporting.receivable_aging AS
SELECT 
  i.id AS invoice_id,
  i.invoice_number,
  i.client_name,
  i.project_id,
  i.currency,
  i.total_amount,
  i.base_total_amount AS total_base_amount,
  i.amount_paid,
  i.base_amount_paid AS paid_base_amount,
  i.outstanding_amount,
  i.base_outstanding_amount AS outstanding_base_amount,
  i.due_date,
  i.issue_date,
  i.status,
  -- Aging buckets (calculated purely in Base/PKR)
  CASE 
    WHEN i.outstanding_amount <= 0 THEN 0
    WHEN i.due_date >= CURRENT_DATE THEN i.base_outstanding_amount
    ELSE 0
  END AS current_amount,
  CASE 
    WHEN i.due_date < CURRENT_DATE 
      AND i.due_date >= CURRENT_DATE - INTERVAL '30 days' THEN i.base_outstanding_amount
    ELSE 0
  END AS overdue_1_30_days,
  CASE 
    WHEN i.due_date < CURRENT_DATE - INTERVAL '30 days' 
      AND i.due_date >= CURRENT_DATE - INTERVAL '60 days' THEN i.base_outstanding_amount
    ELSE 0
  END AS overdue_31_60_days,
  CASE 
    WHEN i.due_date < CURRENT_DATE - INTERVAL '60 days' 
      AND i.due_date >= CURRENT_DATE - INTERVAL '90 days' THEN i.base_outstanding_amount
    ELSE 0
  END AS overdue_61_90_days,
  CASE 
    WHEN i.due_date < CURRENT_DATE - INTERVAL '90 days' THEN i.base_outstanding_amount
    ELSE 0
  END AS overdue_over_90_days
FROM public.invoices i
WHERE i.status IN ('ISSUED', 'PARTIALLY_PAID', 'PAID', 'OVERDUE');

-- 2. AUTO-UPDATE INVOICE STATUS TRIGGER
CREATE OR REPLACE FUNCTION finance.auto_update_invoice_status()
RETURNS TRIGGER AS $$ DECLARE
  v_outstanding NUMERIC(18,2);
  v_total NUMERIC(18,2);
  v_base_outstanding NUMERIC(18,2);
BEGIN
  -- Calculate total allocated against this invoice
  SELECT 
    i.total_amount - COALESCE(SUM(pa.allocated_amount), 0),
    i.base_total_amount - COALESCE(SUM(pa.base_allocated_amount), 0)
  INTO v_outstanding, v_base_outstanding
  FROM public.invoices i
  LEFT JOIN finance.payment_allocations pa ON pa.invoice_id = i.id
  WHERE i.id = NEW.invoice_id
  GROUP BY i.total_amount, i.base_total_amount;
  
  -- Get totals
  SELECT total_amount, base_total_amount INTO v_total, v_base_outstanding 
  FROM public.invoices WHERE id = NEW.invoice_id;
  
  -- Update balances and status based on outstanding
  UPDATE public.invoices SET 
    amount_paid = v_total - v_outstanding,
    base_amount_paid = v_base_outstanding - v_base_outstanding,
    outstanding_amount = v_outstanding,
    base_outstanding_amount = v_base_outstanding,
    status = CASE 
      WHEN v_outstanding <= 0 THEN 'PAID'
      WHEN v_outstanding < v_total THEN 'PARTIALLY_PAID'
      ELSE status -- Keep existing if still fully unpaid
    END
  WHERE id = NEW.invoice_id;
  
  RETURN NEW;
END;
 $$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_alloc_status_update ON finance.payment_allocations;
CREATE TRIGGER trg_alloc_status_update
AFTER INSERT OR UPDATE OR DELETE ON finance.payment_allocations
FOR EACH ROW EXECUTE FUNCTION finance.auto_update_invoice_status();
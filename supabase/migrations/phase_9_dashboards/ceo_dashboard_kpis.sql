-- ==========================================
-- CEO DASHBOARD - COMPLETE RPC FUNCTIONS (FIXED)
-- ==========================================

-- 1. ALL KPIs + Risks in One Call
CREATE OR REPLACE FUNCTION reporting.ceo_dashboard_kpis()
RETURNS JSON AS $$ DECLARE
  v_period_id UUID;
  v_prev_period_id UUID;
  v_total_cash NUMERIC := 0;
  v_monthly_expense NUMERIC := 0;
BEGIN
  SELECT id INTO v_period_id FROM finance.accounting_periods WHERE status = 'OPEN' ORDER BY start_date DESC LIMIT 1;
  SELECT id INTO v_prev_period_id FROM finance.accounting_periods WHERE status IN ('OPEN','SOFT_CLOSED','HARD_CLOSED') AND id != v_period_id ORDER BY start_date DESC LIMIT 1;
  
  SELECT COALESCE(SUM(opening_balance), 0) INTO v_total_cash FROM finance.financial_accounts WHERE is_active = true;
  
  SELECT COALESCE(SUM(jl.debit_amount - jl.credit_amount) / NULLIF(COUNT(DISTINCT je.period_id), 1), 0) INTO v_monthly_expense
  FROM finance.journal_lines jl
  JOIN finance.journal_entries je ON je.id = jl.journal_entry_id
  JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id
  JOIN finance.accounting_periods ap ON ap.id = je.period_id
  WHERE je.status = 'POSTED'
    AND ca.account_type IN ('COST_OF_SALES','OPERATING_EXPENSE','OTHER_EXPENSE')
    AND ap.status IN ('SOFT_CLOSED','HARD_CLOSED')
    AND ap.end_date >= CURRENT_DATE - INTERVAL '4 months'
    AND ap.start_date < CURRENT_DATE;
    
  IF v_monthly_expense = 0 THEN
    SELECT COALESCE(SUM(jl.debit_amount - jl.credit_amount) / 3, 0) INTO v_monthly_expense
    FROM finance.journal_lines jl
    JOIN finance.journal_entries je ON je.id = jl.journal_entry_id
    JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id
    WHERE je.status = 'POSTED' AND ca.account_type IN ('COST_OF_SALES','OPERATING_EXPENSE','OTHER_EXPENSE');
  END IF;

  RETURN json_build_object(
    'revenue_mtd', COALESCE((SELECT SUM(jl.credit_amount - jl.debit_amount) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.id = jl.journal_entry_id WHERE je.period_id = v_period_id AND je.status = 'POSTED' AND ca.account_type = 'REVENUE'), 0),
    'revenue_prev', COALESCE((SELECT SUM(jl.credit_amount - jl.debit_amount) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.id = jl.journal_entry_id WHERE je.period_id = v_prev_period_id AND je.status = 'POSTED' AND ca.account_type = 'REVENUE'), 0),
    'cogs_mtd', COALESCE((SELECT SUM(jl.debit_amount - jl.credit_amount) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.id = jl.journal_entry_id WHERE je.period_id = v_period_id AND je.status = 'POSTED' AND ca.account_type = 'COST_OF_SALES'), 0),
    'opex_mtd', COALESCE((SELECT SUM(jl.debit_amount - jl.credit_amount) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.id = jl.journal_entry_id WHERE je.period_id = v_period_id AND je.status = 'POSTED' AND ca.account_type = 'OPERATING_EXPENSE'), 0),
    'other_income_mtd', COALESCE((SELECT SUM(jl.credit_amount - jl.debit_amount) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.id = jl.journal_entry_id WHERE je.period_id = v_period_id AND je.status = 'POSTED' AND ca.account_type = 'OTHER_INCOME'), 0),
    'other_expense_mtd', COALESCE((SELECT SUM(jl.debit_amount - jl.credit_amount) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.id = jl.journal_entry_id WHERE je.period_id = v_period_id AND je.status = 'POSTED' AND ca.account_type = 'OTHER_EXPENSE'), 0),
    'net_profit_mtd', COALESCE((SELECT SUM(CASE WHEN ca.normal_balance = 'CREDIT' THEN jl.credit_amount - jl.debit_amount ELSE jl.debit_amount - jl.credit_amount END) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.id = jl.journal_entry_id WHERE je.period_id = v_period_id AND je.status = 'POSTED' AND ca.account_type IN ('REVENUE','COST_OF_SALES','OPERATING_EXPENSE','OTHER_INCOME','OTHER_EXPENSE')), 0),
    'net_profit_prev', COALESCE((SELECT SUM(CASE WHEN ca.normal_balance = 'CREDIT' THEN jl.credit_amount - jl.debit_amount ELSE jl.debit_amount - jl.credit_amount END) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.id = jl.journal_entry_id WHERE je.period_id = v_prev_period_id AND je.status = 'POSTED' AND ca.account_type IN ('REVENUE','COST_OF_SALES','OPERATING_EXPENSE','OTHER_INCOME','OTHER_EXPENSE')), 0),
    'total_assets', COALESCE((SELECT SUM(CASE WHEN ca.code LIKE '153%' THEN jl.credit_amount - jl.debit_amount ELSE jl.debit_amount - jl.credit_amount END) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.status = 'POSTED' WHERE ca.account_type = 'ASSET'), 0),
    'current_assets', COALESCE((SELECT SUM(jl.debit_amount - jl.credit_amount) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.status = 'POSTED' WHERE ca.account_type = 'ASSET' AND ca.code LIKE '1%'), 0),
    'fixed_assets_net', COALESCE((SELECT SUM(CASE WHEN ca.code LIKE '153%' THEN jl.credit_amount - jl.debit_amount ELSE jl.debit_amount - jl.credit_amount END) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.status = 'POSTED' WHERE ca.code LIKE '15%' OR ca.code LIKE '153%'), 0),
    'total_liabilities', COALESCE((SELECT SUM(jl.credit_amount - jl.debit_amount) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.status = 'POSTED' WHERE ca.account_type = 'LIABILITY'), 0),
    'current_liabilities', COALESCE((SELECT SUM(jl.credit_amount - jl.debit_amount) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.status = 'POSTED' WHERE ca.account_type = 'LIABILITY' AND ca.code LIKE '2%'), 0),
    'total_cash', v_total_cash,
    'cash_runway_months', CASE WHEN v_monthly_expense > 0 THEN FLOOR(v_total_cash / v_monthly_expense) ELSE 0 END,
    'accounts_receivable', COALESCE((SELECT SUM(COALESCE(outstanding_amount, 0)) FROM public.invoices WHERE status IN ('ISSUED','PARTIALLY_PAID','OVERDUE')), 0),
    'accounts_payable', COALESCE((SELECT SUM(COALESCE(outstanding_amount, 0)) FROM finance.vendor_bills WHERE status IN ('POSTED','PARTIALLY_PAID')), 0),
    'retained_earnings', COALESCE((SELECT SUM(jl.credit_amount - jl.debit_amount) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.status = 'POSTED' WHERE ca.code = '3200'), 0),
    'reserve_balance', COALESCE((SELECT SUM(jl.credit_amount - jl.debit_amount) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.status = 'POSTED' WHERE ca.code LIKE '33%'), 0),
    'owner_capital', COALESCE((SELECT SUM(jl.credit_amount - jl.debit_amount) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.status = 'POSTED' WHERE ca.code = '3110'), 0),
    'owner_drawings', COALESCE((SELECT SUM(jl.debit_amount - jl.credit_amount) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.status = 'POSTED' WHERE ca.code = '2420'), 0),
    'distributable_profit', GREATEST(
      COALESCE((SELECT SUM(CASE WHEN ca.normal_balance = 'CREDIT' THEN jl.credit_amount - jl.debit_amount ELSE jl.debit_amount - jl.credit_amount END) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.status = 'POSTED' WHERE ca.account_type IN ('REVENUE','COST_OF_SALES','OPERATING_EXPENSE','OTHER_INCOME','OTHER_EXPENSE')), 0)
      - COALESCE((SELECT SUM(jl.debit_amount - jl.credit_amount) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.status = 'POSTED' WHERE ca.code = '7111'), 0)
      - COALESCE((SELECT SUM(jl.credit_amount - jl.debit_amount) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.status = 'POSTED' WHERE ca.code LIKE '33%'), 0),
      0
    ),
    'pending_approvals', (
      COALESCE((SELECT COUNT(*) FROM public.invoices WHERE status = 'SUBMITTED'), 0) +
      COALESCE((SELECT COUNT(*) FROM finance.vendor_bills WHERE status IN ('SUBMITTED','VERIFIED')), 0) +
      COALESCE((SELECT COUNT(*) FROM public.expenses WHERE status = 'SUBMITTED'), 0)
    ),
    'unreconciled_lines', COALESCE((SELECT COUNT(*) FROM finance.statement_lines WHERE reconciliation_status = 'UNRECONCILED'), 0),
    'risk_overdue_receivables', COALESCE((SELECT COUNT(*) FROM public.invoices WHERE status = 'OVERDUE'), 0),
    'risk_overdue_payables', COALESCE((SELECT COUNT(*) FROM finance.vendor_bills WHERE status IN ('POSTED','PARTIALLY_PAID') AND due_date < CURRENT_DATE), 0),
    'risk_unreconciled', COALESCE((SELECT COUNT(DISTINCT bank_statement_id) FROM finance.statement_lines WHERE reconciliation_status = 'UNRECONCILED'), 0),
    'risk_pending_period_close', COALESCE((SELECT COUNT(*) FROM finance.accounting_periods WHERE status = 'OPEN' AND end_date < CURRENT_DATE + INTERVAL '7 days'), 0)
  );
END;
 $$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- 2. Monthly Revenue vs Expenses
CREATE OR REPLACE FUNCTION reporting.ceo_chart_monthly()
RETURNS JSON AS $$ BEGIN
  RETURN COALESCE(json_agg(row_to_json(t) ORDER BY sort_order), '[]'::JSON) FROM (
    SELECT TO_CHAR(ap.start_date, 'Mon YYYY') as month, TO_CHAR(ap.start_date, 'YY-MM') as month_short,
      COALESCE(SUM(CASE WHEN ca.account_type = 'REVENUE' THEN jl.credit_amount - jl.debit_amount ELSE 0 END), 0) as revenue,
      COALESCE(SUM(CASE WHEN ca.account_type IN ('COST_OF_SALES','OPERATING_EXPENSE','OTHER_EXPENSE') THEN jl.debit_amount - jl.credit_amount ELSE 0 END), 0) as expenses,
      ap.start_date as sort_order
    FROM finance.accounting_periods ap
    LEFT JOIN finance.journal_entries je ON je.period_id = ap.id AND je.status = 'POSTED'
    LEFT JOIN finance.journal_lines jl ON jl.journal_entry_id = je.id
    LEFT JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id
    WHERE ap.start_date >= CURRENT_DATE - INTERVAL '6 months'
    GROUP BY ap.id, ap.start_date
  ) t;
END;
 $$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- 3. Expense Categories + Asset/Liability Breakdown (FIXED: = to LIKE, GROUP BY fixed)
CREATE OR REPLACE FUNCTION reporting.ceo_chart_categories()
RETURNS JSON AS $$ BEGIN
  RETURN json_build_object(
    'expenses', COALESCE((SELECT json_agg(row_to_json(t) ORDER BY total DESC) FROM (
      SELECT 
        CASE ca.account_type
          WHEN 'COST_OF_SALES' THEN 'Cost of Sales'
          WHEN 'OPERATING_EXPENSE' THEN 'Operating Expenses'
          WHEN 'OTHER_EXPENSE' THEN 'Other Expenses'
          ELSE ca.account_type
        END as category,
        SUM(jl.debit_amount - jl.credit_amount) as total
      FROM finance.journal_lines jl
      JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id
      JOIN finance.journal_entries je ON je.id = jl.journal_entry_id
      WHERE je.status = 'POSTED' AND ca.account_type IN ('COST_OF_SALES','OPERATING_EXPENSE','OTHER_EXPENSE')
      GROUP BY ca.account_type
    ) t), '[]'::JSON),

    'assets', COALESCE((SELECT json_agg(row_to_json(t) ORDER BY total DESC) FROM (
      SELECT 
        CASE 
          WHEN ca.code LIKE '11%' THEN 'Cash & Bank'
          WHEN ca.code LIKE '12%' THEN 'Receivables'
          WHEN ca.code LIKE '13%' THEN 'Advances & Prepayments'
          WHEN ca.code LIKE '14%' THEN 'Tax Receivables'
          WHEN ca.code LIKE '151%' THEN 'Fixed Assets'
          WHEN ca.code LIKE '152%' THEN 'Intangible Assets'
          WHEN ca.code LIKE '153%' THEN 'Accum. Depreciation'
          ELSE ca.name
        END as category,
        SUM(CASE WHEN ca.code LIKE '153%' THEN jl.credit_amount - jl.debit_amount ELSE jl.debit_amount - jl.credit_amount END) as total
      FROM finance.journal_lines jl
      JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id
      JOIN finance.journal_entries je ON je.id = jl.journal_entry_id
      WHERE je.status = 'POSTED' AND ca.account_type = 'ASSET'
      GROUP BY 
        CASE 
          WHEN ca.code LIKE '11%' THEN 'Cash & Bank'
          WHEN ca.code LIKE '12%' THEN 'Receivables'
          WHEN ca.code LIKE '13%' THEN 'Advances & Prepayments'
          WHEN ca.code LIKE '14%' THEN 'Tax Receivables'
          WHEN ca.code LIKE '151%' THEN 'Fixed Assets'
          WHEN ca.code LIKE '152%' THEN 'Intangible Assets'
          WHEN ca.code LIKE '153%' THEN 'Accum. Depreciation'
          ELSE ca.name
        END
    ) t), '[]'::JSON),

    'liabilities', COALESCE((SELECT json_agg(row_to_json(t) ORDER BY total DESC) FROM (
      SELECT 
        CASE
          WHEN ca.code LIKE '21%' THEN 'Accounts Payable'
          WHEN ca.code LIKE '22%' THEN 'Tax Payables'
          WHEN ca.code LIKE '23%' THEN 'Payroll Payables'
          WHEN ca.code LIKE '24%' THEN 'Owner Payables'
          WHEN ca.code LIKE '26%' THEN 'Accrued Expenses'
          WHEN ca.code LIKE '251%' THEN 'Long-term Loans'
          ELSE ca.name
        END as category,
        SUM(jl.credit_amount - jl.debit_amount) as total
      FROM finance.journal_lines jl
      JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id
      JOIN finance.journal_entries je ON je.id = jl.journal_entry_id
      WHERE je.status = 'POSTED' AND ca.account_type = 'LIABILITY'
      GROUP BY 
        CASE
          WHEN ca.code LIKE '21%' THEN 'Accounts Payable'
          WHEN ca.code LIKE '22%' THEN 'Tax Payables'
          WHEN ca.code LIKE '23%' THEN 'Payroll Payables'
          WHEN ca.code LIKE '24%' THEN 'Owner Payables'
          WHEN ca.code LIKE '26%' THEN 'Accrued Expenses'
          WHEN ca.code LIKE '251%' THEN 'Long-term Loans'
          ELSE ca.name
        END
    ) t), '[]'::JSON)
  );
END;
 $$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- 4. Both Aging Buckets (FIXED: self-contained, no dependency on missing view)
CREATE OR REPLACE FUNCTION reporting.ceo_chart_aging()
RETURNS JSON AS $$ BEGIN
  RETURN json_build_object(
    'receivable', COALESCE(json_build_object(
      'current', COALESCE((SELECT SUM(COALESCE(outstanding_amount, 0)) FROM public.invoices WHERE status IN ('ISSUED','PARTIALLY_PAID','OVERDUE') AND due_date >= CURRENT_DATE), 0),
      'overdue_1_30', COALESCE((SELECT SUM(COALESCE(outstanding_amount, 0)) FROM public.invoices WHERE status IN ('ISSUED','PARTIALLY_PAID','OVERDUE') AND due_date < CURRENT_DATE AND due_date >= CURRENT_DATE - INTERVAL '30 days'), 0),
      'overdue_31_60', COALESCE((SELECT SUM(COALESCE(outstanding_amount, 0)) FROM public.invoices WHERE status IN ('ISSUED','PARTIALLY_PAID','OVERDUE') AND due_date < CURRENT_DATE - INTERVAL '30 days' AND due_date >= CURRENT_DATE - INTERVAL '60 days'), 0),
      'overdue_61_90', COALESCE((SELECT SUM(COALESCE(outstanding_amount, 0)) FROM public.invoices WHERE status IN ('ISSUED','PARTIALLY_PAID','OVERDUE') AND due_date < CURRENT_DATE - INTERVAL '60 days' AND due_date >= CURRENT_DATE - INTERVAL '90 days'), 0),
      'overdue_over_90', COALESCE((SELECT SUM(COALESCE(outstanding_amount, 0)) FROM public.invoices WHERE status IN ('ISSUED','PARTIALLY_PAID','OVERDUE') AND due_date < CURRENT_DATE - INTERVAL '90 days'), 0),
      'total', COALESCE((SELECT SUM(COALESCE(outstanding_amount, 0)) FROM public.invoices WHERE status IN ('ISSUED','PARTIALLY_PAID','OVERDUE')), 0)
    ), '{}'::JSON),
    'payable', COALESCE(json_build_object(
      'current', COALESCE((SELECT SUM(COALESCE(outstanding_amount, 0)) FROM finance.vendor_bills WHERE status IN ('POSTED','PARTIALLY_PAID') AND due_date >= CURRENT_DATE), 0),
      'overdue_1_30', COALESCE((SELECT SUM(COALESCE(outstanding_amount, 0)) FROM finance.vendor_bills WHERE status IN ('POSTED','PARTIALLY_PAID') AND due_date < CURRENT_DATE AND due_date >= CURRENT_DATE - INTERVAL '30 days'), 0),
      'overdue_31_60', COALESCE((SELECT SUM(COALESCE(outstanding_amount, 0)) FROM finance.vendor_bills WHERE status IN ('POSTED','PARTIALLY_PAID') AND due_date < CURRENT_DATE - INTERVAL '30 days' AND due_date >= CURRENT_DATE - INTERVAL '60 days'), 0),
      'overdue_61_90', COALESCE((SELECT SUM(COALESCE(outstanding_amount, 0)) FROM finance.vendor_bills WHERE status IN ('POSTED','PARTIALLY_PAID') AND due_date < CURRENT_DATE - INTERVAL '60 days' AND due_date >= CURRENT_DATE - INTERVAL '90 days'), 0),
      'overdue_over_90', COALESCE((SELECT SUM(COALESCE(outstanding_amount, 0)) FROM finance.vendor_bills WHERE status IN ('POSTED','PARTIALLY_PAID') AND due_date < CURRENT_DATE - INTERVAL '90 days'), 0),
      'total', COALESCE((SELECT SUM(COALESCE(outstanding_amount, 0)) FROM finance.vendor_bills WHERE status IN ('POSTED','PARTIALLY_PAID')), 0)
    ), '{}'::JSON)
  );
END;
 $$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- 5. Cash by Account
CREATE OR REPLACE FUNCTION reporting.ceo_chart_cash()
RETURNS JSON AS $$ BEGIN
  RETURN COALESCE(json_agg(row_to_json(t) ORDER BY balance DESC), '[]'::JSON) FROM (
    SELECT id, account_name, institution_type, currency, masked_identifier, opening_balance as balance
    FROM finance.financial_accounts WHERE is_active = true
  ) t;
END;
 $$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- 6. Budget vs Actual
CREATE OR REPLACE FUNCTION reporting.ceo_chart_budget()
RETURNS JSON AS $$ BEGIN
  RETURN COALESCE(json_agg(row_to_json(t)), '[]'::JSON) FROM (
    SELECT 
      COALESCE(b.name, 'Uncategorized') as category,
      COALESCE(b.total_amount, 0) as budget,
      COALESCE(SUM(jl.debit_amount - jl.credit_amount), 0) as actual,
      COALESCE(b.total_amount, 0) - COALESCE(SUM(jl.debit_amount - jl.credit_amount), 0) as variance
    FROM public.budgets b
    LEFT JOIN finance.journal_lines jl ON jl.description ILIKE '%' || b.name || '%'
    LEFT JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id
    LEFT JOIN finance.journal_entries je ON je.id = jl.journal_entry_id AND je.status = 'POSTED'
    WHERE b.status IN ('APPROVED','ACTIVE')
    GROUP BY b.id, b.name, b.total_amount
  ) t;
END;
 $$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- 7. Shareholder + Tax Summary (FIXED: 2 missing closing quotes)
CREATE OR REPLACE FUNCTION reporting.ceo_table_equity_tax()
RETURNS JSON AS $$ DECLARE
  v_profit_before_tax NUMERIC := 0;
BEGIN
  SELECT SUM(CASE WHEN ca.normal_balance = 'CREDIT' THEN jl.credit_amount - jl.debit_amount ELSE jl.debit_amount - jl.credit_amount END)
    INTO v_profit_before_tax
  FROM finance.journal_lines jl
  JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id
  JOIN finance.journal_entries je ON je.id = jl.journal_entry_id
  JOIN finance.accounting_periods ap ON ap.id = je.period_id
  WHERE je.status = 'POSTED' AND ap.status = 'OPEN'
    AND ca.account_type IN ('REVENUE','COST_OF_SALES','OPERATING_EXPENSE','OTHER_INCOME','OTHER_EXPENSE');

  RETURN json_build_object(
    'shareholders', COALESCE((SELECT json_agg(row_to_json(t)) FROM (
      SELECT 
        CASE ca.code
          WHEN '3110' THEN 'Owner Capital'
          WHEN '2420' THEN 'Owner Drawings'
          WHEN '3200' THEN 'Retained Earnings'
          WHEN '3300' THEN 'General Reserve'
          WHEN '3320' THEN 'Capital Reserve'
          ELSE ca.name
        END as label,
        SUM(CASE WHEN ca.code = '2420' THEN jl.debit_amount - jl.credit_amount ELSE jl.credit_amount - jl.debit_amount END) as balance,
        ca.code
      FROM finance.journal_lines jl
      JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id
      JOIN finance.journal_entries je ON je.id = jl.journal_entry_id
      WHERE je.status = 'POSTED' AND ca.code IN ('3110','2420','3200','3300','3320')
      GROUP BY ca.code, ca.name
    ) t), '[]'::JSON),
    'tax', json_build_object(
      'profit_before_tax', v_profit_before_tax,
      'estimated_tax', COALESCE((SELECT SUM(jl.debit_amount - jl.credit_amount) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.id = jl.journal_entry_id WHERE je.status = 'POSTED' AND ca.code = '7111'), 0),
      'withholding_credits', COALESCE((SELECT SUM(jl.debit_amount - jl.credit_amount) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.id = jl.journal_entry_id WHERE je.status = 'POSTED' AND ca.code = '1410'), 0),
      'tax_payable', GREATEST(
        COALESCE((SELECT SUM(jl.debit_amount - jl.credit_amount) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.id = jl.journal_entry_id WHERE je.status = 'POSTED' AND ca.code = '7111'), 0)
        - COALESCE((SELECT SUM(jl.debit_amount - jl.credit_amount) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.id = jl.journal_entry_id WHERE je.status = 'POSTED' AND ca.code = '1410'), 0),
        0
      ),
      'profit_after_tax', GREATEST(v_profit_before_tax - 
        COALESCE((SELECT SUM(jl.debit_amount - jl.credit_amount) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.id = jl.journal_entry_id WHERE je.status = 'POSTED' AND ca.code = '7111'), 0)
        + COALESCE((SELECT SUM(jl.debit_amount - jl.credit_amount) FROM finance.journal_lines jl JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id JOIN finance.journal_entries je ON je.id = jl.journal_entry_id WHERE je.status = 'POSTED' AND ca.code = '1410'), 0),
        0
      )
    )
  );
END;
 $$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- 8. Recent Audit
CREATE OR REPLACE FUNCTION reporting.ceo_table_audit()
RETURNS JSON AS $$ BEGIN
  RETURN COALESCE(json_agg(row_to_json(t)), '[]'::JSON) FROM (
    SELECT 
      al.id, al.action, al.module,
      COALESCE(al.details::text, '') as details,
      al.created_at,
      COALESCE((SELECT full_name FROM public.profiles p WHERE p.user_id = al.user_id), al.user_id::text) as user_name,
      al.table_name
    FROM audit.audit_logs al
    ORDER BY al.created_at DESC
    LIMIT 30
  ) t;
END;
 $$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- 9. Fiscal Year Progress
CREATE OR REPLACE FUNCTION reporting.ceo_table_fiscal()
RETURNS JSON AS $$ BEGIN
  RETURN COALESCE(json_agg(row_to_json(t) ORDER BY ap.start_date), '[]'::JSON) FROM (
    SELECT ap.id, ap.name,
      ap.start_date, ap.end_date, ap.status,
      EXTRACT(MONTH FROM ap.start_date)::int as month_num,
      EXTRACT(MONTH FROM ap.end_date)::int - EXTRACT(MONTH FROM ap.start_date)::int + 1 as total_months
    FROM finance.accounting_periods ap
    WHERE ap.fiscal_year_id = (SELECT id FROM finance.fiscal_years WHERE is_current = true LIMIT 1)
    ORDER BY ap.start_date
  ) t;
END;
 $$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- ==========================================
-- 10. MISSING FUNCTIONS (jo service call karta tha)
-- ==========================================

-- 10a. Pending Approvals List
CREATE OR REPLACE FUNCTION reporting.pending_approvals_list()
RETURNS JSON AS $$ BEGIN
  RETURN COALESCE(
    json_agg(row_to_json(t) ORDER BY t.created_at DESC)
  , '[]'::JSON) FROM (
    -- Invoices
    SELECT id, 'INVOICE' as module_type, invoice_number as reference,
      COALESCE(client_name, 'N/A') as description,
      COALESCE(total_amount, 0) as amount,
      created_by, created_at,
      CASE WHEN due_date < CURRENT_DATE THEN 'HIGH' ELSE 'NORMAL' END as urgency
    FROM public.invoices WHERE status = 'SUBMITTED'
    UNION ALL
    -- Vendor Bills
    SELECT id, 'VENDOR_BILL' as module_type, bill_number as reference,
      COALESCE(vendor_name, description, 'N/A') as description,
      COALESCE(total_amount, 0) as amount,
      created_by, created_at,
      CASE WHEN due_date < CURRENT_DATE THEN 'HIGH' ELSE 'NORMAL' END as urgency
    FROM finance.vendor_bills WHERE status IN ('SUBMITTED','VERIFIED')
    UNION ALL
    -- Expenses
    SELECT id, 'EXPENSE' as module_type, reference_number as reference,
      COALESCE(description, purpose, 'N/A') as description,
      COALESCE(total_amount, 0) as amount,
      created_by, created_at,
      'NORMAL' as urgency
    FROM public.expenses WHERE status = 'SUBMITTED'
  ) t;
END;
 $$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- 10b. Unreconciled Summary
CREATE OR REPLACE FUNCTION reporting.unreconciled_summary()
RETURNS JSON AS $$ BEGIN
  RETURN COALESCE(
    json_agg(row_to_json(t) ORDER BY t.unreconciled_amount DESC)
  , '[]'::JSON) FROM (
    SELECT 
      fa.id as account_id,
      fa.account_name,
      fa.institution_type,
      COUNT(sl.id)::int as unreconciled_count,
      COALESCE(SUM(sl.amount), 0) as unreconciled_amount,
      MAX(sl.transaction_date) as last_statement_date
    FROM finance.statement_lines sl
    JOIN finance.bank_statements bs ON bs.id = sl.bank_statement_id
    JOIN finance.financial_accounts fa ON fa.id = bs.financial_account_id
    WHERE sl.reconciliation_status = 'UNRECONCILED'
    GROUP BY fa.id, fa.account_name, fa.institution_type
  ) t;
END;
 $$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- 10c. Project Profitability
CREATE OR REPLACE FUNCTION reporting.project_profitability()
RETURNS JSON AS $$ BEGIN
  RETURN COALESCE(
    json_agg(row_to_json(t) ORDER BY t.gross_profit DESC)
  , '[]'::JSON) FROM (
    SELECT 
      p.id,
      p.name as project_name,
      COALESCE((SELECT c.name FROM public.clients c WHERE c.id = p.client_id), 'N/A') as client_name,
      COALESCE(SUM(CASE WHEN ca.account_type = 'REVENUE' THEN jl.credit_amount - jl.debit_amount ELSE 0 END), 0) as revenue,
      COALESCE(SUM(CASE WHEN ca.account_type IN ('COST_OF_SALES','OPERATING_EXPENSE') THEN jl.debit_amount - jl.credit_amount ELSE 0 END), 0) as costs,
      COALESCE(SUM(CASE WHEN ca.account_type = 'REVENUE' THEN jl.credit_amount - jl.debit_amount ELSE 0 END), 0)
        - COALESCE(SUM(CASE WHEN ca.account_type IN ('COST_OF_SALES','OPERATING_EXPENSE') THEN jl.debit_amount - jl.credit_amount ELSE 0 END), 0) as gross_profit,
      CASE 
        WHEN COALESCE(SUM(CASE WHEN ca.account_type = 'REVENUE' THEN jl.credit_amount - jl.debit_amount ELSE 0 END), 0) > 0 
        THEN ROUND(
          ((SUM(CASE WHEN ca.account_type = 'REVENUE' THEN jl.credit_amount - jl.debit_amount ELSE 0 END)
            - SUM(CASE WHEN ca.account_type IN ('COST_OF_SALES','OPERATING_EXPENSE') THEN jl.debit_amount - jl.credit_amount ELSE 0 END))
          / NULLIF(SUM(CASE WHEN ca.account_type = 'REVENUE' THEN jl.credit_amount - jl.debit_amount ELSE 0 END), 0)) * 100, 1)
        ELSE 0 
      END as margin,
      p.status
    FROM public.projects p
    LEFT JOIN finance.journal_lines jl ON jl.project_id = p.id
    LEFT JOIN finance.journal_entries je ON je.id = jl.journal_entry_id AND je.status = 'POSTED'
    LEFT JOIN finance.chart_of_accounts ca ON ca.id = jl.account_id
    WHERE ca.account_type IN ('REVENUE','COST_OF_SALES','OPERATING_EXPENSE')
    GROUP BY p.id, p.name, p.client_id, p.status
  ) t;
END;
 $$ LANGUAGE plpgsql STABLE SECURITY DEFINER;
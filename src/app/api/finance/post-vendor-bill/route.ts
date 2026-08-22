import { NextRequest, NextResponse } from 'next/server';
import { getAuthSupabase } from '@/lib/api-auth';
import { requirePermission } from '@/lib/api-auth';
import { enforceMFA } from '@/lib/mfa-middleware';
import { postVendorBillSchema, validateBody, validateExchangeRate } from '@/lib/validations';
import { checkBudgetForTransaction, createBudgetAlertNotifications } from '@/services/budget-check.service';

function getData<T = any>(res: any): T | null {
  return res?.data ?? null;
}

// --- POST: Post approved vendor bill to General Ledger ---
// Spec: When vendor bill is APPROVED -> DR Expense/Cost, CR Accounts Payable
// Spec 5.4: Budget check BEFORE posting — warn or block based on configurable policy
// BUG-001 FIX: Use RPC with CORRECT signature (p_description, p_transaction_date, p_period_id, p_lines, ...)
// BUG-005 FIX: WHT journal lines constructed explicitly, no pop() on wrong line
export async function POST(req: NextRequest) {
  const auth = await requirePermission('APPROVE_VENDOR_BILL');
  if (auth instanceof NextResponse) return auth;
  // H3 FIX: Enforce MFA for financial posting
  const mfaCheck = await enforceMFA(auth);
  if (mfaCheck) return mfaCheck;
  const { supabase } = await getAuthSupabase(req);

  const orgId = auth.orgId;
  if (!orgId) {
    return NextResponse.json({ error: 'Organization ID not found' }, { status: 400 });
  }

  try {
    const rawBody = await req.json();
    const validation = validateBody(postVendorBillSchema, rawBody);
    if (!validation.success) return NextResponse.json({ error: validation.error }, { status: 400 });
    const { vendorBillId, force_budget_override } = validation.data;

    // 1. Fetch vendor bill with line items (org isolated)
    const bill = getData(await supabase
      .from('vendor_bills')
      .select('*, vendor_bill_lines(*)')
      .eq('id', vendorBillId)
      .eq('organization_id', orgId)
      .single());

    if (!bill) {
      return NextResponse.json({ error: 'Vendor bill not found' }, { status: 404 });
    }

    if (bill.status !== 'APPROVED') {
      return NextResponse.json({
        error: `Only APPROVED vendor bills can be posted. Current: ${bill.status}`,
      }, { status: 400 });
    }

    // BUG-008 FIX: validate exchange rate for non-PKR currencies
    const rateError = validateExchangeRate(bill.currency, bill.exchange_rate);
    if (rateError) {
      return NextResponse.json({ error: rateError }, { status: 400 });
    }

    // 2. Idempotency check
    const existingJournal = getData(await supabase
      .from('finance.journal_entries')
      .select('id, reference')
      .eq('source_type', 'VENDOR_BILL')
      .eq('source_id', vendorBillId)
      .maybeSingle());

    if (existingJournal) {
      return NextResponse.json({
        error: 'Already posted to GL',
        journalId: existingJournal.id,
        reference: existingJournal.reference,
      }, { status: 400 });
    }

    // --- BUDGET CHECK ---
    const totalBillAmount = Number(bill.total_amount) || 0;
    const budgetCheck = await checkBudgetForTransaction({
      project_id: bill.project_id || undefined,
      department: bill.department || undefined,
      category: bill.category || undefined,
      amount: totalBillAmount,
      currency: bill.currency || 'PKR',
      organization_id: orgId,
      // BUG-007 FIX: pass server-side authenticated supabase client.
      supabaseClient: supabase,
    });

    if (budgetCheck.notifications && budgetCheck.notifications.length > 0) {
      await createBudgetAlertNotifications(budgetCheck.notifications, orgId, auth.userId, vendorBillId, supabase);
    }

    if (budgetCheck.blocked) {
      // BUG-026 FIX: Removed 'Admin' from override roles — per spec Appendix A,
      // Technical Admin has NO finance data access.
      if (force_budget_override && ['CEO', 'FINANCE_HEAD'].includes(auth.role)) {
        try {
          await supabase.schema('audit').rpc('log_action', {
            p_user_id: auth.userId, p_action: 'BUDGET_OVERRIDE', p_entity_type: 'vendor_bill',
            p_entity_id: vendorBillId,
            p_description: `Budget override on vendor bill posting by ${auth.role}.`,
            p_previous_status: 'APPROVED', p_new_status: 'APPROVED', p_source_module: 'budget',
            p_severity: 'high',
            p_new_values: { override_by: auth.userId, override_role: auth.role, bill_amount: totalBillAmount },
          });
        } catch (overrideAuditErr: any) { console.error('Budget override audit log failed:', overrideAuditErr); }
      } else {
        return NextResponse.json({
          error: 'Transaction blocked: exceeds budget limit', allowed: false, blocked: true,
          warning: budgetCheck.warning, enforcement_mode: budgetCheck.enforcement_mode,
          budget_checks: budgetCheck.checks, message: budgetCheck.message,
          hint: 'CEO or FINANCE_HEAD can override by passing force_budget_override: true',
        }, { status: 422 });
      }
    }

    // 3. Get open period
    const period = getData(await supabase
      .from('finance.accounting_periods')
      .select('id')
      .eq('status', 'OPEN')
      .eq('organization_id', orgId)
      .order('start_date', { ascending: false })
      .limit(1)
      .single());
    if (!period) {
      return NextResponse.json({ error: 'No OPEN accounting period found' }, { status: 400 });
    }

    // 4. Find accounts
    // BUG-014 FIX: `.like('code', '21%').limit(1).single()` with no ORDER BY
    // could non-deterministically resolve to the 2100 PARENT/SUMMARY account
    // (spec 5.2: "Prevent posting to summary accounts") instead of the real
    // 2110 "Vendor Payables" control account, and the `.ilike('name', '%tax%')`
    // fallback could match either 2210 "Income Tax Payable" or 2220 "Sales Tax
    // Payable" depending on row order. Resolve both by their exact, seeded
    // control-account codes instead of fuzzy name/prefix matching. If the
    // organization has renamed/removed these specific accounts, this
    // correctly fails closed with a clear setup error rather than silently
    // posting to the wrong account.
    const payableAccount = getData(await supabase
      .from('finance.chart_of_accounts').select('id, code, name')
      .eq('account_type', 'LIABILITY').eq('is_active', true).eq('code', '2110').eq('organization_id', auth.orgId).maybeSingle());

    const inputTaxAccount = getData(await supabase
      .from('finance.chart_of_accounts').select('id, code, name')
      .eq('account_type', 'ASSET').eq('is_active', true).eq('organization_id', auth.orgId).ilike('name', '%input tax%').order('code').limit(1).maybeSingle());

    const withholdingReceivableAccount = getData(await supabase
      .from('finance.chart_of_accounts').select('id, code, name')
      .eq('account_type', 'ASSET').eq('is_active', true).eq('code', '1410').eq('organization_id', auth.orgId).maybeSingle());

    const creditAccountId = payableAccount?.id;

    if (!creditAccountId) {
      return NextResponse.json({
        error: 'Required Accounts Payable control account (code 2110, "Vendor Payables") not found or inactive. Set it up in Chart of Accounts.',
      }, { status: 400 });
    }

    // Build correct AP accounting:
    // Dr expense subtotal + Dr input tax + Dr withholding-tax receivable
    // Cr vendor payable for the net amount due to the vendor.
    const totalAmount = Number(bill.total_amount) || 0;
    const totalTax = Number(bill.tax_amount) || 0;
    const withholdingAmount = Number(bill.withholding_amount) || 0;
    const subtotal = Number(bill.subtotal) || Math.max(totalAmount - totalTax, 0);

    if (totalTax > 0 && !inputTaxAccount) {
      return NextResponse.json({ error: 'Vendor bill has tax_amount but no active Input Tax asset account is configured.' }, { status: 400 });
    }
    if (withholdingAmount > 0 && !withholdingReceivableAccount) {
      return NextResponse.json({ error: 'Vendor bill has withholding_amount but withholding-tax receivable account 1410 is not configured.' }, { status: 400 });
    }

    const rpcLines: any[] = [];
    let expenseTotal = 0;
    if (bill.vendor_bill_lines && bill.vendor_bill_lines.length > 0) {
      for (const line of bill.vendor_bill_lines) {
        const lineAmount = Number(line.amount) || 0;
        if (lineAmount <= 0) continue;
        let expenseAccountId: string | null = line.account_id || null;
        if (!expenseAccountId && line.category) {
          const escapedCategory = line.category.replace(/[%_]/g, '\\$&');
          const matched = getData(await supabase
            .from('finance.chart_of_accounts').select('id')
            .eq('account_type', 'OPERATING_EXPENSE').eq('is_active', true)
            .eq('organization_id', auth.orgId)
            .ilike('name', `%${escapedCategory}%`).order('code').limit(1).maybeSingle());
          expenseAccountId = matched?.id || null;
        }
        if (!expenseAccountId) {
          const defaultExp = getData(await supabase
            .from('finance.chart_of_accounts').select('id')
            .eq('account_type', 'OPERATING_EXPENSE').eq('is_active', true).eq('organization_id', auth.orgId).order('code').limit(1).maybeSingle());
          expenseAccountId = defaultExp?.id || null;
        }
        if (!expenseAccountId) return NextResponse.json({ error: 'No operating expense account is configured for a vendor bill line.' }, { status: 400 });
        expenseTotal += lineAmount;
        rpcLines.push({ account_id: expenseAccountId, debit_amount: lineAmount, credit_amount: 0, description: `Vendor Bill: ${bill.bill_number || 'N/A'} - ${line.description || line.category || 'Expense'}` });
      }
    }
    if (expenseTotal > 0 && Math.abs(expenseTotal - subtotal) > 0.01) {
      return NextResponse.json({ error: `Vendor bill line total (${expenseTotal}) does not match subtotal (${subtotal}).` }, { status: 400 });
    }
    if (expenseTotal === 0) {
      const expenseAccount = getData(await supabase
        .from('finance.chart_of_accounts').select('id, code, name')
        .eq('account_type', 'OPERATING_EXPENSE').eq('is_active', true).eq('organization_id', auth.orgId).order('code').limit(1).maybeSingle());
      if (!expenseAccount) return NextResponse.json({ error: 'No OPERATING_EXPENSE account found in Chart of Accounts.' }, { status: 400 });
      expenseTotal = subtotal;
      rpcLines.push({ account_id: expenseAccount.id, debit_amount: subtotal, credit_amount: 0, description: `Vendor Bill: ${bill.bill_number || 'N/A'} - ${bill.description || 'Vendor Expense'}` });
    }
    if (totalTax > 0) rpcLines.push({ account_id: inputTaxAccount.id, debit_amount: totalTax, credit_amount: 0, description: `Input tax: ${bill.bill_number || 'N/A'}` });
    if (withholdingAmount > 0) rpcLines.push({ account_id: withholdingReceivableAccount.id, debit_amount: withholdingAmount, credit_amount: 0, description: `Withholding tax receivable: ${bill.bill_number || 'N/A'}` });
    const netPayable = totalAmount - withholdingAmount;
    if (netPayable < 0) return NextResponse.json({ error: 'Withholding amount cannot exceed vendor bill total.' }, { status: 400 });
    rpcLines.push({ account_id: creditAccountId, debit_amount: 0, credit_amount: netPayable, description: `Vendor payable: ${bill.bill_number || 'N/A'}` });

    const { data: journalId, error: postErr } = await supabase.schema('finance').rpc('post_journal_entry', {
      p_description: `Vendor Bill: ${bill.bill_number || 'N/A'} - ${bill.vendor_id || 'Vendor'} - ${bill.description || ''}`,
      p_transaction_date: bill.bill_date || new Date().toISOString().split('T')[0],
      p_period_id: period.id,
      p_lines: rpcLines,
      p_currency: bill.currency || 'PKR',
      p_exchange_rate: bill.exchange_rate || 1,
      p_source_type: 'VENDOR_BILL',
      p_source_id: vendorBillId,
      p_project_id: bill.project_id || null,
    });

    if (postErr || !journalId) {
      return NextResponse.json({ error: 'GL posting failed: ' + (postErr?.message || 'Unknown error') }, { status: 500 });
    }

    const journal = getData(await supabase
      .from('finance.journal_entries')
      .select('id, reference, total_debit, total_credit')
      .eq('id', journalId).single());
    // C6 FIX: Null guard
    if (!journal) {
      return NextResponse.json({ error: 'Journal created but fetch failed. Check journal ID: ' + journalId }, { status: 500 });
    }
    const reference = journal.reference || `JE-VB-${journalId}`;
    const totalDebit = journal.total_debit || 0;
    const totalCredit = journal.total_credit || 0;

    // 11. Audit log
    // BUG-023 FIX: surface a failed audit write via audit_log_warning
    // instead of only console-logging it (Spec 8.1).
    let auditLogFailed = false;
    try {
      await supabase.schema('audit').rpc('log_action', {
        p_user_id: auth.userId, p_action: 'VENDOR_BILL_POSTED', p_entity_type: 'vendor_bill',
        p_entity_id: vendorBillId,
        p_description: `Posted vendor bill ${bill.bill_number || vendorBillId} to GL: ${reference}`,
        p_previous_status: 'APPROVED', p_new_status: 'POSTED', p_source_module: 'vendor_bill',
        p_severity: 'high',
        p_new_values: { reference, total_amount: totalAmount, journal_id: journalId, vendor_id: bill.vendor_id, currency: bill.currency || 'PKR', budget_warning: budgetCheck.warning, budget_overridden: !!force_budget_override },
        p_related_journal_id: journalId,
      });
    } catch (auditErr: any) {
      console.error('Audit log failed for vendor bill post:', auditErr);
      auditLogFailed = true;
    }

    return NextResponse.json({
      success: true, journalId, reference, totalDebit, totalCredit,
      lineCount: rpcLines.length,
      message: `Vendor bill posted to GL: ${reference}`,
      budget_check: budgetCheck.blocked ? { overridden: true } : { warning: budgetCheck.warning, checks: budgetCheck.checks.length },
      audit_log_warning: auditLogFailed ? 'Posting succeeded but the audit log entry failed to write. Please notify an administrator.' : undefined,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
import { NextRequest, NextResponse } from 'next/server';
import { getAuthSupabase } from '@/lib/api-auth';
import { requirePermission } from '@/lib/api-auth';
import { enforceMFA } from '@/lib/mfa-middleware';
import { postVendorBillSchema, validateBody } from '@/lib/validations';
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
  const auth = await requirePermission('APPROVE_EXPENSE');
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
    });

    if (budgetCheck.notifications && budgetCheck.notifications.length > 0) {
      await createBudgetAlertNotifications(budgetCheck.notifications, orgId, auth.userId, vendorBillId);
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
      .eq('account_type', 'LIABILITY').eq('is_active', true).eq('code', '2110').maybeSingle());

    const taxAccount = getData(await supabase
      .from('finance.chart_of_accounts').select('id, code, name')
      .eq('account_type', 'LIABILITY').eq('is_active', true).eq('code', '2220').maybeSingle());

    const creditAccountId = payableAccount?.id;

    if (!creditAccountId) {
      return NextResponse.json({
        error: 'Required Accounts Payable control account (code 2110, "Vendor Payables") not found or inactive. Set it up in Chart of Accounts.',
      }, { status: 400 });
    }

    // 5-9. Build journal lines and post via GL engine (BUG-001 FIX + BUG-005 FIX)
    const totalAmount = Number(bill.total_amount) || 0;
    const totalTax = Number(bill.tax_amount) || Number(bill.withholding_amount) || 0;
    const subtotal = totalAmount - totalTax;

    const rpcLines: any[] = [];

    if (bill.vendor_bill_lines && bill.vendor_bill_lines.length > 0) {
      for (const line of bill.vendor_bill_lines) {
        const lineAmount = Number(line.amount) || 0;
        if (lineAmount <= 0) continue;

        let expenseAccountId: string | null = null;
        if (line.account_id) {
          expenseAccountId = line.account_id;
        } else if (line.category) {
          const escapedCategory = line.category.replace(/[%_]/g, '\\$&');
          // NOTE: category text is free-form / dynamic, so it cannot be
          // resolved to a fixed COA code the way the AP/tax control
          // accounts above were. .order('code') at least makes the match
          // deterministic (same category text always resolves to the same
          // account) instead of depending on unordered row-scan order.
          const matched = getData(await supabase
            .from('finance.chart_of_accounts').select('id')
            .eq('account_type', 'OPERATING_EXPENSE').eq('is_active', true)
            .ilike('name', `%${escapedCategory}%`).order('code', { ascending: true }).limit(1).maybeSingle());
          expenseAccountId = matched?.id || null;
        }

        if (!expenseAccountId) {
          const defaultExp = getData(await supabase
            .from('finance.chart_of_accounts').select('id')
            .eq('account_type', 'OPERATING_EXPENSE').eq('is_active', true).limit(1).single());
          expenseAccountId = defaultExp?.id || null;
        }

        if (expenseAccountId) {
          rpcLines.push({
            account_id: expenseAccountId,
            debit_amount: lineAmount,
            credit_amount: 0,
            description: `Vendor Bill: ${bill.bill_number || 'N/A'} - ${line.description || line.category || 'Expense'}`,
          });
        }
      }
    } else {
      const expenseAccount = getData(await supabase
        .from('finance.chart_of_accounts').select('id, code, name')
        .eq('account_type', 'OPERATING_EXPENSE').eq('is_active', true).limit(1).single());

      if (!expenseAccount) {
        return NextResponse.json({ error: 'No OPERATING_EXPENSE account found in Chart of Accounts.' }, { status: 400 });
      }

      rpcLines.push({
        account_id: expenseAccount.id,
        debit_amount: subtotal,
        credit_amount: 0,
        description: `Vendor Bill: ${bill.bill_number || 'N/A'} - ${bill.description || 'Vendor Expense'}`,
      });
    }

    // BUG-005 FIX: Build CR lines CORRECTLY — no pop(), construct explicitly
    if (totalTax > 0 && taxAccount) {
      rpcLines.push({
        account_id: creditAccountId, debit_amount: 0, credit_amount: subtotal,
        description: `Payable (net): Vendor Bill ${bill.bill_number || 'N/A'}`,
      });
      rpcLines.push({
        account_id: taxAccount.id, debit_amount: 0, credit_amount: totalTax,
        description: `Withholding Tax: Vendor Bill ${bill.bill_number || 'N/A'}`,
      });
    } else {
      rpcLines.push({
        account_id: creditAccountId, debit_amount: 0, credit_amount: totalAmount,
        description: `Payable: Vendor Bill ${bill.bill_number || 'N/A'} - ${bill.vendor_id || 'Vendor'}`,
      });
    }

    const { data: journalId, error: postErr } = await supabase.schema('finance').rpc('post_journal_entry', {
      p_description: `Vendor Bill: ${bill.bill_number || 'N/A'} - ${bill.vendor_id || 'Vendor'} - ${bill.description || ''}`,
      p_transaction_date: bill.bill_date || new Date().toISOString().split('T')[0],
      p_period_id: period.id,
      p_lines: JSON.stringify(rpcLines),
      p_currency: bill.currency || 'PKR',
      p_exchange_rate: bill.exchange_rate || 1,
      p_source_type: 'VENDOR_BILL',
      p_source_id: vendorBillId,
      p_project_id: bill.project_id || null,
      p_department_id: bill.department || null,
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

    // 10. Update vendor bill status
    const { error: statusErr } = await supabase.from('vendor_bills').update({
      status: 'POSTED', posted_at: new Date().toISOString(),
      journal_entry_id: journalId, posted_by: auth.userId,
    }).eq('id', vendorBillId);

    if (statusErr) { console.error('Vendor bill status update failed:', statusErr.message); }

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
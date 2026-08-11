import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { requirePermission } from '@/lib/api-auth';
import { checkBudgetForTransaction, createBudgetAlertNotifications } from '@/services/budget-check.service';

function getData<T = any>(res: any): T | null {
  return res?.data ?? null;
}

// ─── POST: Post approved vendor bill to General Ledger ───
// Spec: When vendor bill is APPROVED → DR Expense/Cost, CR Accounts Payable
// Spec 5.4: Budget check BEFORE posting — warn or block based on configurable policy
export async function POST(req: NextRequest) {
  const auth = await requirePermission('APPROVE_EXPENSE');
  if (auth instanceof NextResponse) return auth;

  const orgId = auth.orgId;
  if (!orgId) {
    return NextResponse.json({ error: 'Organization ID not found' }, { status: 400 });
  }

  try {
    const { vendorBillId, force_budget_override } = await req.json();
    if (!vendorBillId) {
      return NextResponse.json({ error: 'vendorBillId is required' }, { status: 400 });
    }

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

    // ─── BUDGET CHECK (Spec 5.4: Warn or block transactions exceeding budget) ───
    const totalBillAmount = Number(bill.total_amount) || 0;
    const budgetCheck = await checkBudgetForTransaction({
      project_id: bill.project_id || undefined,
      department: bill.department || undefined,
      category: bill.category || undefined,
      amount: totalBillAmount,
      currency: bill.currency || 'PKR',
      organization_id: orgId,
    });

    // Create budget threshold alert notifications (Spec 13.4)
    if (budgetCheck.notifications && budgetCheck.notifications.length > 0) {
      await createBudgetAlertNotifications(
        budgetCheck.notifications,
        orgId,
        auth.userId,
        vendorBillId
      );
    }

    // Enforce budget block (unless overridden by authorized role)
    if (budgetCheck.blocked) {
      if (force_budget_override && ['CEO', 'FINANCE_HEAD', 'Admin'].includes(auth.role)) {
        try {
          await supabase.rpc('audit.log_action', {
            p_user_id: auth.userId,
            p_action: 'BUDGET_OVERRIDE',
            p_entity_type: 'vendor_bill',
            p_entity_id: vendorBillId,
            p_description: `Budget override on vendor bill posting by ${auth.role}. Budget was exceeded but posting allowed.`,
            p_previous_status: 'APPROVED',
            p_new_status: 'APPROVED',
            p_source_module: 'budget',
            p_severity: 'high',
            p_new_values: {
              budget_checks: budgetCheck.checks.map(c => ({
                budget_id: c.budget_id,
                warning_level: c.warning_level,
                utilization_after: c.utilization_after,
              })),
              override_by: auth.userId,
              override_role: auth.role,
              bill_amount: totalBillAmount,
            },
          });
        } catch (overrideAuditErr: any) {
          console.error('Budget override audit log failed:', overrideAuditErr);
        }
      } else {
        return NextResponse.json({
          error: 'Transaction blocked: exceeds budget limit',
          allowed: false,
          blocked: true,
          warning: budgetCheck.warning,
          enforcement_mode: budgetCheck.enforcement_mode,
          budget_checks: budgetCheck.checks,
          message: budgetCheck.message,
          hint: 'CEO or FINANCE_HEAD can override by passing force_budget_override: true',
        }, { status: 422 });
      }
    }

    // 3. Get open period
    const period = getData(await supabase
      .from('finance.accounting_periods')
      .select('id')
      .eq('status', 'OPEN')
      .order('start_date', { ascending: false })
      .limit(1)
      .single());

    if (!period) {
      return NextResponse.json({ error: 'No OPEN accounting period found' }, { status: 400 });
    }

    // 4. Find accounts
    const payableAccount = getData(await supabase
      .from('finance.chart_of_accounts')
      .select('id, code, name')
      .eq('account_type', 'LIABILITY')
      .eq('is_active', true)
      .like('code', '21%')
      .limit(1)
      .single());

    let fallbackLiability = null;
    if (!payableAccount) {
      fallbackLiability = getData(await supabase
        .from('finance.chart_of_accounts')
        .select('id, code, name')
        .eq('account_type', 'LIABILITY')
        .eq('is_active', true)
        .ilike('name', '%payable%')
        .limit(1)
        .single());
    }

    const taxAccount = getData(await supabase
      .from('finance.chart_of_accounts')
      .select('id, code, name')
      .eq('account_type', 'LIABILITY')
      .eq('is_active', true)
      .ilike('name', '%tax%')
      .limit(1)
      .single());

    const creditAccountId = payableAccount?.id || fallbackLiability?.id;

    if (!creditAccountId) {
      return NextResponse.json({
        error: 'Required accounts not found. Set up LIABILITY (Accounts Payable) accounts in Chart of Accounts.',
      }, { status: 400 });
    }

    // 5. Generate reference number
    const { data: numData } = await supabase.rpc('get_next_number', { p_type: 'JE-VB' });
    const reference = numData || `JE-VB-${Date.now()}`;

    // 6. Build journal lines
    const totalAmount = Number(bill.total_amount) || 0;
    const totalTax = Number(bill.tax_amount) || Number(bill.withholding_amount) || 0;
    const subtotal = totalAmount - totalTax;

    const journalLines: any[] = [];
    let lineNum = 1;

    // If bill has line items, create lines per expense account
    if (bill.vendor_bill_lines && bill.vendor_bill_lines.length > 0) {
      for (const line of bill.vendor_bill_lines) {
        const lineAmount = Number(line.amount) || 0;
        if (lineAmount <= 0) continue;

        // Find expense account for this line
        let expenseAccountId: string | null = null;
        if (line.account_id) {
          expenseAccountId = line.account_id;
        } else if (line.category) {
          const escapedCategory = line.category.replace(/[%_]/g, '\\$&');
          const matched = getData(await supabase
            .from('finance.chart_of_accounts')
            .select('id')
            .eq('account_type', 'OPERATING_EXPENSE')
            .eq('is_active', true)
            .ilike('name', `%${escapedCategory}%`)
            .limit(1)
            .maybeSingle());
          expenseAccountId = matched?.id || null;
        }

        if (!expenseAccountId) {
          // Default to first operating expense
          const defaultExp = getData(await supabase
            .from('finance.chart_of_accounts')
            .select('id')
            .eq('account_type', 'OPERATING_EXPENSE')
            .eq('is_active', true)
            .limit(1)
            .single());
          expenseAccountId = defaultExp?.id || null;
        }

        if (expenseAccountId) {
          journalLines.push({
            account_id: expenseAccountId,
            debit_amount: lineAmount,
            credit_amount: 0,
            description: `Vendor Bill: ${bill.bill_number || 'N/A'} - ${line.description || line.category || 'Expense'}`,
            line_number: lineNum++,
          });
        }
      }
    } else {
      // No line items - single expense line
      const expenseAccount = getData(await supabase
        .from('finance.chart_of_accounts')
        .select('id, code, name')
        .eq('account_type', 'OPERATING_EXPENSE')
        .eq('is_active', true)
        .limit(1)
        .single());

      if (!expenseAccount) {
        return NextResponse.json({
          error: 'No OPERATING_EXPENSE account found in Chart of Accounts.',
        }, { status: 400 });
      }

      journalLines.push({
        account_id: expenseAccount.id,
        debit_amount: subtotal,
        credit_amount: 0,
        description: `Vendor Bill: ${bill.bill_number || 'N/A'} - ${bill.description || 'Vendor Expense'}`,
        line_number: lineNum++,
      });
    }

    // CR: Accounts Payable (full amount)
    journalLines.push({
      account_id: creditAccountId,
      debit_amount: 0,
      credit_amount: totalAmount,
      description: `Payable: Vendor Bill ${bill.bill_number || 'N/A'} - ${bill.vendor_id || 'Vendor'}`,
      line_number: lineNum++,
    });

    // If withholding tax, DR total includes it but CR payable is net
    if (totalTax > 0 && taxAccount) {
      // Adjust: CR Payable is net, CR Tax is withholding
      // Remove the full CR line and replace with net + tax
      journalLines.pop(); // Remove last line

      journalLines.push({
        account_id: creditAccountId,
        debit_amount: 0,
        credit_amount: subtotal,
        description: `Payable (net): Vendor Bill ${bill.bill_number || 'N/A'}`,
        line_number: lineNum++,
      });

      journalLines.push({
        account_id: taxAccount.id,
        debit_amount: 0,
        credit_amount: totalTax,
        description: `Withholding Tax: Vendor Bill ${bill.bill_number || 'N/A'}`,
        line_number: lineNum++,
      });
    }

    // Validate balanced entry
    const totalDebit = journalLines.reduce((sum, l) => sum + Number(l.debit_amount), 0);
    const totalCredit = journalLines.reduce((sum, l) => sum + Number(l.credit_amount), 0);
    if (Math.abs(totalDebit - totalCredit) > 0.02) {
      return NextResponse.json({
        error: `Journal entry does not balance. Debit: ${totalDebit.toFixed(2)}, Credit: ${totalCredit.toFixed(2)}`,
      }, { status: 400 });
    }

    // 7. Create journal header
    const journal = getData(await supabase
      .from('finance.journal_entries')
      .insert({
        reference,
        description: `Vendor Bill: ${bill.bill_number || 'N/A'} - ${bill.vendor_id || 'Vendor'} - ${bill.description || ''}`,
        status: 'APPROVED',
        entry_date: bill.bill_date || new Date().toISOString().split('T')[0],
        period_id: period.id,
        project_id: bill.project_id || null,
        source_type: 'VENDOR_BILL',
        source_id: vendorBillId,
        total_debit: totalDebit,
        total_credit: totalCredit,
        currency: bill.currency || 'PKR',
        exchange_rate: bill.exchange_rate || 1,
        created_by: auth.userId,
        approved_by: auth.userId,
        approved_at: new Date().toISOString(),
        organization_id: orgId,
      })
      .select()
      .single());

    // 8. Insert lines
    const linesWithId = journalLines.map(line => ({
      ...line,
      journal_entry_id: journal.id,
    }));

    const linesError = (await supabase.from('finance.journal_lines').insert(linesWithId)).error;

    if (linesError) {
      await supabase.from('finance.journal_entries').delete().eq('id', journal.id);
      return NextResponse.json({ error: 'Failed to create journal lines: ' + linesError.message }, { status: 500 });
    }

    // 9. Post via GL engine
    const { error: postErr } = await supabase.rpc('finance.post_journal_entry', {
      p_journal_id: journal.id,
      p_posted_by: auth.userId,
    });

    if (postErr) {
      await supabase.from('finance.journal_lines').delete().eq('journal_entry_id', journal.id);
      await supabase.from('finance.journal_entries').delete().eq('id', journal.id);
      return NextResponse.json({ error: 'GL posting failed: ' + postErr.message }, { status: 500 });
    }

    // 10. Update vendor bill status
    const { error: statusErr } = await supabase.from('vendor_bills').update({
      status: 'POSTED',
      posted_at: new Date().toISOString(),
      journal_entry_id: journal.id,
      posted_by: auth.userId,
    }).eq('id', vendorBillId);

    if (statusErr) {
      console.error('Vendor bill status update failed:', statusErr.message);
    }

    // 11. Audit log
    try {
      await supabase.rpc('audit.log_action', {
        p_user_id: auth.userId,
        p_action: 'VENDOR_BILL_POSTED',
        p_entity_type: 'vendor_bill',
        p_entity_id: vendorBillId,
        p_description: `Posted vendor bill ${bill.bill_number || vendorBillId} to GL: ${reference}`,
        p_previous_status: 'APPROVED',
        p_new_status: 'POSTED',
        p_source_module: 'vendor_bill',
        p_severity: 'high',
        p_new_values: {
          reference,
          total_amount: totalAmount,
          journal_id: journal.id,
          vendor_id: bill.vendor_id,
          currency: bill.currency || 'PKR',
          budget_warning: budgetCheck.warning,
          budget_overridden: !!force_budget_override,
        },
        p_related_journal_id: journal.id,
      });
    } catch (auditErr: any) {
      console.error('Audit log failed:', auditErr);
    }

    return NextResponse.json({
      success: true,
      journalId: journal.id,
      reference,
      totalDebit,
      totalCredit,
      lineCount: journalLines.length,
      message: `Vendor bill posted to GL: ${reference}`,
      budget_check: budgetCheck.blocked ? { overridden: true } : { warning: budgetCheck.warning, checks: budgetCheck.checks.length },
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

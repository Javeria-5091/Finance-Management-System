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
  // FND-AP-03 FIX: 'APPROVE_VENDOR_BILL' (singular) was never a seeded
  // permission code (catalogue has 'VENDOR_BILL_APPROVE' and the newer
  // 'APPROVE_VENDOR_BILLS', see seed_data.sql:1038/1885) — every non-CEO
  // user 403'd here regardless of role. Posting is also a distinct action
  // from approving (spec 7.2 lists post/approve separately), so this now
  // checks the dedicated, already role-granted 'VENDOR_BILL_POST' permission
  // (seed_data.sql:1039; granted to ACCOUNTANT/FINANCE_HEAD in the
  // role_permissions seed) instead of reusing the approval permission.
  const auth = await requirePermission('VENDOR_BILL_POST');
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
      .schema('finance').from('vendor_bills')
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
      .schema('finance').from('journal_entries')
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
    // AP-04 FIX: budgets are PKR-only but bill.total_amount is in the
    // bill's own currency (bill.currency). Convert to base currency using
    // bill.exchange_rate (validated above by validateExchangeRate) before
    // comparing against the budget ceiling — otherwise a foreign-currency
    // bill's spend is compared against PKR as if 1 unit of that currency
    // == PKR 1.
    const totalBillAmountPKR = (Number(bill.total_amount) || 0) * (Number(bill.exchange_rate) || 1);
    const budgetCheck = await checkBudgetForTransaction({
      project_id: bill.project_id || undefined,
      department: bill.department || undefined,
      category: bill.category || undefined,
      amount: totalBillAmountPKR,
      currency: 'PKR',
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
            p_new_values: { override_by: auth.userId, override_role: auth.role, bill_amount: bill.total_amount, bill_currency: bill.currency || 'PKR', bill_amount_pkr: totalBillAmountPKR },
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
      .schema('finance').from('accounting_periods')
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
      .schema('finance').from('chart_of_accounts').select('id, code, name')
      .eq('account_type', 'LIABILITY').eq('is_active', true).eq('code', '2110').eq('organization_id', auth.orgId).maybeSingle());

    const inputTaxAccount = getData(await supabase
      .schema('finance').from('chart_of_accounts').select('id, code, name')
      .eq('account_type', 'ASSET').eq('is_active', true).eq('organization_id', auth.orgId).ilike('name', '%input tax%').order('code').limit(1).maybeSingle());

    const creditAccountId = payableAccount?.id;

    if (!creditAccountId) {
      return NextResponse.json({
        error: 'Required Accounts Payable control account (code 2110, "Vendor Payables") not found or inactive. Set it up in Chart of Accounts.',
      }, { status: 400 });
    }

    // FC-02 FIX: WHT is a liability owed to the tax authority on the
    // vendor's behalf, not a receivable owed to us — the vendor is simply
    // paid the net amount. Correct accounting is:
    //   Dr Expense (gross, per coded lines) + Dr Input Tax (if any)
    //   Cr Vendor Payable (NET = total - WHT withheld)
    //   Cr WHT Payable  (the WHT amount, remitted to the tax authority later)
    // The previous code additionally debited a "withholding-tax receivable"
    // (account 1410) for the same WHT amount while also crediting AP for the
    // GROSS total — that double-counted the WHT (it inflated both an asset
    // and a liability that don't exist for this transaction) instead of
    // simply netting it out of what's owed to the vendor. There is no DR
    // receivable line for WHT on a vendor bill; it only nets AP down and
    // credits the WHT Payable liability.
    const totalAmount = Number(bill.total_amount) || 0;
    const totalTax = Number(bill.tax_amount) || 0;
    const withholdingAmount = Number(bill.withholding_amount) || 0;
    const subtotal = Number(bill.subtotal) || Math.max(totalAmount - totalTax, 0);

    if (totalTax > 0 && !inputTaxAccount) {
      return NextResponse.json({ error: 'Vendor bill has tax_amount but no active Input Tax asset account is configured.' }, { status: 400 });
    }

    // BUG-007 FIX: finance.vendor_bill_lines has NO `amount` or `category`
    // columns (see schema.sql ~8909-8926) — it has `account_id` (NOT NULL,
    // the actual line coding chosen by the user) and `quantity`/`unit_price`
    // (the net, pre-tax line amount). The old code read `line.amount` and
    // `line.category`, both always undefined, so `Number(line.amount)||0`
    // was always 0 and `if (lineAmount <= 0) continue;` skipped every single
    // line — discarding the split coding entirely. It then silently dumped
    // the *entire* subtotal onto whichever OPERATING_EXPENSE account
    // happened to sort first by code, so books stayed balanced while every
    // vendor bill's expense classification (and therefore project
    // profitability / department reporting) was wrong.
    //
    // Fix: post each line to the account it was actually coded to
    // (line.account_id), using quantity*unit_price as the line's net
    // (pre-tax, pre-withholding) amount — this is the amount that must sum
    // to bill.subtotal, matching how bill.tax_amount and
    // bill.withholding_amount are already posted separately below. If a
    // line has no coded account (should be impossible — account_id is
    // NOT NULL — but the API must not guess), or the bill has no lines at
    // all, posting fails closed with a clear error instead of guessing an
    // account (spec 5.5: split coding must be preserved on posting).
    const rpcLines: any[] = [];
    let expenseTotal = 0;
    const billLines = Array.isArray(bill.vendor_bill_lines) ? bill.vendor_bill_lines : [];

    if (billLines.length === 0) {
      return NextResponse.json({
        error: 'Vendor bill has no coded line items (vendor_bill_lines). Add split-coded lines before posting (spec 5.5).',
      }, { status: 400 });
    }

    for (const line of billLines) {
      const qty = Number(line.quantity) || 1;
      const unitPrice = Number(line.unit_price) || 0;
      const lineAmount = Math.round(qty * unitPrice * 100) / 100;
      if (lineAmount <= 0) continue;

      if (!line.account_id) {
        return NextResponse.json({
          error: `Vendor bill line ${line.line_number ?? line.id} has no coded GL account. Every line must be coded to an account before posting (spec 5.5).`,
        }, { status: 400 });
      }

      expenseTotal += lineAmount;
      rpcLines.push({
        account_id: line.account_id,
        debit_amount: lineAmount,
        credit_amount: 0,
        description: `Vendor Bill: ${bill.bill_number || 'N/A'} - ${line.description || 'Expense'}`,
      });
    }

    if (rpcLines.length === 0) {
      return NextResponse.json({ error: 'Vendor bill has no positive-amount coded lines to post.' }, { status: 400 });
    }
    if (Math.abs(expenseTotal - subtotal) > 0.01) {
      return NextResponse.json({ error: `Vendor bill line total (${expenseTotal}) does not match subtotal (${subtotal}).` }, { status: 400 });
    }
    if (totalTax > 0) rpcLines.push({ account_id: inputTaxAccount.id, debit_amount: totalTax, credit_amount: 0, description: `Input tax: ${bill.bill_number || 'N/A'}` });

    // FND-AP-02 FIX: bill.total_amount is already NET of WHT — the UI
    // computes it as subtotal + tax_amount - withholding_amount (see
    // vendor-bills/page.tsx handleSubmit: `total = subtotal + taxTotal -
    // whtTotal`). The debit side here is expenseTotal (== subtotal) +
    // totalTax, i.e. GROSS = totalAmount + withholdingAmount. Crediting AP
    // for (totalAmount - withholdingAmount) subtracted the WHT a second
    // time, so total credits came out short by exactly withholdingAmount
    // and finance.post_journal_entry's balance check rejected every bill
    // with withholding_amount > 0. AP must be credited for the bill's own
    // (already-net) total_amount; the WHT Payable credit below then makes
    // up the remaining withholdingAmount so credits equal the gross debit
    // total, same as a WHT=0 bill balanced "by coincidence" before.
    const grossAmount = subtotal + totalTax;
    if (withholdingAmount > grossAmount) return NextResponse.json({ error: 'Withholding amount cannot exceed vendor bill subtotal plus tax.' }, { status: 400 });
    rpcLines.push({ account_id: creditAccountId, debit_amount: 0, credit_amount: totalAmount, description: `Vendor payable (net of WHT): ${bill.bill_number || 'N/A'}` });

    // Credit the WHT Payable liability for the amount withheld — this is
    // remitted to the tax authority separately, not owed to the vendor.
    if (withholdingAmount > 0) {
      const withholdingPayableAccount = getData(await supabase
        .schema('finance').from('chart_of_accounts').select('id')
        .eq('code', '2210')
        .eq('organization_id', auth.orgId)
        .eq('is_active', true)
        .maybeSingle());

      if (!withholdingPayableAccount) {
        return NextResponse.json({
          error: 'Vendor bill has withholding_amount but WHT Payable control account 2210 is not configured.',
        }, { status: 400 });
      }

      rpcLines.push({
        account_id: withholdingPayableAccount.id,
        debit_amount: 0,
        credit_amount: withholdingAmount,
        description: `WHT Payable: ${bill.bill_number || 'N/A'}`,
      });
    }

    // FND-FIN-001 FIX (Spec §11.3): previously post_journal_entry created the
    // journal and a SEPARATE .update() below marked the vendor bill POSTED —
    // two independent PostgREST calls with no transactional link. A failure
    // between them left a committed journal with the bill still
    // status=APPROVED, invisible to AP reports and un-reversible. Both steps
    // now happen inside a single SECURITY DEFINER RPC
    // (finance.post_vendor_bill_atomic, see
    // supabase/migrations/P2/P2_005_atomic_gl_posting_and_profit_distribution_lockdown.sql),
    // so a failure partway through rolls back the journal insert too.
    // NOTE: finance.vendor_bills has posted_by/posted_at columns but no
    // journal_entry_id column (confirmed against schema.sql) -- the link to
    // the journal is via journal_entries.source_type='VENDOR_BILL' /
    // source_id=vendorBillId instead. posted_by is set from auth.uid() inside
    // the RPC (the caller's own session), same identity as auth.userId here.
    const { data: postResult, error: postErr } = await supabase.schema('finance').rpc('post_vendor_bill_atomic', {
      p_bill_id: vendorBillId,
      p_period_id: period.id,
      p_transaction_date: bill.bill_date || new Date().toISOString().split('T')[0],
      p_description: `Vendor Bill: ${bill.bill_number || 'N/A'} - ${bill.vendor_id || 'Vendor'} - ${bill.description || ''}`,
      p_lines: rpcLines,
      p_currency: bill.currency || 'PKR',
      p_exchange_rate: bill.exchange_rate || 1,
      p_project_id: bill.project_id || null,
    });

    if (postErr || !postResult?.journal_id) {
      return NextResponse.json({ error: 'GL posting failed: ' + (postErr?.message || 'Unknown error') }, { status: 500 });
    }

    const journal = { id: postResult.journal_id, reference: postResult.reference };
    const journalId = journal.id;
    const reference = journal.reference || `JE-VB-${journalId}`;
    // The GL engine's own balance trigger (trg_check_journal_balance)
    // guarantees debits === credits for what we submitted. That balanced
    // figure is the GROSS amount (subtotal + tax), not bill.total_amount —
    // total_amount is net of WHT, and WHT is split across two credit lines
    // (AP net + WHT Payable) rather than being netted out of the journal.
    const totalDebit = grossAmount;
    const totalCredit = grossAmount;

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
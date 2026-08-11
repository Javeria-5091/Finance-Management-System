import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { requirePermission } from '@/lib/api-auth';
import {
  postDistributionWithWHT,
  recordWithholdingForTaxCompliance,
  type PostDistributionWithWHTInput,
} from '@/services/distribution-wht.service';

function getData<T = any>(res: any): T | null {
  return res?.data ?? null;
}

// ─── POST: Post approved profit distribution to General Ledger with WHT ───
// Spec 5.13: "Calculate distributable profit only after approved expenses,
//            liabilities, fees, taxes/withholding, and period-close adjustments."
// Spec 2.10: "No implementation for withholding tax on profit distributions." ← THIS FIXES IT
//
// Journal Entry:
//   DR Retained Earnings (total gross)
//   CR Dividend Payable (total net after WHT)
//   CR Withholding Tax Payable (total WHT)
//
// Each WHT amount is recorded in tax_credits_and_withholding for tax compliance

export async function POST(req: NextRequest) {
  const auth = await requirePermission('PROFIT_DISTRIBUTION_UPDATE');
  if (auth instanceof NextResponse) return auth;

  const orgId = auth.orgId;
  if (!orgId) {
    return NextResponse.json({ error: 'Organization ID not found' }, { status: 400 });
  }

  try {
    const body = await req.json();
    const { distribution_id, description, distribution_date, withholding_override } = body;

    if (!distribution_id) {
      return NextResponse.json({ error: 'distribution_id is required' }, { status: 400 });
    }

    // 1. Fetch the distribution
    const distribution = getData(
      await supabase
        .from('finance.distributions')
        .select('*, distribution_lines(*)')
        .eq('id', distribution_id)
        .eq('organization_id', orgId)
        .single()
    );

    if (!distribution) {
      return NextResponse.json({ error: 'Distribution not found' }, { status: 404 });
    }

    if (distribution.status !== 'APPROVED') {
      return NextResponse.json({
        error: `Only APPROVED distributions can be posted. Current: ${distribution.status}`,
      }, { status: 400 });
    }

    // 2. Idempotency check — already posted?
    const existingJournal = getData(
      await supabase
        .from('finance.journal_entries')
        .select('id, reference')
        .eq('source_type', 'PROFIT_DISTRIBUTION')
        .eq('source_id', distribution_id)
        .maybeSingle()
    );

    if (existingJournal) {
      return NextResponse.json({
        error: 'Already posted to GL',
        journalId: existingJournal.id,
        reference: existingJournal.reference,
      }, { status: 400 });
    }

    // 3. Get open period
    const period = getData(
      await supabase
        .from('finance.accounting_periods')
        .select('id')
        .eq('status', 'OPEN')
        .order('start_date', { ascending: false })
        .limit(1)
        .single()
    );

    if (!period) {
      return NextResponse.json({ error: 'No OPEN accounting period found' }, { status: 400 });
    }

    // 4. Calculate WHT and prepare journal data
    const input: PostDistributionWithWHTInput = {
      distribution_id,
      organization_id: orgId,
      period_id: period.id,
      declared_by: auth.userId,
      description: description || undefined,
      distribution_date: distribution_date || new Date().toISOString().split('T')[0],
      withholding_override,
    };

    const result = await postDistributionWithWHT(input);

    if ('error' in result && result.status) {
      return NextResponse.json(
        { error: (result as any).error },
        { status: (result as any).status }
      );
    }

    if (!result.journalData || !result.whtCalculation || !result.withholding_config || !result.journalLines) {
      return NextResponse.json({ error: 'Incomplete WHT calculation result' }, { status: 500 });
    }

    const journalData = result.journalData;
    const journalLines = result.journalLines;
    const whtCalculation = result.whtCalculation;
    const withholding_config = result.withholding_config;

    // 5. Create journal header
    const journal = getData(
      await supabase
        .from('finance.journal_entries')
        .insert(journalData)
        .select()
        .single()
    );

    if (!journal) {
      return NextResponse.json({ error: 'Failed to create journal entry' }, { status: 500 });
    }

    // 6. Create journal lines
    const linesWithId = journalLines.map(line => ({
      ...line,
      journal_entry_id: journal.id,
    }));

    const linesError = (await supabase.from('finance.journal_lines').insert(linesWithId)).error;

    if (linesError) {
      await supabase.from('finance.journal_entries').delete().eq('id', journal.id);
      return NextResponse.json({ error: 'Failed to create journal lines: ' + linesError.message }, { status: 500 });
    }

    // 7. Post via GL engine
    const { error: postErr } = await supabase.rpc('finance.post_journal_entry', {
      p_journal_id: journal.id,
      p_posted_by: auth.userId,
    });

    if (postErr) {
      await supabase.from('finance.journal_lines').delete().eq('journal_entry_id', journal.id);
      await supabase.from('finance.journal_entries').delete().eq('id', journal.id);
      return NextResponse.json({ error: 'GL posting failed: ' + postErr.message }, { status: 500 });
    }

    // 8. Update distribution status to POSTED
    const { error: statusErr } = await supabase
      .from('finance.distributions')
      .update({
        status: 'POSTED',
        posted_at: new Date().toISOString(),
        journal_entry_id: journal.id,
        posted_by: auth.userId,
        total_withholding_tax: whtCalculation.total_withholding_tax,
        total_net_payment: whtCalculation.total_net_payment,
      })
      .eq('id', distribution_id);

    if (statusErr) {
      console.error('Distribution status update failed:', statusErr.message);
    }

    // 9. Update distribution lines with WHT amounts
    for (const line of whtCalculation.lines) {
      await supabase
        .from('finance.distribution_lines')
        .update({
          withholding_amount: line.withholding_amount,
          withholding_rate: line.withholding_rate,
          net_amount: line.net_amount,
          withholding_exempt: line.withholding_exempt,
        })
        .eq('distribution_id', distribution_id)
        .eq('owner_id', line.owner_id);
    }

    // 10. Record WHT for tax compliance (Spec 2.10 — tax_credits_and_withholding)
    const whtRecord = await recordWithholdingForTaxCompliance(
      distribution_id,
      whtCalculation,
      orgId,
      auth.userId,
      journal.id
    );

    // 11. Audit log
    try {
      await supabase.rpc('audit.log_action', {
        p_user_id: auth.userId,
        p_action: 'PROFIT_DISTRIBUTION_POSTED',
        p_entity_type: 'profit_distribution',
        p_entity_id: distribution_id,
        p_description: `Posted profit distribution to GL: ${journalData.reference} (Gross: PKR ${whtCalculation.total_gross_amount.toLocaleString()}, WHT: PKR ${whtCalculation.total_withholding_tax.toLocaleString()}, Net: PKR ${whtCalculation.total_net_payment.toLocaleString()})`,
        p_previous_status: 'APPROVED',
        p_new_status: 'POSTED',
        p_source_module: 'profit_distribution',
        p_severity: 'high',
        p_new_values: {
          reference: journalData.reference,
          total_gross: whtCalculation.total_gross_amount,
          total_withholding_tax: whtCalculation.total_withholding_tax,
          total_net_payment: whtCalculation.total_net_payment,
          journal_id: journal.id,
          withholding_rate: withholding_config.rate,
          owner_count: whtCalculation.lines.length,
          wht_exempt_count: whtCalculation.lines.filter(l => l.withholding_exempt).length,
          wht_compliance_recorded: whtRecord.success,
        },
        p_related_journal_id: journal.id,
      });
    } catch (auditErr: any) {
      console.error('Audit log failed:', auditErr);
    }

    return NextResponse.json({
      success: true,
      journalId: journal.id,
      reference: journalData.reference,
      totalDebit: journalData.total_debit,
      totalCredit: journalData.total_credit,
      withholding_tax: {
        enabled: withholding_config.enabled,
        rate: withholding_config.rate,
        total_withholding: whtCalculation.total_withholding_tax,
        total_net: whtCalculation.total_net_payment,
        tax_compliance_recorded: whtRecord.success,
        lines: whtCalculation.lines.map(l => ({
          owner_name: l.owner_name,
          ownership_percentage: l.ownership_percentage,
          gross_amount: l.gross_amount,
          withholding_rate: l.withholding_rate,
          withholding_amount: l.withholding_amount,
          net_amount: l.net_amount,
          withholding_exempt: l.withholding_exempt,
        })),
      },
      message: `Profit distribution posted to GL: ${journalData.reference}`,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// ─── GET: Preview withholding tax calculation for a distribution ─────────────
// Allows CEO/Finance to preview WHT before posting

export async function GET(req: NextRequest) {
  const auth = await requirePermission('PROFIT_DISTRIBUTION_READ');
  if (auth instanceof NextResponse) return auth;

  const orgId = auth.orgId;
  if (!orgId) {
    return NextResponse.json({ error: 'Organization ID not found' }, { status: 400 });
  }

  try {
    const { searchParams } = new URL(req.url);
    const distributionId = searchParams.get('distribution_id');

    if (!distributionId) {
      return NextResponse.json({ error: 'distribution_id query parameter is required' }, { status: 400 });
    }

    const distribution = getData(
      await supabase
        .from('finance.distributions')
        .select('*, distribution_lines(*)')
        .eq('id', distributionId)
        .eq('organization_id', orgId)
        .maybeSingle()
    );

    if (!distribution) {
      return NextResponse.json({ error: 'Distribution not found' }, { status: 404 });
    }

    const { getWithholdingTaxConfig, calculateWithholdingTax } = await import('@/services/distribution-wht.service');
    const whtConfig = await getWithholdingTaxConfig(orgId);

    const linesWithWHT = calculateWithholdingTax(
      distribution.distribution_lines || [],
      whtConfig
    );

    const totalGross = linesWithWHT.reduce((sum, l) => sum + l.gross_amount, 0);
    const totalWHT = linesWithWHT.reduce((sum, l) => sum + l.withholding_amount, 0);
    const totalNet = linesWithWHT.reduce((sum, l) => sum + l.net_amount, 0);

    return NextResponse.json({
      distribution_id: distributionId,
      distribution_status: distribution.status,
      currency: distribution.currency || 'PKR',
      withholding_config: {
        enabled: whtConfig.enabled,
        rate: whtConfig.rate,
        minimum_threshold: whtConfig.minimum_threshold,
        maximum_cap: whtConfig.maximum_cap,
        tax_reference: whtConfig.tax_reference,
      },
      calculation: {
        total_gross_amount: totalGross,
        total_withholding_tax: totalWHT,
        total_net_payment: totalNet,
        lines: linesWithWHT,
      },
      journal_preview: {
        description: `DR Retained Earnings ${totalGross} | CR Dividend Payable ${totalNet} | CR WHT Payable ${totalWHT}`,
        balanced: Math.abs(totalGross - (totalNet + totalWHT)) < 0.02,
      },
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

import { NextRequest, NextResponse } from 'next/server';
import { getAuthSupabase, requirePermission } from '@/lib/api-auth';
import { z } from 'zod';
import {
  postDistributionWithWHT,
  recordWithholdingForTaxCompliance,
} from '@/services/distribution-wht.service';

const createSchema = z.object({
  fiscal_year_id: z.string().uuid(),
}).strict();

const postSchema = z.object({
  distribution_id: z.string().uuid(),
  distribution_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  description: z.string().trim().max(500).optional(),
  withholding_override: z.object({
    rate: z.number().min(0).max(100).optional(),
    exempt_owner_ids: z.array(z.string().uuid()).max(500).optional(),
    exempt_reason: z.string().trim().max(500).optional(),
  }).strict().optional(),
}).strict();

export async function POST(req: NextRequest) {
  const { supabase } = await getAuthSupabase(req);
  const rawBody = await req.json().catch(() => null);

  if (!rawBody || typeof rawBody !== 'object') {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  // The same endpoint intentionally handles creation and posting so the
  // frontend has one stable command surface. The two operations have
  // different permissions and strict payloads.
  if ('fiscal_year_id' in rawBody && !('distribution_id' in rawBody)) {
    const auth = await requirePermission('EQUITY_MANAGE');
    if (auth instanceof NextResponse) return auth;

    const parsed = createSchema.safeParse(rawBody);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message || 'Invalid request' },
        { status: 400 }
      );
    }

    const { data, error } = await supabase.schema('finance').rpc(
      'create_profit_distribution_from_posted_pnl',
      { p_fiscal_year_id: parsed.data.fiscal_year_id }
    );

    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ data }, { status: 201 });
  }

  const auth = await requirePermission('EQUITY_POST');
  if (auth instanceof NextResponse) return auth;

  const parsed = postSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message || 'Invalid request' },
      { status: 400 }
    );
  }

  const { distribution_id, distribution_date, description, withholding_override } = parsed.data;

  // getAuthUser() exposes organization_id as nullable. Posting a finance
  // transaction must never continue without a resolved tenant context.
  if (!auth.orgId) {
    return NextResponse.json(
      { error: 'Organization context is required for profit distribution posting' },
      { status: 400 }
    );
  }

  const organizationId: string = auth.orgId;

  // Resolve the accounting period server-side. Never trust a client supplied
  // period id for GL posting.
  const { data: period, error: periodError } = await supabase
    .schema('finance')
    .from('accounting_periods')
    .select('id')
    .eq('organization_id', organizationId)
    .eq('status', 'OPEN')
    .lte('start_date', distribution_date)
    .gte('end_date', distribution_date)
    .maybeSingle();

  if (periodError) {
    return NextResponse.json({ error: periodError.message }, { status: 500 });
  }
  if (!period) {
    return NextResponse.json(
      { error: 'No OPEN accounting period found for the distribution date' },
      { status: 400 }
    );
  }

  try {
    // Calculate the complete WHT-aware journal using the authenticated,
    // organization-scoped server client.
    const prepared = await postDistributionWithWHT({
      distribution_id,
      organization_id: organizationId,
      period_id: period.id,
      declared_by: auth.userId,
      description,
      distribution_date,
      withholding_override,
      supabaseClient: supabase,
    });

    if ('error' in prepared && prepared.error) {
      return NextResponse.json(
        { error: prepared.error },
        { status: prepared.status || 400 }
      );
    }

    if (!prepared.journalData || !prepared.journalLines) {
      return NextResponse.json(
        { error: 'Unable to prepare profit distribution journal' },
        { status: 500 }
      );
    }

    // One DB transaction posts the prepared journal and moves the distribution
    // to POSTED. This prevents a GL entry from being created without the
    // source distribution being finalized.
    const { data: journalId, error: postError } = await supabase
      .schema('finance')
      .rpc('post_profit_distribution_atomic', {
        p_distribution_id: distribution_id,
        p_period_id: period.id,
        p_transaction_date: distribution_date,
        p_description: prepared.journalData.description,
        p_currency: prepared.journalData.currency,
        p_exchange_rate: prepared.journalData.exchange_rate,
        p_lines: prepared.journalLines,
      });

    if (postError || !journalId) {
      return NextResponse.json(
        { error: postError?.message || 'Profit distribution GL posting failed' },
        { status: 400 }
      );
    }

    // Persist the WHT split on the distribution lines for transparency and
    // downstream payment/reporting screens. The GL transaction is already
    // atomic above; these are source-detail updates only.
    const whtLines = prepared.whtCalculation?.lines || [];
    if (whtLines.length) {
      for (const line of whtLines) {
        const { error: lineError } = await supabase
          .schema('finance')
          .from('distribution_lines')
          .update({
            withholding_rate: line.withholding_rate,
            withholding_amount: line.withholding_amount,
            net_amount: line.net_amount,
            withholding_exempt: line.withholding_exempt,
            withholding_exempt_reason: line.withholding_exempt_reason || null,
            updated_at: new Date().toISOString(),
          })
          .eq('profit_distribution_id', distribution_id)
          .eq('owner_id', line.owner_id);

        if (lineError) {
          console.error('Profit distribution WHT line update failed:', lineError);
        }
      }
    }

    const compliance = await recordWithholdingForTaxCompliance(
      distribution_id,
      prepared.whtCalculation,
      organizationId,
      auth.userId,
      journalId,
      undefined,
      supabase
    );

    if (!compliance.success) {
      console.error('Profit distribution WHT compliance record failed:', compliance.error);
    }

    try {
      await supabase.schema('audit').rpc('log_action', {
        p_user_id: auth.userId,
        p_action: 'PROFIT_DISTRIBUTION_POSTED',
        p_entity_type: 'profit_distribution',
        p_entity_id: distribution_id,
        p_description: `Posted profit distribution to GL (journal ${journalId})`,
        p_previous_status: 'APPROVED',
        p_new_status: 'POSTED',
        p_source_module: 'profit_distribution',
        p_severity: 'high',
        p_related_journal_id: journalId,
        p_new_values: {
          total_gross: prepared.whtCalculation.total_gross_amount,
          total_wht: prepared.whtCalculation.total_withholding_tax,
          total_net: prepared.whtCalculation.total_net_payment,
        },
      });
    } catch (auditError) {
      console.error('Profit distribution audit log failed:', auditError);
    }

    return NextResponse.json({
      success: true,
      journalId,
      whtCalculation: prepared.whtCalculation,
      complianceRecorded: compliance.success,
    });
  } catch (error: any) {
    console.error('Profit distribution posting failed:', error);
    return NextResponse.json(
      { error: error?.message || 'Profit distribution posting failed' },
      { status: 400 }
    );
  }
}

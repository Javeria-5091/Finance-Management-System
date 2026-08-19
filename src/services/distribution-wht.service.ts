import { supabase } from '@/lib/supabase';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface WithholdingTaxConfig {
  /** Whether dividend withholding tax is enabled */
  enabled: boolean;
  /** Tax rate as percentage (e.g., 15 means 15%) */
  rate: number;
  /** Minimum amount threshold below which no withholding applies */
  minimum_threshold: number;
  /** Maximum withholding amount cap (0 = no cap) */
  maximum_cap: number;
  /** Withholding tax account ID in Chart of Accounts */
  withholding_tax_account_id: string;
  /** Payable account for withholding liability */
  withholding_payable_account_id: string;
  /** Effective date from which this config applies */
  effective_from: string;
  /** Tax authority/corporate tax number for reference */
  tax_reference?: string;
}

export interface DistributionLine {
  owner_id: string;
  owner_name: string;
  ownership_percentage: number;
  gross_amount: number;
  withholding_rate: number;
  withholding_amount: number;
  net_amount: number;
  withholding_exempt: boolean;
  withholding_exempt_reason?: string;
  cnic?: string;
}

export interface WithholdingTaxCalculation {
  distribution_id: string;
  total_gross_amount: number;
  total_withholding_tax: number;
  total_net_payment: number;
  currency: string;
  lines: DistributionLine[];
  effective_rate: number;
  reference: string;
}

export interface PostDistributionWithWHTInput {
  distribution_id: string;
  organization_id: string;
  period_id: string;
  declared_by: string;
  description?: string;
  distribution_date: string;
  /** Optional: override the default withholding config */
  withholding_override?: {
    rate?: number;
    exempt_owner_ids?: string[];
    exempt_reason?: string;
  };
}

// ─── Default Withholding Tax Config (Pakistan dividend withholding) ──────────
// Spec: "All organization defaults are seed/configuration data, not hardcoded constants"
// This default is used only when no org-specific config exists in core.distribution_tax_config

const DEFAULT_WHT_CONFIG: WithholdingTaxConfig = {
  enabled: true,
  rate: 15, // 15% dividend withholding tax (Pakistan standard)
  minimum_threshold: 0,
  maximum_cap: 0, // No cap
  withholding_tax_account_id: '', // Must be configured per organization
  withholding_payable_account_id: '', // Must be configured per organization
  effective_from: '2026-07-01',
  tax_reference: 'Pakistani Dividend Withholding Tax under Section 149 of Income Tax Ordinance 2001',
};

// ─── Helper ──────────────────────────────────────────────────────────────────

function getData<T = any>(res: any): T | null {
  return res?.data ?? null;
}

// ─── Fetch Withholding Tax Config from DB ────────────────────────────────────
// Reads from core.distribution_tax_config (organization-scoped, configurable)

export async function getWithholdingTaxConfig(
  organizationId: string
): Promise<WithholdingTaxConfig> {
  try {
    const config = getData<WithholdingTaxConfig>(
      await supabase
        .from('core.distribution_tax_config')
        .select('*')
        .eq('organization_id', organizationId)
        .eq('enabled', true)
        .order('effective_from', { ascending: false })
        .limit(1)
        .maybeSingle()
    );

    if (config) {
      return config;
    }
  } catch (err) {
    console.error('Failed to fetch WHT config, using defaults:', err);
  }
  return { ...DEFAULT_WHT_CONFIG };
}

// ─── Calculate Withholding Tax on Distribution Lines ─────────────────────────
// Spec 5.13: "Calculate distributable profit only after approved expenses,
//            liabilities, fees, taxes/withholding, and period-close adjustments."
// Spec 5.12: "withholding as separate lines/accounts"

export function calculateWithholdingTax(
  distributionLines: any[], // Raw distribution lines from DB
  whtConfig: WithholdingTaxConfig,
  override?: {
    rate?: number;
    exempt_owner_ids?: string[];
    exempt_reason?: string;
  }
): DistributionLine[] {
  const effectiveRate = override?.rate ?? whtConfig.rate;

  return distributionLines.map(line => {
    const grossAmount = Number(line.amount) || 0;
    const isExempt = override?.exempt_owner_ids?.includes(line.owner_id) || line.wht_exempt || false;

    let withholdingAmount = 0;

    if (whtConfig.enabled && !isExempt && grossAmount > 0) {
      // Apply minimum threshold check
      if (whtConfig.minimum_threshold > 0 && grossAmount < whtConfig.minimum_threshold) {
        withholdingAmount = 0;
      } else {
        withholdingAmount = grossAmount * (effectiveRate / 100);

        // Apply maximum cap check
        if (whtConfig.maximum_cap > 0 && withholdingAmount > whtConfig.maximum_cap) {
          withholdingAmount = whtConfig.maximum_cap;
        }
      }
    }

    return {
      owner_id: line.owner_id,
      owner_name: line.owner_name || '',
      ownership_percentage: Number(line.ownership_percentage) || 0,
      gross_amount: grossAmount,
      withholding_rate: isExempt ? 0 : effectiveRate,
      withholding_amount: Math.round(withholdingAmount * 100) / 100,
      net_amount: Math.round((grossAmount - withholdingAmount) * 100) / 100,
      withholding_exempt: isExempt,
      withholding_exempt_reason: isExempt
        ? override?.exempt_reason || line.wht_exempt_reason || 'Exempt per configuration'
        : undefined,
      cnic: line.cnic || line.ntn || undefined,
    };
  });
}

// ─── Post Profit Distribution with Withholding Tax to GL ────────────────────
// Spec 5.13: CEO/authorized governance approval required before distribution becomes payable
// Journal entries:
//   DR Retained Earnings (Equity)     — total gross distribution
//   CR Dividend Payable (Liability)   — total net payment to owners
//   CR Withholding Tax Payable (Liability) — total withholding tax

export async function postDistributionWithWHT(
  input: PostDistributionWithWHTInput
) {
  const { distribution_id, organization_id, period_id, declared_by, description, withholding_override } = input;

  // 1. Fetch distribution with lines
  const distribution = getData(
    await supabase
      .from('finance.distributions')
      .select('*, distribution_lines(*)')
      .eq('id', distribution_id)
      .eq('organization_id', organization_id)
      .single()
  );

  if (!distribution) {
    return { error: 'Distribution not found', status: 404 };
  }

  if (distribution.status !== 'APPROVED') {
    return { error: `Only APPROVED distributions can be posted. Current: ${distribution.status}`, status: 400 };
  }

  // 2. Check WHT config
  const whtConfig = await getWithholdingTaxConfig(organization_id);

  if (whtConfig.enabled && !whtConfig.withholding_tax_account_id) {
    return {
      error: 'Withholding tax is enabled but no withholding tax account configured. Set up withholding_tax_account_id in distribution tax config.',
      status: 400,
    };
  }

  if (whtConfig.enabled && !whtConfig.withholding_payable_account_id) {
    return {
      error: 'Withholding tax is enabled but no withholding payable account configured. Set up withholding_payable_account_id in distribution tax config.',
      status: 400,
    };
  }

  // 3. Calculate withholding tax on each distribution line
  const linesWithWHT = calculateWithholdingTax(
    distribution.distribution_lines || [],
    whtConfig,
    withholding_override
  );

  // 4. Totals
  const totalGross = linesWithWHT.reduce((sum, l) => sum + l.gross_amount, 0);
  const totalWHT = linesWithWHT.reduce((sum, l) => sum + l.withholding_amount, 0);
  const totalNet = linesWithWHT.reduce((sum, l) => sum + l.net_amount, 0);

  // Validate balanced: totalGross must equal totalNet + totalWHT
  if (Math.abs(totalGross - (totalNet + totalWHT)) > 0.01) {
    return {
      error: `Withholding calculation imbalance: Gross ${totalGross} != Net ${totalNet} + WHT ${totalWHT}`,
      status: 500,
    };
  }

  // 5. Find required accounts
  const retainedEarningsAccount = getData(
    await supabase
      .from('finance.chart_of_accounts')
      .select('id, code, name')
      .eq('account_type', 'EQUITY')
      .eq('is_active', true)
      .ilike('name', '%retained%')
      .limit(1)
      .maybeSingle()
  );

  if (!retainedEarningsAccount) {
    return { error: 'Retained Earnings (EQUITY) account not found in Chart of Accounts.', status: 400 };
  }

  const dividendPayableAccount = getData(
    await supabase
      .from('finance.chart_of_accounts')
      .select('id, code, name')
      .eq('account_type', 'LIABILITY')
      .eq('is_active', true)
      .ilike('name', '%dividend%')
      .maybeSingle()
  );

  if (!dividendPayableAccount) {
    return { error: 'Dividend Payable (LIABILITY) account not found in Chart of Accounts.', status: 400 };
  }

  // 6. Generate reference number
  const { data: numData } = await supabase.rpc('get_next_number', { p_type: 'JE-DIST' });
  const reference = numData || `JE-DIST-${Date.now()}`;

  // 7. Build journal lines
  const journalLines: any[] = [];
  let lineNum = 1;

  // DR: Retained Earnings (total gross distribution)
  journalLines.push({
    account_id: retainedEarningsAccount.id,
    debit_amount: totalGross,
    credit_amount: 0,
    description: `Profit distribution: ${description || 'Declared distribution'} — ${linesWithWHT.length} owners/shareholders`,
    line_number: lineNum++,
  });

  // CR: Dividend Payable — net payment to each owner
  // Group by unique amounts to reduce line count
  const netByOwner = linesWithWHT.filter(l => l.net_amount > 0);
  if (netByOwner.length > 0) {
    journalLines.push({
      account_id: dividendPayableAccount.id,
      debit_amount: 0,
      credit_amount: totalNet,
      description: `Net dividend payable to ${netByOwner.length} owner(s) after withholding tax`,
      line_number: lineNum++,
    });
  }

  // CR: Withholding Tax Payable — total withholding tax (Spec 5.12)
  if (totalWHT > 0 && whtConfig.enabled) {
    journalLines.push({
      account_id: whtConfig.withholding_payable_account_id,
      debit_amount: 0,
      credit_amount: totalWHT,
      description: `Withholding tax on dividend distribution @ ${whtConfig.rate}% (Reference: ${whtConfig.tax_reference || 'Organization policy'})`,
      line_number: lineNum++,
    });
  }

  // Validate balanced entry
  const totalDebit = journalLines.reduce((sum, l) => sum + Number(l.debit_amount), 0);
  const totalCredit = journalLines.reduce((sum, l) => sum + Number(l.credit_amount), 0);
  if (Math.abs(totalDebit - totalCredit) > 0.01) {
    return {
      error: `Journal entry does not balance. Debit: ${totalDebit}, Credit: ${totalCredit}`,
      status: 500,
    };
  }

  return {
    // Return all data needed to create the journal
    journalData: {
      reference,
      description: `Profit Distribution: ${description || distribution.description || 'Declared'} — Total PKR ${totalGross.toLocaleString()} (WHT: PKR ${totalWHT.toLocaleString()}, Net: PKR ${totalNet.toLocaleString()})`,
      status: 'APPROVED',
      entry_date: input.distribution_date,
      period_id,
      project_id: null,
      source_type: 'PROFIT_DISTRIBUTION',
      source_id: distribution_id,
      total_debit: totalDebit,
      total_credit: totalCredit,
      currency: distribution.currency || 'PKR',
      exchange_rate: 1,
      created_by: declared_by,
      approved_by: declared_by,
      approved_at: new Date().toISOString(),
      organization_id,
    },
    journalLines,
    whtCalculation: {
      distribution_id,
      total_gross_amount: totalGross,
      total_withholding_tax: totalWHT,
      total_net_payment: totalNet,
      currency: distribution.currency || 'PKR',
      lines: linesWithWHT,
      effective_rate: whtConfig.enabled ? (withholding_override?.rate ?? whtConfig.rate) : 0,
      reference,
    },
    withholding_config: whtConfig,
  };
}

// ─── Create Withholding Tax Record for Tax Compliance (Spec 2.10) ────────────
// Records in tax_credits_and_withholding for reconciliation with tax returns

export async function recordWithholdingForTaxCompliance(
  distributionId: string,
  whtCalculation: WithholdingTaxCalculation,
  organizationId: string,
  postedBy: string,
  journalId: string,
  fiscalYearId?: string
): Promise<{ success: boolean; error?: string }> {
  if (whtCalculation.total_withholding_tax <= 0) {
    return { success: true }; // No WHT to record
  }

  try {
    const whtRecords = whtCalculation.lines
      .filter(l => l.withholding_amount > 0)
      .map(line => ({
        organization_id: organizationId,
        withholding_type: 'DIVIDEND',
        tax_year_id: fiscalYearId || null,
        source_type: 'PROFIT_DISTRIBUTION',
        source_id: distributionId,
        journal_id: journalId,
        payee_type: 'OWNER',
        payee_id: line.owner_id,
        payee_name: line.owner_name,
        payee_cnic: line.cnic || null,
        gross_amount: line.gross_amount,
        withholding_rate: line.withholding_rate,
        withholding_amount: line.withholding_amount,
        net_payment: line.net_amount,
        currency: whtCalculation.currency,
        status: 'HELD', // WHT is held until paid to tax authority
        reference: whtCalculation.reference,
        withholding_period: new Date().toISOString().split('T')[0],
        tax_authority_reference: 'FBR', // Federal Board of Revenue, Pakistan
        created_by: postedBy,
        metadata: {
          distribution_id: distributionId,
          journal_id: journalId,
          ownership_percentage: line.ownership_percentage,
        },
      }));

    if (whtRecords.length === 0) {
      return { success: true };
    }

    const { error } = await supabase
      .from('finance.tax_credits_and_withholding')
      .insert(whtRecords);

    if (error) {
      console.error('Failed to record WHT for tax compliance:', error);
      return { success: false, error: error.message };
    }

    return { success: true };
  } catch (err: any) {
    console.error('WHT compliance recording error:', err);
    return { success: false, error: err.message };
  }
}
import { supabase as browserSupabase } from '@/lib/supabase';
import type { SupabaseClient } from '@supabase/supabase-js';

// BUG-007 FIX: Type alias for the optional supabase client parameter.
// API routes pass their server-side authenticated client; frontend code
// omits it and the browser client is used.
type SClient = SupabaseClient<any, any, any>;

function resolveClient(override?: SClient | null): SClient {
  return override || (browserSupabase as unknown as SClient);
}

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
  /**
   * BUG-007 FIX: Optional server-side authenticated supabase client.
   * API routes pass their server-side client (from getAuthSupabase()) so
   * distribution/WHT queries run with the authenticated user's RLS context.
   */
  supabaseClient?: SClient | null;
}

// ─── Default Withholding Tax Config (Pakistan dividend withholding) ──────────
// Spec: "All organization defaults are seed/configuration data, not hardcoded constants"
// This default is used only when no org-specific config exists in core.distribution_tax_config.
//
// BUG-016 FIX: core.distribution_tax_config did not exist anywhere in the
// schema, so every organization silently fell back to this default with
// empty account IDs, and postDistributionWithWHT() always returned 400
// "no withholding tax account configured". The table now exists (see
// supabase/migrations/P2/P2_006_bug016_profit_distribution.sql), which
// also backfills a working default row per existing organization — this
// constant remains only as the last-resort fallback for an org that
// somehow still has no config row (e.g. deleted its only row).

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
  organizationId: string,
  supabaseClient?: SClient | null
): Promise<WithholdingTaxConfig> {
  const supabase = resolveClient(supabaseClient);
  try {
    const config = getData<WithholdingTaxConfig>(
      await supabase
        .schema('core').from('distribution_tax_config')
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
    // FIN-005 FIX: finance.distribution_lines has no "gross_amount" column.
    // The canonical pre-WHT amount is final_amount (falls back to
    // overridden_amount, then calculated_amount for rows computed but not
    // yet finalized). Reading the non-existent "gross_amount" silently
    // produced NaN -> 0, so withholding tax was never calculated.
    const grossAmount = Number(
      line.gross_amount ?? line.final_amount ?? line.overridden_amount ?? line.calculated_amount
    ) || 0;
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
  const { distribution_id, organization_id, period_id, declared_by, description, withholding_override, supabaseClient } = input;
  const supabase = resolveClient(supabaseClient);

  // 1. Fetch distribution with lines
  // BUG FIX (verified against schema): finance.distributions does not
  // exist — the real table created by
  // phase_7_tax_equity/024_ownership_reserves.sql is
  // finance.profit_distributions. Querying the non-existent name meant
  // this call always failed at runtime with a PostgREST
  // "relation does not exist" error, so profit distribution posting was
  // completely broken end-to-end.
  const distribution = getData(
    await supabase
      .schema('finance').from('profit_distributions')
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

  // BUG-024 FIX (High): verify the fiscal year this distribution's profit
  // was calculated from is not still fully OPEN. Spec 5.13/6.2: distributable
  // profit is only meaningful "after approved expenses, liabilities, fees,
  // taxes/withholding, and period-close adjustments" and "the monthly close
  // remains the authoritative distribution basis" — an OPEN fiscal year has
  // had no period-close adjustments applied yet, so a distribution declared
  // against it is not yet on a reliable profit figure. SOFT_CLOSED and
  // HARD_CLOSED are both accepted (spec's month-end close workflow runs
  // ahead of full fiscal-year hard-close).
  if (distribution.fiscal_year_id) {
    const fiscalYear = getData(
      await supabase
        .schema('finance').from('fiscal_years')
        .select('id, status, name')
        .eq('id', distribution.fiscal_year_id)
        .single()
    );
    if (!fiscalYear) {
      return { error: 'Fiscal year referenced by this distribution was not found', status: 400 };
    }
    if (fiscalYear.status === 'OPEN') {
      return {
        error: `Cannot post distribution: fiscal year "${fiscalYear.name}" is still OPEN. Distributions require at least a soft close of the relevant period/fiscal year so the profit figure reflects approved close adjustments.`,
        status: 400,
      };
    }
  }

  // 2. Check WHT config
  const whtConfig = await getWithholdingTaxConfig(organization_id, supabaseClient);

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
  // BUG-016 FIX: both lookups below were missing an organization_id
  // filter — in a multi-tenant deployment this could resolve another
  // organization's GL account and post a distribution's retained
  // earnings / dividend payable into the wrong org's books entirely.
  const retainedEarningsAccount = getData(
    await supabase
      .schema('finance').from('chart_of_accounts')
      .select('id, code, name')
      .eq('account_type', 'EQUITY')
      .eq('is_active', true)
      .eq('organization_id', organization_id)
      .ilike('name', '%retained%')
      .order('code', { ascending: true })
      .limit(1)
      .maybeSingle()
  );

  if (!retainedEarningsAccount) {
    return { error: 'Retained Earnings (EQUITY) account not found in Chart of Accounts.', status: 400 };
  }

  // BUG-016 FIX: this seeded liability account is named "Profit
  // Distribution Payable" (code 2410), not "Dividend Payable" — the old
  // `.ilike('name', '%dividend%')` filter could never match it, so this
  // lookup always failed and posting was unreachable even once the WHT
  // config existed. Match the known control-account code first
  // (deterministic), falling back to a name search that covers both
  // naming conventions for orgs with a differently-named account.
  let dividendPayableAccount = getData(
    await supabase
      .schema('finance').from('chart_of_accounts')
      .select('id, code, name')
      .eq('account_type', 'LIABILITY')
      .eq('is_active', true)
      .eq('organization_id', organization_id)
      .eq('code', '2410')
      .maybeSingle()
  );

  if (!dividendPayableAccount) {
    dividendPayableAccount = getData(
      await supabase
        .schema('finance').from('chart_of_accounts')
        .select('id, code, name')
        .eq('account_type', 'LIABILITY')
        .eq('is_active', true)
        .eq('organization_id', organization_id)
        .or('name.ilike.%dividend%,name.ilike.%distribution%payable%,name.ilike.%profit%distribution%')
        .order('code', { ascending: true })
        .limit(1)
        .maybeSingle()
    );
  }

  if (!dividendPayableAccount) {
    return { error: 'Dividend/Profit Distribution Payable (LIABILITY) account not found in Chart of Accounts.', status: 400 };
  }

  // 6. Generate reference number
  const { data: numData } = await supabase.schema('finance').rpc('get_next_number', { p_type: 'JE-DIST' });
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
      currency: 'PKR',
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
      currency: 'PKR',
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
  fiscalYearId?: string,
  supabaseClient?: SClient | null
): Promise<{ success: boolean; error?: string }> {
  const supabase = resolveClient(supabaseClient);
  if (whtCalculation.total_withholding_tax <= 0) {
    return { success: true }; // No WHT to record
  }

  try {
    const whtRecords = whtCalculation.lines
      .filter(l => l.withholding_amount > 0)
      .map(line => ({
        organization_id: organizationId,
        credit_type: 'WHT_DEDUCTED',
        fiscal_year_id: fiscalYearId || null,
        source_type: 'PROFIT_DISTRIBUTION',
        source_id: distributionId,
        counterparty_name: line.owner_name,
        counterparty_cnic: line.cnic || null,
        gross_amount: line.gross_amount,
        wht_rate: line.withholding_rate,
        credit_amount: line.withholding_amount,
        currency: whtCalculation.currency,
        status: 'PENDING', // WHT credit remains pending until claimed/adjusted
        // P0-10 FIX: finance.tax_credits_and_withholding (schema.sql) has no
        // `metadata` column at all — the insert below used to send
        // { metadata: { distribution_id, ownership_percentage } }, which
        // PostgREST rejected outright with PGRST204 "Could not find the
        // column metadata in the schema cache", failing every WHT record
        // insert. The table's real columns are: organization_id,
        // tax_computation_id, fiscal_year_id, period_id, credit_type,
        // counterparty_name, counterparty_cnic, counterparty_ntn,
        // source_type, source_id, gross_amount, wht_rate, credit_amount,
        // currency, status, tax_return_id, notes, created_by. Of the two
        // values that used to live in `metadata`: distribution_id is
        // already captured above via source_id (source_type
        // 'PROFIT_DISTRIBUTION'), so it was redundant; ownership_percentage
        // has no dedicated column, so it's folded into the existing
        // free-text `notes` column instead of being dropped silently.
        notes: `Dividend WHT ${whtCalculation.reference} — net payment PKR ${Number(line.net_amount).toLocaleString()} (ownership ${Number(line.ownership_percentage) || 0}%)`,
        created_by: postedBy,
      }));

    if (whtRecords.length === 0) {
      return { success: true };
    }

    const { error } = await supabase
      .schema('finance').from('tax_credits_and_withholding')
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
// ================================================================
// OSYSTIC — Commission Service (P1)
// File: src/services/commission.service.ts
// Convention: Follows contractor.service.ts / subscription.service.ts pattern
// ================================================================

import { supabase } from '@/lib/supabase';
import type {
  CommissionRow,
  CommissionByPersonRow,
  CommissionByProjectRow,
  CommissionByTypeRow,
  CommissionStatusRow,
  CommissionStats,
} from '@/types/commission.types';

// ─── Helper: empty strings to null ───
function emptyToNull(obj: Record<string, any>): Record<string, any> {
  const cleaned: Record<string, any> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === '' || (typeof value === 'string' && value.trim() === '')) {
      cleaned[key] = null;
    } else if (typeof value === 'string') {
      cleaned[key] = value.trim();
    } else {
      cleaned[key] = value;
    }
  }
  return cleaned;
}

// ─── Calculate commission amount based on type and basis ───
export function calculateCommission(
  commissionType: string,
  rateOrAmount: number,
  baseAmount: number
): number {
  if (commissionType === 'PERCENTAGE') {
    // rate_or_amount is a percentage (e.g., 10.5 means 10.5%)
    return Math.round((baseAmount * rateOrAmount) / 100 * 100) / 100;
  }
  // FIXED_AMOUNT, FLAT_BONUS, REFERRAL, TIERED all use rate_or_amount directly
  return Math.round(rateOrAmount * 100) / 100;
}

// ─── Fetch all commissions ───
export async function fetchCommissions(orgId: string, filters?: {
  search?: string;
  status?: string;
  commission_type?: string;
  person_type?: string;
  project_id?: string;
  contractor_id?: string;
}) {
  let query = supabase
    .schema('finance')
    .from('commissions')
    .select('*')
    .eq('organization_id', orgId)
    .order('created_at', { ascending: false });

  if (filters?.search) {
    const term = `%${filters.search}%`;
    query = query.or(`person_name.ilike.${term},invoice_ref.ilike.${term},milestone_ref.ilike.${term},payment_ref.ilike.${term}`);
  }
  if (filters?.status) {
    query = query.eq('status', filters.status);
  }
  if (filters?.commission_type) {
    query = query.eq('commission_type', filters.commission_type);
  }
  if (filters?.person_type) {
    query = query.eq('person_type', filters.person_type);
  }
  if (filters?.project_id) {
    query = query.eq('project_id', filters.project_id);
  }
  if (filters?.contractor_id) {
    query = query.eq('contractor_id', filters.contractor_id);
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data as CommissionRow[]) || [];
}

// ─── Fetch single commission ───
export async function fetchCommissionById(orgId: string, id: string) {
  const { data, error } = await supabase
    .schema('finance')
    .from('commissions')
    .select('*')
    .eq('organization_id', orgId)
    .eq('id', id)
    .single();
  if (error) throw new Error(error.message);
  return data as CommissionRow;
}

// ─── Create commission ───
export async function createCommission(commissionData: Record<string, any>) {
  const cleaned = emptyToNull({
    ...commissionData,
    status: commissionData.status || 'PENDING',
  });

  // Parse numerics
  if (typeof cleaned.rate_or_amount === 'string') {
    cleaned.rate_or_amount = parseFloat(cleaned.rate_or_amount) || 0;
  }
  if (typeof cleaned.base_amount === 'string') {
    cleaned.base_amount = parseFloat(cleaned.base_amount) || 0;
  }
  if (typeof cleaned.commission_amount === 'string') {
    cleaned.commission_amount = parseFloat(cleaned.commission_amount) || 0;
  }
  if (typeof cleaned.tax_withheld === 'string') {
    cleaned.tax_withheld = parseFloat(cleaned.tax_withheld) || 0;
  }

  // Auto-calculate commission_amount if not provided or if PERCENTAGE type
  if (!cleaned.commission_amount || cleaned.commission_type === 'PERCENTAGE') {
    cleaned.commission_amount = calculateCommission(
      cleaned.commission_type || 'PERCENTAGE',
      cleaned.rate_or_amount || 0,
      cleaned.base_amount || 0
    );
  }

  const { data, error } = await supabase
    .schema('finance')
    .from('commissions')
    .insert(cleaned)
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  return data as CommissionRow;
}

// ─── Update commission ───
export async function updateCommission(orgId: string, id: string, updates: Record<string, any>) {
  const { created_by, id: _id, net_amount: _na, ...rest } = updates as any;
  const cleaned = emptyToNull(rest);

  // Parse numerics
  if (typeof cleaned.rate_or_amount === 'string') {
    cleaned.rate_or_amount = parseFloat(cleaned.rate_or_amount) || 0;
  }
  if (typeof cleaned.base_amount === 'string') {
    cleaned.base_amount = parseFloat(cleaned.base_amount) || 0;
  }
  if (typeof cleaned.commission_amount === 'string') {
    cleaned.commission_amount = parseFloat(cleaned.commission_amount) || 0;
  }
  if (typeof cleaned.tax_withheld === 'string') {
    cleaned.tax_withheld = parseFloat(cleaned.tax_withheld) || 0;
  }

  // Recalculate commission if percentage type and base/rate changed
  if (cleaned.commission_type === 'PERCENTAGE' && (cleaned.base_amount !== undefined || cleaned.rate_or_amount !== undefined)) {
    const existing = await fetchCommissionById(orgId, id);
    const base = cleaned.base_amount ?? existing.base_amount;
    const rate = cleaned.rate_or_amount ?? existing.rate_or_amount;
    cleaned.commission_amount = calculateCommission('PERCENTAGE', rate, base);
  }

  const { data, error } = await supabase
    .schema('finance')
    .from('commissions')
    .update(cleaned)
    .eq('organization_id', orgId)
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  return data as CommissionRow;
}

// ─── Delete commission ───
export async function deleteCommission(id: string) {
  const { error } = await supabase
    .schema('finance')
    .from('commissions')
    .delete()
    .eq('id', id);
  if (error) throw new Error(error.message);
}

// ─── Approve commission ───
export async function approveCommission(id: string, approvedBy: string) {
  const { data, error } = await supabase
    .schema('finance')
    .from('commissions')
    .update({
      status: 'APPROVED',
      approved_by: approvedBy,
      approved_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('status', 'PENDING')  // Only pending can be approved
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  if (!data) throw new Error('Commission not found or not in PENDING status');
  return data as CommissionRow;
}

// ─── Mark commission as paid ───
export async function markCommissionPaid(id: string, paymentDate: string, paymentRef: string) {
  const { data, error } = await supabase
    .schema('finance')
    .from('commissions')
    .update({
      status: 'PAID',
      payment_date: paymentDate,
      payment_ref: paymentRef || null,
    })
    .eq('id', id)
    .eq('status', 'APPROVED')  // Only approved can be marked paid
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  if (!data) throw new Error('Commission not found or not in APPROVED status');
  return data as CommissionRow;
}

// ─── Fetch summary by person (from view) ───
export async function fetchCommissionByPerson(orgId: string) {
  const { data, error } = await supabase
    .schema('reporting')
    .from('v_commission_by_person')
    .select('*')
    .eq('organization_id', orgId);
  if (error) throw new Error(error.message);
  return (data as CommissionByPersonRow[]) || [];
}

// ─── Fetch summary by project (from view) ───
export async function fetchCommissionByProject(orgId: string) {
  const { data, error } = await supabase
    .schema('reporting')
    .from('v_commission_by_project')
    .select('*')
    .eq('organization_id', orgId);
  if (error) throw new Error(error.message);
  return (data as CommissionByProjectRow[]) || [];
}

// ─── Fetch summary by type (from view) ───
export async function fetchCommissionByType(orgId: string) {
  const { data, error } = await supabase
    .schema('reporting')
    .from('v_commission_by_type')
    .select('*')
    .eq('organization_id', orgId);
  if (error) throw new Error(error.message);
  return (data as CommissionByTypeRow[]) || [];
}

// ─── Fetch status summary (from view) ───
export async function fetchCommissionStatusSummary(orgId: string) {
  const { data, error } = await supabase
    .schema('reporting')
    .from('v_commission_status_summary')
    .select('*')
    .eq('organization_id', orgId);
  if (error) throw new Error(error.message);
  return (data as CommissionStatusRow[]) || [];
}

// ─── Fetch commission stats ───
export async function fetchCommissionStats(orgId: string): Promise<CommissionStats> {
  const { data, error } = await supabase
    .schema('finance')
    .from('commissions')
    .select('id, commission_amount, tax_withheld, net_amount, status, currency')
    .eq('organization_id', orgId);
  if (error) throw new Error(error.message);

  const rows = data || [];

  let pendingCount = 0;
  let pendingAmount = 0;
  let approvedCount = 0;
  let approvedAmount = 0;
  let paidCount = 0;
  let paidAmount = 0;
  let totalCommission = 0;
  let totalTaxWithheld = 0;
  let totalNetPaid = 0;

  // Currency frequency for top currency
  const curFreq: Record<string, number> = {};

  for (const r of rows) {
    const ca = Number(r.commission_amount) || 0;
    const tw = Number(r.tax_withheld) || 0;
    const na = Number(r.net_amount) || 0;
    const cur = r.currency || 'PKR';

    curFreq[cur] = (curFreq[cur] || 0) + 1;

    totalCommission += ca;
    totalTaxWithheld += tw;

    switch (r.status) {
      case 'PENDING':
        pendingCount++;
        pendingAmount += ca;
        break;
      case 'APPROVED':
        approvedCount++;
        approvedAmount += ca;
        break;
      case 'PAID':
        paidCount++;
        paidAmount += ca;
        totalNetPaid += na;
        break;
    }
  }

  // Find top currency
  let topCurrency = 'PKR';
  let maxFreq = 0;
  for (const [cur, freq] of Object.entries(curFreq)) {
    if (freq > maxFreq) {
      maxFreq = freq;
      topCurrency = cur;
    }
  }

  return {
    totalRecords: rows.length,
    pendingCount,
    pendingAmount: Math.round(pendingAmount * 100) / 100,
    approvedCount,
    approvedAmount: Math.round(approvedAmount * 100) / 100,
    paidCount,
    paidAmount: Math.round(paidAmount * 100) / 100,
    totalCommission: Math.round(totalCommission * 100) / 100,
    totalTaxWithheld: Math.round(totalTaxWithheld * 100) / 100,
    totalNetPaid: Math.round(totalNetPaid * 100) / 100,
    topCurrency,
  };
}
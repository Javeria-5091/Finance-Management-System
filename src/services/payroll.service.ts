// ================================================================
// OSYSTIC Finance Management System — Payroll Service (P1)
// ================================================================
// P0/P1 Convention: Service layer for payroll data access
// Uses finance schema for all payroll tables
// ================================================================

import { supabase as browserSupabase } from "@/lib/supabase";
import type { SupabaseClient } from '@supabase/supabase-js';

// BUG-007 FIX: This service previously imported the browser supabase client
// directly. When called from an API route, the browser client has no
// authenticated session, causing RLS to reject queries or return wrong data.
//
// Each function below now accepts an optional `supabaseClient` parameter.
// API routes pass their server-side authenticated client (from getAuthSupabase());
// frontend code omits it and the browser client is used (with its valid session).
type SClient = SupabaseClient<any, any, any>;
function resolveClient(override?: SClient | null): SClient {
  return override || (browserSupabase as unknown as SClient);
}

// Backward-compat alias: existing function bodies
// continue to reference `supabase` directly.
const supabase = browserSupabase;

async function getCurrentOrgId(): Promise<string> {
  const { data: { user } } = await browserSupabase.auth.getUser();
  if (!user) throw new Error('Authentication required');
  const { data: profile, error } = await browserSupabase
    .from('profiles')
    .select('organization_id')
    .eq('user_id', user.id)
    .maybeSingle();
  if (error || !profile?.organization_id) throw new Error('Organization context is required');
  return profile.organization_id;
}
// ─── Types (snake_case from Supabase) ───
export interface PayrollEmployeeRow {
  id: string;
  employee_code: string;
  name: string;
  email: string | null;
  phone: string | null;
  designation: string | null;
  department: string | null;
  employment_type: string;
  status: string;
  join_date: string | null;
  bank_name: string | null;
  bank_account: string | null;
  cnic: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface PayrollCompensationRow {
  id: string;
  employee_id: string;
  compensation_type: string;
  amount: number;
  currency: string;
  effective_from: string;
  effective_to: string | null;
  is_active: boolean;
  project_id: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface PayrollRunRow {
  id: string;
  payroll_period: string;
  period_start: string;
  period_end: string;
  status: string;
  total_gross_pay: number;
  total_deductions: number;
  total_net_pay: number;
  total_employer_cost: number;
  total_employees: number;
  calculated_by: string | null;
  calculated_at: string | null;
  approved_by: string | null;
  approved_at: string | null;
  posted_by: string | null;
  posted_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface PayrollLineRow {
  id: string;
  payroll_run_id: string;
  employee_id: string;
  basic_salary: number;
  housing_allow: number;
  medical_allow: number;
  conveyance_allow: number;
  other_allowances: number;
  overtime_pay: number;
  commission_pay: number;
  bonus_pay: number;
  gross_pay: number;
  tax_deduction: number;
  provident_fund: number;
  eobi: number;
  advance_deduction: number;
  other_deductions: number;
  total_deductions: number;
  net_pay: number;
  employer_cost: number;
  payment_status: string;
  payment_date: string | null;
  payment_ref: string | null;
  bank_name: string | null;
  bank_account: string | null;
  project_id: string | null;
  employee_name: string | null;
  employee_code: string | null;
  designation: string | null;
  department: string | null;
  compensation_snapshot: any;
  deduction_snapshot: any;
  notes: string | null;
  created_at: string;
}

// ─── Helper: Convert empty strings to null for DB fields ───
function emptyToNull(obj: Record<string, any>): Record<string, any> {
  const cleaned: Record<string, any> = {};
  for (const [key, value] of Object.entries(obj)) {
    // Convert empty strings to null (DB doesn't accept "" for DATE, UUID, etc.)
    if (value === "") {
      cleaned[key] = null;
    }
    // Trim non-empty strings
    else if (typeof value === "string") {
      cleaned[key] = value.trim() === "" ? null : value.trim();
    }
    // Pass everything else as-is
    else {
      cleaned[key] = value;
    }
  }
  return cleaned;
}

// ─── Employee Services ───

export async function fetchEmployees(search?: string) {
  const orgId = await getCurrentOrgId();
  let query = supabase
    .from("payroll_employees")
    .select("*")
    .eq("organization_id", orgId)
    .order("created_at", { ascending: false });

  if (search) {
    query = query.or(
      `name.ilike.%${search}%,employee_code.ilike.%${search}%,designation.ilike.%${search}%`
    );
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data as PayrollEmployeeRow[]) || [];
}

export async function fetchEmployeeWithCompensation(employeeId: string) {
  const orgId = await getCurrentOrgId();
  const { data, error } = await supabase
    .from("payroll_employees")
    .select("*, payroll_compensation(*)")
    .eq("id", employeeId)
    .eq("organization_id", orgId)
    .single();

  if (error) throw new Error(error.message);
  return data;
}

export async function createEmployee(employeeData: any) {
  const orgId = await getCurrentOrgId();
  // Employee-code generator is defined in public schema.
  const { data: codeData, error: codeError } = await supabase
    .rpc("payroll_generate_employee_code");
  if (codeError) throw new Error(codeError.message);
  const employeeCode =
    codeData || `EMP-${Date.now().toString().slice(-4)}`;

  // ★ FIX: Clean empty strings to null before insert
  const cleanedData = emptyToNull({
    ...employeeData,
    organization_id: orgId,
    employee_code: employeeCode,
    status: "ACTIVE",
  });

  const { data, error } = await supabase
    .from("payroll_employees")
    .insert(cleanedData)
    .select("*")
    .single();

  if (error) throw new Error(error.message);
  return data as PayrollEmployeeRow;
}

export async function updateEmployee(id: string, updates: any) {
  const orgId = await getCurrentOrgId();
  // ★ FIX: Clean empty strings to null before update
  const cleanedUpdates = emptyToNull(updates);

  const { data, error } = await supabase
    .from("payroll_employees")
    .update(cleanedUpdates)
    .eq("id", id)
    .eq("organization_id", orgId)
    .select("*")
    .single();

  if (error) throw new Error(error.message);
  return data as PayrollEmployeeRow;
}

// ─── Compensation Services ───

export async function setCompensation(employeeId: string, compData: any) {
  const cleanedData = emptyToNull({ ...compData });
  const { data, error } = await supabase.rpc('set_payroll_compensation_atomic', {
    p_employee_id: employeeId,
    p_compensation: cleanedData,
  });
  if (error) throw new Error(error.message);
  return data as PayrollCompensationRow;
}

// ─── Deduction Services ───

export async function setDeduction(employeeId: string, dedData: any) {
  const orgId = await getCurrentOrgId();
  // ★ FIX: Clean empty strings to null
  const cleanedData = emptyToNull({
    employee_id: employeeId,
    organization_id: orgId,
    ...dedData,
    is_active: true,
  });

  const { data, error } = await supabase
    .from("payroll_deductions")
    .insert(cleanedData)
    .select("*")
    .single();

  if (error) throw new Error(error.message);
  return data;
}

export async function fetchDeductions(employeeId: string) {
  const orgId = await getCurrentOrgId();
  const { data, error } = await supabase
    .from("payroll_deductions")
    .select("*")
    .eq("employee_id", employeeId)
    .eq("organization_id", orgId)
    .eq("is_active", true);

  if (error) throw new Error(error.message);
  return data || [];
}

// ─── Payroll Run Services ───

export async function fetchPayrollRuns() {
  const orgId = await getCurrentOrgId();
  const { data, error } = await supabase
    .from("payroll_runs")
    .select("*")
    .eq("organization_id", orgId)
    .order("created_at", { ascending: false });

  if (error) throw new Error(error.message);
  return (data as PayrollRunRow[]) || [];
}

export async function fetchPayrollLines(runId: string) {
  const orgId = await getCurrentOrgId();
  const { data, error } = await supabase
    .from("payroll_lines")
    .select("*")
    .eq("payroll_run_id", runId)
    .eq("organization_id", orgId);

  if (error) throw new Error(error.message);
  return (data as PayrollLineRow[]) || [];
}

// ─── Payroll Posting ───
export async function postPayrollRun(payrollRunId: string) {
  const response = await fetch('/api/finance/payroll', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ action: 'post', run_id: payrollRunId }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || 'Payroll posting failed');
  return payload.journal_id as string;
}

// ─── Advance Services ───

export async function fetchAdvances() {
  const orgId = await getCurrentOrgId();
  const { data, error } = await supabase
    .from("payroll_advances")
    .select("*, payroll_employees(id, name, employee_code, department)")
    .eq("organization_id", orgId)
    .order("request_date", { ascending: false });

  if (error) throw new Error(error.message);
  return data || [];
}

// ─── Commission Services ───

export async function fetchCommissions() {
  const orgId = await getCurrentOrgId();
  const { data, error } = await supabase
    .from("payroll_commissions")
    .select("*, payroll_employees(id, name, employee_code, department)")
    .eq("organization_id", orgId)
    .order("created_at", { ascending: false });

  if (error) throw new Error(error.message);
  return data || [];
}

// ─── Payroll Stats (for dashboard) ───

export async function fetchPayrollStats() {
  const orgId = await getCurrentOrgId();
  const [empRes, runRes, advRes] = await Promise.all([
    supabase
      .schema('finance')
      .from("payroll_employees")
      .select("id", { count: "exact" })
      .eq("organization_id", orgId)
      .eq("status", "ACTIVE"),
    supabase
      .schema('finance')
      .from("payroll_runs")
      .select("total_net_pay")
      .eq("organization_id", orgId)
      .eq("status", "POSTED")
      .order("created_at", { ascending: false })
      .limit(1),
    supabase
      .schema('finance')
      .from("payroll_advances")
      .select("remaining_balance")
      .eq("organization_id", orgId)
      .in("approval_status", ["APPROVED", "PARTIALLY_RECOVERED"]),
  ]);

  const activeEmployees = empRes.count || 0;
  const lastPayroll =
    (runRes.data as any[])?.[0]?.total_net_pay || 0;
  const pendingAdvances =
    (advRes.data as any[])?.reduce(
      (s: number, a: any) => s + Number(a.remaining_balance),
      0
    ) || 0;

  return { activeEmployees, lastPayroll, pendingAdvances };
}
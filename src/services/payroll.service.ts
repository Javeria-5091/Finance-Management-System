// ================================================================
// OSYSTIC Finance Management System — Payroll Service (P1)
// ================================================================
// P0/P1 Convention: Service layer for payroll data access
// Uses finance schema for all payroll tables
// ================================================================

import { supabase } from "@/lib/supabase";

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
  let query = supabase
    .schema('finance')
    .from("payroll_employees")
    .select("*")
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
  const { data, error } = await supabase
    .schema('finance')
    .from("payroll_employees")
    .select("*, payroll_compensation(*)")
    .eq("id", employeeId)
    .single();

  if (error) throw new Error(error.message);
  return data;
}

export async function createEmployee(employeeData: any) {
  // Generate employee code
  const { data: codeData } = await supabase
    .schema('finance')
    .rpc("payroll_generate_employee_code");
  const employeeCode =
    codeData || `EMP-${Date.now().toString().slice(-4)}`;

  // ★ FIX: Clean empty strings to null before insert
  const cleanedData = emptyToNull({
    ...employeeData,
    employee_code: employeeCode,
    status: "ACTIVE",
  });

  const { data, error } = await supabase
    .schema('finance')
    .from("payroll_employees")
    .insert(cleanedData)
    .select("*")
    .single();

  if (error) throw new Error(error.message);
  return data as PayrollEmployeeRow;
}

export async function updateEmployee(id: string, updates: any) {
  // ★ FIX: Clean empty strings to null before update
  const cleanedUpdates = emptyToNull(updates);

  const { data, error } = await supabase
    .schema('finance')
    .from("payroll_employees")
    .update(cleanedUpdates)
    .eq("id", id)
    .select("*")
    .single();

  if (error) throw new Error(error.message);
  return data as PayrollEmployeeRow;
}

// ─── Compensation Services ───

export async function setCompensation(employeeId: string, compData: any) {
  // Deactivate old active compensation
  await supabase
    .schema('finance')
    .from("payroll_compensation")
    .update({ is_active: false })
    .eq("employee_id", employeeId)
    .eq("is_active", true);

  // ★ FIX: Clean empty strings to null
  const cleanedData = emptyToNull({
    employee_id: employeeId,
    ...compData,
    is_active: true,
  });

  const { data, error } = await supabase
    .schema('finance')
    .from("payroll_compensation")
    .insert(cleanedData)
    .select("*")
    .single();

  if (error) throw new Error(error.message);
  return data as PayrollCompensationRow;
}

// ─── Deduction Services ───

export async function setDeduction(employeeId: string, dedData: any) {
  // ★ FIX: Clean empty strings to null
  const cleanedData = emptyToNull({
    employee_id: employeeId,
    ...dedData,
    is_active: true,
  });

  const { data, error } = await supabase
    .schema('finance')
    .from("payroll_deductions")
    .insert(cleanedData)
    .select("*")
    .single();

  if (error) throw new Error(error.message);
  return data;
}

export async function fetchDeductions(employeeId: string) {
  const { data, error } = await supabase
    .schema('finance')
    .from("payroll_deductions")
    .select("*")
    .eq("employee_id", employeeId)
    .eq("is_active", true);

  if (error) throw new Error(error.message);
  return data || [];
}

// ─── Payroll Run Services ───

export async function fetchPayrollRuns() {
  const { data, error } = await supabase
    .schema('finance')
    .from("payroll_runs")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) throw new Error(error.message);
  return (data as PayrollRunRow[]) || [];
}

export async function fetchPayrollLines(runId: string) {
  const { data, error } = await supabase
    .schema('finance')
    .from("payroll_lines")
    .select("*")
    .eq("payroll_run_id", runId);

  if (error) throw new Error(error.message);
  return (data as PayrollLineRow[]) || [];
}

// ─── Advance Services ───

export async function fetchAdvances() {
  const { data, error } = await supabase
    .schema('finance')
    .from("payroll_advances")
    .select("*, payroll_employees(id, name, employee_code, department)")
    .order("request_date", { ascending: false });

  if (error) throw new Error(error.message);
  return data || [];
}

// ─── Commission Services ───

export async function fetchCommissions() {
  const { data, error } = await supabase
    .schema('finance')
    .from("payroll_commissions")
    .select("*, payroll_employees(id, name, employee_code, department)")
    .order("created_at", { ascending: false });

  if (error) throw new Error(error.message);
  return data || [];
}

// ─── Payroll Stats (for dashboard) ───

export async function fetchPayrollStats() {
  const [empRes, runRes, advRes] = await Promise.all([
    supabase
      .schema('finance')
      .from("payroll_employees")
      .select("id", { count: "exact" })
      .eq("status", "ACTIVE"),
    supabase
      .schema('finance')
      .from("payroll_runs")
      .select("total_net_pay")
      .eq("status", "POSTED")
      .order("created_at", { ascending: false })
      .limit(1),
    supabase
      .schema('finance')
      .from("payroll_advances")
      .select("remaining_balance")
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
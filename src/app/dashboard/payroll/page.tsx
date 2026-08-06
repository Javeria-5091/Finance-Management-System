'use client'
// ================================================================
// OSYSTIC Finance Management System — Payroll Management Page (P1)
// ================================================================
// Convention: P0/P1 — direct Supabase queries, custom Button/Input,
//              STATUS_STYLES pattern, maker-checker workflow, react-hot-toast,
//              useAuth/usePermissions, logAction
// ================================================================

import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/context/AuthContext";
import { usePermissions } from "@/context/PermissionContext";
import { logAction } from "@/lib/logAction";
import { formatPKR, formatDate, formatPeriod, timeAgo, getEmploymentTypeBadge, getLastDayOfMonth } from "@/lib/helpers";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import {
  Plus, Search, Eye, Edit2, Trash2, ChevronLeft, ChevronRight,
  Users, Calculator, Banknote, TrendingUp, FileText, X, Check, AlertTriangle, Loader2,
} from "lucide-react";
import toast from "react-hot-toast";

// ==========================================
// STATUS STYLES (P0/P1 Convention)
// ==========================================
const STATUS_STYLES: Record<string, string> = {
  DRAFT: "bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300",
  CALCULATED: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
  UNDER_REVIEW: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400",
  APPROVED: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400",
  POSTED: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
  REJECTED: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
  CANCELLED: "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400",
  PENDING: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400",
  PAID: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
  PARTIALLY_PAID: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
  FAILED: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
  ACTIVE: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
  TERMINATED: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
  ON_LEAVE: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  SUSPENDED: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
  FULLY_RECOVERED: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
  PARTIALLY_RECOVERED: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
};

// EMPLOYMENT TYPES
const EMPLOYMENT_TYPES = [
  { value: "FULL_TIME", label: "Full Time" },
  { value: "PART_TIME", label: "Part Time" },
  { value: "CONTRACTOR", label: "Contractor" },
  { value: "INTERN", label: "Intern" },
  { value: "CONSULTANT", label: "Consultant" },
];

// COMPENSATION TYPES
const COMPENSATION_TYPES = [
  { value: "MONTHLY_SALARY", label: "Monthly Salary" },
  { value: "HOURLY_RATE", label: "Hourly Rate" },
  { value: "DAILY_RATE", label: "Daily Rate" },
  { value: "PROJECT_BASED", label: "Project Based" },
  { value: "COMMISSION_ONLY", label: "Commission Only" },
  { value: "FIXED_CONTRACT", label: "Fixed Contract" },
];

// DEDUCTION TYPES
const DEDUCTION_TYPES = [
  { value: "TAX", label: "Income Tax" },
  { value: "PROVIDENT_FUND", label: "Provident Fund" },
  { value: "EOBI", label: "EOBI" },
  { value: "SOCIAL_SECURITY", label: "Social Security" },
  { value: "LOAN_INSTALLMENT", label: "Loan Installment" },
  { value: "ADVANCE_DEDUCTION", label: "Advance Deduction" },
  { value: "ABSENCE_PENALTY", label: "Absence Penalty" },
  { value: "OTHER", label: "Other" },
];

// ==========================================
// LOCAL INTERFACES (matching DB columns — snake_case from Supabase)
// ==========================================
interface PayrollEmployee {
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
  created_at: string;
  updated_at: string;
  // Joined from compensation
  payroll_compensation?: PayrollCompensation[];
}

interface PayrollCompensation {
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

interface PayrollRun {
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
  payroll_lines?: PayrollLine[];
}

interface PayrollLine {
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
  notes: string | null;
  created_at: string;
}

interface PayrollAdvance {
  id: string;
  employee_id: string;
  amount: number;
  purpose: string | null;
  request_date: string;
  approval_status: string;
  approved_by: string | null;
  approved_at: string | null;
  total_deducted: number;
  remaining_balance: number;
  monthly_deduction: number | null;
  start_deduction_month: string | null;
  notes: string | null;
  created_at: string;
  // Joined
  payroll_employees?: { id: string; name: string; employee_code: string; department: string | null } | null;
}

interface PayrollCommission {
  id: string;
  employee_id: string;
  project_id: string | null;
  commission_type: string;
  description: string | null;
  base_amount: number;
  commission_rate: number;
  commission_amount: number;
  period_month: string | null;
  status: string;
  approved_by: string | null;
  approved_at: string | null;
  paid_date: string | null;
  payment_ref: string | null;
  notes: string | null;
  created_at: string;
  // Joined
  payroll_employees?: { id: string; name: string; employee_code: string; department: string | null } | null;
}

// Employee form data type
interface EmployeeFormData {
  name: string;
  email: string;
  phone: string;
  designation: string;
  department: string;
  employment_type: string;
  join_date: string;
  bank_name: string;
  bank_account: string;
  cnic: string;
  notes: string;
}

interface CompensationFormData {
  employee_id: string;
  compensation_type: string;
  amount: string;
  effective_from: string;
  effective_to: string;
  project_id: string;
  notes: string;
}

// ==========================================
// MAIN COMPONENT
// ==========================================
export default function PayrollPage() {
  const { user } = useAuth();
  const { hasPermission, role } = usePermissions();
  const canAdd = hasPermission("PAYROLL_CREATE");
  const canApprove = hasPermission("PAYROLL_APPROVE");
  const canPost = hasPermission("PAYROLL_POST");

  // ─── Tab State ───
  const [activeTab, setActiveTab] = useState<"employees" | "runs" | "advances" | "commissions">("employees");

  // ─── Employees State ───
  const [employees, setEmployees] = useState<PayrollEmployee[]>([]);
  const [empLoading, setEmpLoading] = useState(true);
  const [empSearch, setEmpSearch] = useState("");
  const [empPage, setEmpPage] = useState(1);
  const empPerPage = 10;

  // ─── Runs State ───
  const [runs, setRuns] = useState<PayrollRun[]>([]);
  const [runsLoading, setRunsLoading] = useState(true);
  const [runPage, setRunPage] = useState(1);
  const runPerPage = 10;
  const [selectedRun, setSelectedRun] = useState<PayrollRun | null>(null);
  const [runLines, setRunLines] = useState<PayrollLine[]>([]);
  const [runLinesLoading, setRunLinesLoading] = useState(false);

  // ─── Advances State ───
  const [advances, setAdvances] = useState<PayrollAdvance[]>([]);
  const [advLoading, setAdvLoading] = useState(true);

  // ─── Commissions State ───
  const [commissions, setCommissions] = useState<PayrollCommission[]>([]);
  const [commLoading, setCommLoading] = useState(true);

  // ─── Dialog States ───
  const [showEmpForm, setShowEmpForm] = useState(false);
  const [editingEmp, setEditingEmp] = useState<PayrollEmployee | null>(null);
  const [showCompForm, setShowCompForm] = useState(false);
  const [compEmployeeId, setCompEmployeeId] = useState<string>("");
  const [showRunDialog, setShowRunDialog] = useState(false);
  const [showAdvanceDialog, setShowAdvanceDialog] = useState(false);
  const [showCommDialog, setShowCommDialog] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ type: string; id: string; name: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  // ─── Run creation form ───
  const [runForm, setRunForm] = useState({
    month: String(new Date().getMonth() + 1),
    year: String(new Date().getFullYear()),
  });

  // ─── Advance form ───
  const [advForm, setAdvForm] = useState({
    employee_id: "",
    amount: "",
    purpose: "",
    monthly_deduction: "",
    start_deduction_month: "",
  });

  // ─── Commission form ───
  const [commForm, setCommForm] = useState({
    employee_id: "",
    commission_type: "PERFORMANCE_BASED",
    base_amount: "",
    commission_rate: "",
    commission_amount: "",
    period_month: "",
    description: "",
  });

  // ─── Projects for dropdowns ───
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);

  // ==========================================
  // FETCH FUNCTIONS
  // ==========================================

  const fetchProjects = useCallback(async () => {
    const { data } = await supabase.from("projects").select("id, name");
    setProjects(data || []);
  }, []);

  // ─── Employees ───
  const fetchEmployees = useCallback(async () => {
    setEmpLoading(true);
    let query = supabase
      .from("payroll_employees")
      .select("*")
      .order("created_at", { ascending: false });
    if (empSearch) {
      query = query.or(`name.ilike.%${empSearch}%,employee_code.ilike.%${empSearch}%,designation.ilike.%${empSearch}%,department.ilike.%${empSearch}%`);
    }
    const { data, error } = await query;
    if (error) toast.error("Failed to load employees: " + error.message);
    else setEmployees(data || []);
    setEmpLoading(false);
  }, [empSearch, refreshKey]);

  // ─── Payroll Runs ───
  const fetchRuns = useCallback(async () => {
    setRunsLoading(true);
    const { data, error } = await supabase
      .from("payroll_runs")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) toast.error("Failed to load payroll runs: " + error.message);
    else setRuns(data || []);
    setRunsLoading(false);
  }, [refreshKey]);

  // ─── Advances ───
  const fetchAdvances = useCallback(async () => {
    setAdvLoading(true);
    const { data, error } = await supabase
      .from("payroll_advances")
      .select("*, payroll_employees(id, name, employee_code, department)")
      .order("request_date", { ascending: false });
    if (error) toast.error("Failed to load advances: " + error.message);
    else setAdvances(data || []);
    setAdvLoading(false);
  }, [refreshKey]);

  // ─── Commissions ───
  const fetchCommissions = useCallback(async () => {
    setCommLoading(true);
    const { data, error } = await supabase
      .from("payroll_commissions")
      .select("*, payroll_employees(id, name, employee_code, department)")
      .order("created_at", { ascending: false });
    if (error) toast.error("Failed to load commissions: " + error.message);
    else setCommissions(data || []);
    setCommLoading(false);
  }, [refreshKey]);

  // ─── Effects ───
  useEffect(() => { fetchProjects(); }, [fetchProjects]);
  useEffect(() => { if (activeTab === "employees") fetchEmployees(); }, [fetchEmployees, activeTab]);
  useEffect(() => { if (activeTab === "runs") fetchRuns(); }, [fetchRuns, activeTab]);
  useEffect(() => { if (activeTab === "advances") fetchAdvances(); }, [fetchAdvances, activeTab]);
  useEffect(() => { if (activeTab === "commissions") fetchCommissions(); }, [fetchCommissions, activeTab]);

  // ==========================================
  // EMPLOYEE CRUD
  // ==========================================
  async function handleEmployeeSubmit(formData: EmployeeFormData) {
    try {
      let error;
      if (editingEmp) {
        const res = await supabase.from("payroll_employees").update(formData).eq("id", editingEmp.id);
        error = res.error;
      } else {
        // Auto-generate employee code
        const { data: codeData } = await supabase.rpc("payroll_generate_employee_code");
        const employeeCode = codeData || `EMP-${Date.now().toString().slice(-4)}`;
        const res = await supabase.from("payroll_employees").insert({
          ...formData,
          employee_code: employeeCode,
          status: "ACTIVE",
          created_by: user?.id,
        });
        error = res.error;
      }
      if (error) {
        toast.error("Failed: " + error.message);
      } else {
        toast.success(editingEmp ? "Employee updated" : "Employee created");
        await logAction(editingEmp ? "PAYROLL_EMPLOYEE_UPDATE" : "PAYROLL_EMPLOYEE_CREATE", { target: formData.name });
        setShowEmpForm(false);
        setEditingEmp(null);
        fetchEmployees();
      }
    } catch (err: any) {
      toast.error("Error: " + (err.message || "Unknown"));
    }
  }

  async function handleTerminateEmployee(emp: PayrollEmployee) {
    if (!confirm(`Terminate ${emp.name}? This will mark them as inactive.`)) return;
    const { error } = await supabase.from("payroll_employees").update({ status: "TERMINATED" }).eq("id", emp.id);
    if (error) { toast.error("Failed: " + error.message); return; }
    toast.success(`${emp.name} terminated`);
    await logAction("PAYROLL_EMPLOYEE_TERMINATE", { target: emp.name });
    fetchEmployees();
  }

  // ==========================================
  // COMPENSATION CRUD
  // ==========================================
  async function handleCompensationSubmit(formData: CompensationFormData) {
    if (!formData.employee_id || !formData.amount) {
      toast.error("Employee and amount are required");
      return;
    }
    setSubmitting(true);
    try {
      // Deactivate old compensation for this employee
      await supabase.from("payroll_compensation").update({ is_active: false }).eq("employee_id", formData.employee_id).eq("is_active", true);
      // Insert new active compensation
      const { error } = await supabase.from("payroll_compensation").insert({
        employee_id: formData.employee_id,
        compensation_type: formData.compensation_type,
        amount: parseFloat(formData.amount),
        effective_from: formData.effective_from || new Date().toISOString().split("T")[0],
        effective_to: formData.effective_to || null,
        is_active: true,
        project_id: formData.project_id || null,
        notes: formData.notes || null,
        created_by: user?.id,
      });
      if (error) { toast.error("Failed: " + error.message); }
      else {
        toast.success("Compensation updated");
        await logAction("PAYROLL_COMPENSATION_UPDATE", { target: formData.employee_id });
        setShowCompForm(false);
        fetchEmployees();
      }
    } catch (err: any) {
      toast.error("Error: " + (err.message || "Unknown"));
    } finally {
      setSubmitting(false);
    }
  }

  // ==========================================
  // PAYROLL RUN
  // ==========================================
  async function handleCreateRun() {
    const month = parseInt(runForm.month);
    const year = parseInt(runForm.year);
    const lastDay = getLastDayOfMonth(month, year);
    const periodStart = `${year}-${String(month).padStart(2, "0")}-01`;
    const periodEnd = `${year}-${String(month).padStart(2, "0")}-${lastDay}`;
    const payrollPeriod = `${year}-${String(month).padStart(2, "0")}`;

    setSubmitting(true);
    try {
      const res = await fetch("/api/payroll/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ period_start: periodStart, period_end: periodEnd, payroll_period: payrollPeriod }),
      });
      const result = await res.json();
      if (res.ok) {
        toast.success(result.message || "Payroll run created and calculated");
        await logAction("PAYROLL_RUN_CREATE", { target: payrollPeriod });
        setShowRunDialog(false);
        setRefreshKey((k) => k + 1);
      } else {
        toast.error(result.error || "Failed to create payroll run");
      }
    } catch (err: any) {
      toast.error("Error: " + (err.message || "Network error"));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRunAction(run: PayrollRun, action: string) {
    if (action === "view") {
      setSelectedRun(run);
      setRunLinesLoading(true);
      const { data } = await supabase.from("payroll_lines").select("*").eq("payroll_run_id", run.id);
      setRunLines(data || []);
      setRunLinesLoading(false);
      return;
    }
    if (action === "post") {
      setSubmitting(true);
      try {
        const res = await fetch(`/api/payroll/runs`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ runId: run.id, action: "post" }),
        });
        const result = await res.json();
        if (res.ok) {
          toast.success(result.message || "Payroll posted to General Ledger");
          await logAction("PAYROLL_RUN_POST", { target: run.payroll_period });
          fetchRuns();
        } else {
          toast.error(result.error || "Posting failed");
        }
      } catch (err: any) {
        toast.error("Error: " + (err.message || "Unknown"));
      } finally {
        setSubmitting(false);
      }
      return;
    }
    if (action === "approve" && canApprove) {
      const { error } = await supabase.from("payroll_runs").update({
        status: "APPROVED",
        approved_by: user?.id,
        approved_at: new Date().toISOString(),
      }).eq("id", run.id);
      if (error) { toast.error("Failed: " + error.message); return; }
      toast.success("Payroll run approved");
      await logAction("PAYROLL_RUN_APPROVE", { target: run.payroll_period });
      fetchRuns();
      return;
    }
    if (action === "cancel") {
      if (!confirm("Cancel this payroll run?")) return;
      const { error } = await supabase.from("payroll_runs").update({ status: "CANCELLED" }).eq("id", run.id);
      if (error) { toast.error("Failed: " + error.message); return; }
      toast.success("Payroll run cancelled");
      fetchRuns();
    }
  }

  // ==========================================
  // ADVANCES CRUD
  // ==========================================
  async function handleCreateAdvance() {
    if (!advForm.employee_id || !advForm.amount) {
      toast.error("Employee and amount are required");
      return;
    }
    setSubmitting(true);
    try {
      const { error } = await supabase.from("payroll_advances").insert({
        employee_id: advForm.employee_id,
        amount: parseFloat(advForm.amount),
        purpose: advForm.purpose || null,
        monthly_deduction: advForm.monthly_deduction ? parseFloat(advForm.monthly_deduction) : null,
        start_deduction_month: advForm.start_deduction_month || null,
        remaining_balance: parseFloat(advForm.amount),
        created_by: user?.id,
      });
      if (error) { toast.error("Failed: " + error.message); }
      else {
        toast.success("Advance created");
        await logAction("PAYROLL_ADVANCE_CREATE", { target: advForm.employee_id });
        setShowAdvanceDialog(false);
        setAdvForm({ employee_id: "", amount: "", purpose: "", monthly_deduction: "", start_deduction_month: "" });
        setRefreshKey((k) => k + 1);
      }
    } catch (err: any) {
      toast.error("Error: " + (err.message || "Unknown"));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleAdvanceAction(advance: PayrollAdvance, action: string) {
    if (action === "approve" && canApprove) {
      const { error } = await supabase.from("payroll_advances").update({
        approval_status: "APPROVED",
        approved_by: user?.id,
        approved_at: new Date().toISOString(),
      }).eq("id", advance.id);
      if (error) { toast.error("Failed: " + error.message); return; }
      toast.success("Advance approved");
      fetchAdvances();
      return;
    }
    if (action === "reject" && canApprove) {
      const { error } = await supabase.from("payroll_advances").update({
        approval_status: "REJECTED",
        approved_by: user?.id,
        approved_at: new Date().toISOString(),
      }).eq("id", advance.id);
      if (error) { toast.error("Failed: " + error.message); return; }
      toast.success("Advance rejected");
      fetchAdvances();
    }
  }

  // ==========================================
  // COMMISSIONS CRUD
  // ==========================================
  async function handleCreateCommission() {
    if (!commForm.employee_id || !commForm.commission_amount) {
      toast.error("Employee and commission amount are required");
      return;
    }
    setSubmitting(true);
    try {
      const { error } = await supabase.from("payroll_commissions").insert({
        employee_id: commForm.employee_id,
        commission_type: commForm.commission_type,
        base_amount: commForm.base_amount ? parseFloat(commForm.base_amount) : 0,
        commission_rate: commForm.commission_rate ? parseFloat(commForm.commission_rate) : 0,
        commission_amount: parseFloat(commForm.commission_amount),
        period_month: commForm.period_month || null,
        description: commForm.description || null,
        status: "PENDING",
        created_by: user?.id,
      });
      if (error) { toast.error("Failed: " + error.message); }
      else {
        toast.success("Commission created");
        await logAction("PAYROLL_COMMISSION_CREATE", { target: commForm.employee_id });
        setShowCommDialog(false);
        setCommForm({ employee_id: "", commission_type: "PERFORMANCE_BASED", base_amount: "", commission_rate: "", commission_amount: "", period_month: "", description: "" });
        setRefreshKey((k) => k + 1);
      }
    } catch (err: any) {
      toast.error("Error: " + (err.message || "Unknown"));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCommissionAction(commission: PayrollCommission, action: string) {
    if (action === "approve" && canApprove) {
      const { error } = await supabase.from("payroll_commissions").update({
        status: "APPROVED",
        approved_by: user?.id,
        approved_at: new Date().toISOString(),
      }).eq("id", commission.id);
      if (error) { toast.error("Failed: " + error.message); return; }
      toast.success("Commission approved");
      fetchCommissions();
      return;
    }
    if (action === "reject" && canApprove) {
      const { error } = await supabase.from("payroll_commissions").update({ status: "REJECTED" }).eq("id", commission.id);
      if (error) { toast.error("Failed: " + error.message); return; }
      toast.success("Commission rejected");
      fetchCommissions();
    }
  }

  // ==========================================
  // DELETE HANDLER
  // ==========================================
  async function confirmDelete() {
    if (!deleteTarget) return;
    const { error } = await supabase.from(`payroll_${deleteTarget.type}s` as any).delete().eq("id", deleteTarget.id);
    if (error) { toast.error("Delete failed: " + error.message); return; }
    toast.success(`${deleteTarget.name} deleted`);
    await logAction(`PAYROLL_${deleteTarget.type.toUpperCase()}_DELETE`, { target: deleteTarget.name });
    setShowDeleteModal(false);
    setDeleteTarget(null);
    setRefreshKey((k) => k + 1);
  }

  // ==========================================
  // PAGINATION HELPERS
  // ==========================================
  const empTotalPages = Math.ceil(employees.length / empPerPage);
  const empPaginated = employees.slice((empPage - 1) * empPerPage, empPage * empPerPage);
  const runTotalPages = Math.ceil(runs.length / runPerPage);
  const runPaginated = runs.slice((runPage - 1) * runPerPage, runPage * runPerPage);

  // Months / Years for form selects
  const months = Array.from({ length: 12 }, (_, i) => ({ value: String(i + 1), label: new Date(2024, i).toLocaleString("en", { month: "long" }) }));
  const years = [2024, 2025, 2026, 2027, 2028].map((y) => ({ value: String(y), label: String(y) }));

  // ==========================================
  // RENDER
  // ==========================================
  return (
    <div className="space-y-6">
      {/* ─── PAGE HEADER ─── */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Payroll Management</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            Manage employees, payroll runs, advances, and commissions
          </p>
        </div>
      </div>

      {/* ─── TAB NAVIGATION ─── */}
      <div className="flex flex-wrap gap-2 border-b border-gray-200 dark:border-gray-700 pb-2">
        {[
          { key: "employees" as const, label: "Employees", icon: Users },
          { key: "runs" as const, label: "Payroll Runs", icon: Calculator },
          { key: "advances" as const, label: "Advances", icon: Banknote },
          { key: "commissions" as const, label: "Commissions", icon: TrendingUp },
        ].map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-t-lg text-sm font-medium transition-colors
              ${activeTab === tab.key
                ? "bg-blue-600 text-white"
                : "text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
              }`}
          >
            <tab.icon className="w-4 h-4" />
            {tab.label}
          </button>
        ))}
      </div>

      {/* ================================================ */}
      {/* TAB 1: EMPLOYEES                                    */}
      {/* ================================================ */}
      {activeTab === "employees" && (
        <div className="space-y-4">
          {/* Toolbar */}
          <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center justify-between">
            <div className="relative flex-1 max-w-sm">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                type="text"
                placeholder="Search employees..."
                value={empSearch}
                onChange={(e) => { setEmpSearch(e.target.value); setEmpPage(1); }}
                className="w-full pl-9 pr-4 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
              />
            </div>
            {canAdd && (
              <button
                onClick={() => { setEditingEmp(null); setShowEmpForm(true); }}
                className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2.5 rounded-lg font-medium text-sm hover:bg-blue-700 transition-colors"
              >
                <Plus className="w-4 h-4" /> Add Employee
              </button>
            )}
          </div>

          {/* Employees Table */}
          <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 dark:bg-gray-900/50">
                  <tr>
                    <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">Code</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">Name</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400 hidden md:table-cell">Designation</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400 hidden lg:table-cell">Department</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">Type</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">Status</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                  {empLoading ? (
                    <tr><td colSpan={7} className="text-center py-8 text-gray-400">Loading...</td></tr>
                  ) : employees.length === 0 ? (
                    <tr><td colSpan={7} className="text-center py-8 text-gray-400">No employees found. Add your first employee.</td></tr>
                  ) : (
                    empPaginated.map((emp) => (
                      <tr key={emp.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors">
                        <td className="px-4 py-3 font-mono text-xs text-gray-600 dark:text-gray-400">{emp.employee_code}</td>
                        <td className="px-4 py-3 font-medium text-gray-900 dark:text-white">{emp.name}</td>
                        <td className="px-4 py-3 text-gray-600 dark:text-gray-400 hidden md:table-cell">{emp.designation || "—"}</td>
                        <td className="px-4 py-3 text-gray-600 dark:text-gray-400 hidden lg:table-cell">{emp.department || "—"}</td>
                        <td className="px-4 py-3">
                          <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${getEmploymentTypeBadge(emp.employment_type)}`}>
                            {emp.employment_type.replace(/_/g, " ")}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_STYLES[emp.status] || STATUS_STYLES.DRAFT}`}>
                            {emp.status}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1">
                            <button onClick={() => { setCompEmployeeId(emp.id); setShowCompForm(true); }}
                              className="p-1.5 text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded-lg transition-colors" title="Set Compensation">
                              <FileText className="w-4 h-4" />
                            </button>
                            <button onClick={() => { setEditingEmp(emp); setShowEmpForm(true); }}
                              className="p-1.5 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors" title="Edit">
                              <Edit2 className="w-4 h-4" />
                            </button>
                            {emp.status === "ACTIVE" && (
                              <button onClick={() => handleTerminateEmployee(emp)}
                                className="p-1.5 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition-colors" title="Terminate">
                                <X className="w-4 h-4" />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            {/* Pagination */}
            {empTotalPages > 1 && (
              <div className="flex items-center justify-between px-4 py-3 border-t border-gray-200 dark:border-gray-700">
                <span className="text-sm text-gray-500">Page {empPage} of {empTotalPages}</span>
                <div className="flex gap-1">
                  <button onClick={() => setEmpPage((p) => Math.max(1, p - 1))} disabled={empPage <= 1}
                    className="p-1.5 rounded-lg border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50">
                    <ChevronLeft className="w-4 h-4" />
                  </button>
                  <button onClick={() => setEmpPage((p) => Math.min(empTotalPages, p + 1))} disabled={empPage >= empTotalPages}
                    className="p-1.5 rounded-lg border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50">
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ================================================ */}
      {/* TAB 2: PAYROLL RUNS                                 */}
      {/* ================================================ */}
      {activeTab === "runs" && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-gray-500 dark:text-gray-400">Create and manage payroll runs</p>
            {canAdd && (
              <button onClick={() => setShowRunDialog(true)}
                className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2.5 rounded-lg font-medium text-sm hover:bg-blue-700 transition-colors">
                <Plus className="w-4 h-4" /> Create Payroll Run
              </button>
            )}
          </div>

          <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 dark:bg-gray-900/50">
                  <tr>
                    <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">Period</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">Status</th>
                    <th className="text-right px-4 py-3 font-medium text-gray-500 dark:text-gray-400">Total Gross</th>
                    <th className="text-right px-4 py-3 font-medium text-gray-500 dark:text-gray-400">Total Net</th>
                    <th className="text-center px-4 py-3 font-medium text-gray-500 dark:text-gray-400">Employees</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400 hidden md:table-cell">Created</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                  {runsLoading ? (
                    <tr><td colSpan={7} className="text-center py-8 text-gray-400">Loading...</td></tr>
                  ) : runs.length === 0 ? (
                    <tr><td colSpan={7} className="text-center py-8 text-gray-400">No payroll runs yet. Create your first run.</td></tr>
                  ) : (
                    runPaginated.map((run) => (
                      <tr key={run.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors">
                        <td className="px-4 py-3 font-medium text-gray-900 dark:text-white">{formatPeriod(run.payroll_period)}</td>
                        <td className="px-4 py-3">
                          <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_STYLES[run.status] || STATUS_STYLES.DRAFT}`}>
                            {run.status}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-gray-900 dark:text-white">{formatPKR(run.total_gross_pay)}</td>
                        <td className="px-4 py-3 text-right font-mono font-semibold text-gray-900 dark:text-white">{formatPKR(run.total_net_pay)}</td>
                        <td className="px-4 py-3 text-center text-gray-600 dark:text-gray-400">{run.total_employees}</td>
                        <td className="px-4 py-3 text-gray-500 dark:text-gray-400 text-xs hidden md:table-cell">{timeAgo(run.created_at)}</td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1">
                            <button onClick={() => handleRunAction(run, "view")}
                              className="p-1.5 text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded-lg transition-colors" title="View Details">
                              <Eye className="w-4 h-4" />
                            </button>
                            {run.status === "CALCULATED" && canApprove && (
                              <button onClick={() => handleRunAction(run, "approve")}
                                className="p-1.5 text-green-600 hover:bg-green-50 dark:hover:bg-green-900/20 rounded-lg transition-colors" title="Approve">
                                <Check className="w-4 h-4" />
                              </button>
                            )}
                            {run.status === "APPROVED" && canPost && (
                              <button onClick={() => handleRunAction(run, "post")} disabled={submitting}
                                className="p-1.5 text-purple-600 hover:bg-purple-50 dark:hover:bg-purple-900/20 rounded-lg transition-colors disabled:opacity-50" title="Post to GL">
                                {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Calculator className="w-4 h-4" />}
                              </button>
                            )}
                            {(run.status === "DRAFT" || run.status === "CALCULATED") && (
                              <button onClick={() => handleRunAction(run, "cancel")}
                                className="p-1.5 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition-colors" title="Cancel">
                                <X className="w-4 h-4" />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            {runTotalPages > 1 && (
              <div className="flex items-center justify-between px-4 py-3 border-t border-gray-200 dark:border-gray-700">
                <span className="text-sm text-gray-500">Page {runPage} of {runTotalPages}</span>
                <div className="flex gap-1">
                  <button onClick={() => setRunPage((p) => Math.max(1, p - 1))} disabled={runPage <= 1}
                    className="p-1.5 rounded-lg border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50">
                    <ChevronLeft className="w-4 h-4" />
                  </button>
                  <button onClick={() => setRunPage((p) => Math.min(runTotalPages, p + 1))} disabled={runPage >= runTotalPages}
                    className="p-1.5 rounded-lg border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50">
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ================================================ */}
      {/* TAB 3: ADVANCES                                    */}
      {/* ================================================ */}
      {activeTab === "advances" && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-gray-500 dark:text-gray-400">Track salary advances and recoveries</p>
            {canAdd && (
              <button onClick={() => setShowAdvanceDialog(true)}
                className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2.5 rounded-lg font-medium text-sm hover:bg-blue-700 transition-colors">
                <Plus className="w-4 h-4" /> New Advance
              </button>
            )}
          </div>

          <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 dark:bg-gray-900/50">
                  <tr>
                    <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">Employee</th>
                    <th className="text-right px-4 py-3 font-medium text-gray-500 dark:text-gray-400">Amount</th>
                    <th className="text-right px-4 py-3 font-medium text-gray-500 dark:text-gray-400">Remaining</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400 hidden md:table-cell">Purpose</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">Status</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                  {advLoading ? (
                    <tr><td colSpan={6} className="text-center py-8 text-gray-400">Loading...</td></tr>
                  ) : advances.length === 0 ? (
                    <tr><td colSpan={6} className="text-center py-8 text-gray-400">No advances found.</td></tr>
                  ) : (
                    advances.map((adv) => (
                      <tr key={adv.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors">
                        <td className="px-4 py-3">
                          <div className="font-medium text-gray-900 dark:text-white">{adv.payroll_employees?.name || "—"}</div>
                          <div className="text-xs text-gray-500">{adv.payroll_employees?.employee_code || ""}</div>
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-gray-900 dark:text-white">{formatPKR(adv.amount)}</td>
                        <td className="px-4 py-3 text-right font-mono text-gray-900 dark:text-white">{formatPKR(adv.remaining_balance)}</td>
                        <td className="px-4 py-3 text-gray-600 dark:text-gray-400 text-xs hidden md:table-cell max-w-[200px] truncate">{adv.purpose || "—"}</td>
                        <td className="px-4 py-3">
                          <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_STYLES[adv.approval_status] || STATUS_STYLES.PENDING}`}>
                            {adv.approval_status.replace(/_/g, " ")}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1">
                            {adv.approval_status === "PENDING" && canApprove && (
                              <>
                                <button onClick={() => handleAdvanceAction(adv, "approve")}
                                  className="p-1.5 text-green-600 hover:bg-green-50 dark:hover:bg-green-900/20 rounded-lg transition-colors" title="Approve">
                                  <Check className="w-4 h-4" />
                                </button>
                                <button onClick={() => handleAdvanceAction(adv, "reject")}
                                  className="p-1.5 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition-colors" title="Reject">
                                  <X className="w-4 h-4" />
                                </button>
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ================================================ */}
      {/* TAB 4: COMMISSIONS                                 */}
      {/* ================================================ */}
      {activeTab === "commissions" && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-gray-500 dark:text-gray-400">Manage performance and project-based commissions</p>
            {canAdd && (
              <button onClick={() => setShowCommDialog(true)}
                className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2.5 rounded-lg font-medium text-sm hover:bg-blue-700 transition-colors">
                <Plus className="w-4 h-4" /> New Commission
              </button>
            )}
          </div>

          <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 dark:bg-gray-900/50">
                  <tr>
                    <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">Employee</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">Type</th>
                    <th className="text-right px-4 py-3 font-medium text-gray-500 dark:text-gray-400">Base</th>
                    <th className="text-right px-4 py-3 font-medium text-gray-500 dark:text-gray-400">Rate</th>
                    <th className="text-right px-4 py-3 font-medium text-gray-500 dark:text-gray-400">Amount</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">Status</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                  {commLoading ? (
                    <tr><td colSpan={7} className="text-center py-8 text-gray-400">Loading...</td></tr>
                  ) : commissions.length === 0 ? (
                    <tr><td colSpan={7} className="text-center py-8 text-gray-400">No commissions found.</td></tr>
                  ) : (
                    commissions.map((comm) => (
                      <tr key={comm.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors">
                        <td className="px-4 py-3">
                          <div className="font-medium text-gray-900 dark:text-white">{comm.payroll_employees?.name || "—"}</div>
                          <div className="text-xs text-gray-500">{comm.payroll_employees?.employee_code || ""}</div>
                        </td>
                        <td className="px-4 py-3 text-gray-600 dark:text-gray-400">{comm.commission_type.replace(/_/g, " ")}</td>
                        <td className="px-4 py-3 text-right font-mono text-gray-900 dark:text-white">{formatPKR(comm.base_amount)}</td>
                        <td className="px-4 py-3 text-right text-gray-600 dark:text-gray-400">{(comm.commission_rate * 100).toFixed(1)}%</td>
                        <td className="px-4 py-3 text-right font-mono font-semibold text-gray-900 dark:text-white">{formatPKR(comm.commission_amount)}</td>
                        <td className="px-4 py-3">
                          <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_STYLES[comm.status] || STATUS_STYLES.PENDING}`}>
                            {comm.status}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1">
                            {comm.status === "PENDING" && canApprove && (
                              <>
                                <button onClick={() => handleCommissionAction(comm, "approve")}
                                  className="p-1.5 text-green-600 hover:bg-green-50 dark:hover:bg-green-900/20 rounded-lg transition-colors" title="Approve">
                                  <Check className="w-4 h-4" />
                                </button>
                                <button onClick={() => handleCommissionAction(comm, "reject")}
                                  className="p-1.5 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition-colors" title="Reject">
                                  <X className="w-4 h-4" />
                                </button>
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ================================================ */}
      {/* DIALOGS                                          */}
      {/* ================================================ */}

      {/* ─── EMPLOYEE FORM DIALOG ─── */}
      {showEmpForm && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={() => setShowEmpForm(false)}>
          <div className="bg-white dark:bg-gray-800 rounded-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between p-6 border-b border-gray-200 dark:border-gray-700">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
                {editingEmp ? "Edit Employee" : "Add New Employee"}
              </h2>
              <button onClick={() => setShowEmpForm(false)} className="p-1 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg">
                <X className="w-5 h-5 text-gray-500" />
              </button>
            </div>
            <EmployeeForm
              initialData={editingEmp ? {
                name: editingEmp.name,
                email: editingEmp.email || "",
                phone: editingEmp.phone || "",
                designation: editingEmp.designation || "",
                department: editingEmp.department || "",
                employment_type: editingEmp.employment_type,
                join_date: editingEmp.join_date || "",
                bank_name: editingEmp.bank_name || "",
                bank_account: editingEmp.bank_account || "",
                cnic: editingEmp.cnic || "",
                notes: editingEmp.notes || "",
              } : undefined}
              onSubmit={handleEmployeeSubmit}
              onCancel={() => { setShowEmpForm(false); setEditingEmp(null); }}
              submitting={submitting}
            />
          </div>
        </div>
      )}

      {/* ─── COMPENSATION FORM DIALOG ─── */}
      {showCompForm && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={() => setShowCompForm(false)}>
          <div className="bg-white dark:bg-gray-800 rounded-xl w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between p-6 border-b border-gray-200 dark:border-gray-700">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Set Compensation</h2>
              <button onClick={() => setShowCompForm(false)} className="p-1 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg">
                <X className="w-5 h-5 text-gray-500" />
              </button>
            </div>
            <CompensationForm
              employeeId={compEmployeeId}
              projects={projects}
              onSubmit={handleCompensationSubmit}
              onCancel={() => setShowCompForm(false)}
              submitting={submitting}
            />
          </div>
        </div>
      )}

      {/* ─── RUN CREATION DIALOG ─── */}
      {showRunDialog && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={() => setShowRunDialog(false)}>
          <div className="bg-white dark:bg-gray-800 rounded-xl w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between p-6 border-b border-gray-200 dark:border-gray-700">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Create Payroll Run</h2>
              <button onClick={() => setShowRunDialog(false)} className="p-1 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg">
                <X className="w-5 h-5 text-gray-500" />
              </button>
            </div>
            <div className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Month</label>
                <select
                  value={runForm.month} onChange={(e) => setRunForm({ ...runForm, month: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                >
                  {months.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Year</label>
                <select
                  value={runForm.year} onChange={(e) => setRunForm({ ...runForm, year: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                >
                  {years.map((y) => <option key={y.value} value={y.value}>{y.label}</option>)}
                </select>
              </div>
              <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg p-3 flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
                <p className="text-xs text-amber-700 dark:text-amber-400">
                  This will calculate payroll for all ACTIVE employees with active compensation. Make sure compensation is set correctly before running.
                </p>
              </div>
              <div className="flex gap-3 pt-2">
                <button onClick={() => setShowRunDialog(false)}
                  className="flex-1 px-4 py-2.5 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 text-sm font-medium hover:bg-gray-50 dark:hover:bg-gray-700">
                  Cancel
                </button>
                <button onClick={handleCreateRun} disabled={submitting}
                  className="flex-1 px-4 py-2.5 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2">
                  {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                  {submitting ? "Calculating..." : "Create & Calculate"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ─── RUN DETAIL DIALOG (Payslip View) ─── */}
      {selectedRun && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={() => { setSelectedRun(null); setRunLines([]); }}>
          <div className="bg-white dark:bg-gray-800 rounded-xl w-full max-w-5xl max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between p-6 border-b border-gray-200 dark:border-gray-700 sticky top-0 bg-white dark:bg-gray-800 z-10">
              <div>
                <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
                  Payroll Run — {formatPeriod(selectedRun.payroll_period)}
                </h2>
                <div className="flex items-center gap-3 mt-1">
                  <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_STYLES[selectedRun.status] || STATUS_STYLES.DRAFT}`}>
                    {selectedRun.status}
                  </span>
                  <span className="text-xs text-gray-500">{selectedRun.total_employees} employees</span>
                </div>
              </div>
              <button onClick={() => { setSelectedRun(null); setRunLines([]); }} className="p-1 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg">
                <X className="w-5 h-5 text-gray-500" />
              </button>
            </div>

            {/* Summary Cards */}
            <div className="grid grid-cols-3 gap-4 p-6">
              <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-4">
                <p className="text-xs text-blue-600 dark:text-blue-400 font-medium">Total Gross Pay</p>
                <p className="text-xl font-bold text-blue-900 dark:text-blue-100 mt-1">{formatPKR(selectedRun.total_gross_pay)}</p>
              </div>
              <div className="bg-red-50 dark:bg-red-900/20 rounded-lg p-4">
                <p className="text-xs text-red-600 dark:text-red-400 font-medium">Total Deductions</p>
                <p className="text-xl font-bold text-red-900 dark:text-red-100 mt-1">{formatPKR(selectedRun.total_deductions)}</p>
              </div>
              <div className="bg-green-50 dark:bg-green-900/20 rounded-lg p-4">
                <p className="text-xs text-green-600 dark:text-green-400 font-medium">Total Net Pay</p>
                <p className="text-xl font-bold text-green-900 dark:text-green-100 mt-1">{formatPKR(selectedRun.total_net_pay)}</p>
              </div>
            </div>

            {/* Lines Table */}
            <div className="px-6 pb-6">
              {runLinesLoading ? (
                <p className="text-center py-8 text-gray-400">Loading payslips...</p>
              ) : runLines.length === 0 ? (
                <p className="text-center py-8 text-gray-400">No payroll lines found for this run.</p>
              ) : (
                <div className="overflow-x-auto border border-gray-200 dark:border-gray-700 rounded-lg">
                  <table className="w-full text-xs">
                    <thead className="bg-gray-50 dark:bg-gray-900/50">
                      <tr>
                        <th className="text-left px-3 py-2 font-medium text-gray-500">Employee</th>
                        <th className="text-right px-3 py-2 font-medium text-gray-500">Basic</th>
                        <th className="text-right px-3 py-2 font-medium text-gray-500 hidden md:table-cell">Allows</th>
                        <th className="text-right px-3 py-2 font-medium text-gray-500">Gross</th>
                        <th className="text-right px-3 py-2 font-medium text-gray-500 hidden md:table-cell">Deductions</th>
                        <th className="text-right px-3 py-2 font-medium text-gray-500">Net Pay</th>
                        <th className="text-center px-3 py-2 font-medium text-gray-500">Payment</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                      {runLines.map((line) => (
                        <tr key={line.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/50">
                          <td className="px-3 py-2">
                            <div className="font-medium text-gray-900 dark:text-white">{line.employee_name || "—"}</div>
                            <div className="text-gray-500">{line.employee_code || ""}</div>
                          </td>
                          <td className="px-3 py-2 text-right font-mono">{formatPKR(line.basic_salary)}</td>
                          <td className="px-3 py-2 text-right font-mono hidden md:table-cell">{formatPKR(line.housing_allow + line.medical_allow + line.conveyance_allow + line.other_allowances + line.overtime_pay)}</td>
                          <td className="px-3 py-2 text-right font-mono font-medium">{formatPKR(line.gross_pay)}</td>
                          <td className="px-3 py-2 text-right font-mono text-red-600 hidden md:table-cell">{formatPKR(line.total_deductions)}</td>
                          <td className="px-3 py-2 text-right font-mono font-bold text-green-700 dark:text-green-400">{formatPKR(line.net_pay)}</td>
                          <td className="px-3 py-2 text-center">
                            <span className={`inline-flex px-1.5 py-0.5 rounded-full text-xs font-medium ${STATUS_STYLES[line.payment_status] || STATUS_STYLES.PENDING}`}>
                              {line.payment_status.replace(/_/g, " ")}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot className="bg-gray-50 dark:bg-gray-900/50 font-bold">
                      <tr>
                        <td className="px-3 py-2 text-gray-900 dark:text-white">TOTAL</td>
                        <td className="px-3 py-2 text-right font-mono text-gray-900 dark:text-white">{formatPKR(runLines.reduce((s, l) => s + l.basic_salary, 0))}</td>
                        <td className="px-3 py-2 text-right font-mono text-gray-900 dark:text-white hidden md:table-cell">{formatPKR(runLines.reduce((s, l) => s + l.housing_allow + l.medical_allow + l.conveyance_allow + l.other_allowances + l.overtime_pay, 0))}</td>
                        <td className="px-3 py-2 text-right font-mono text-gray-900 dark:text-white">{formatPKR(runLines.reduce((s, l) => s + l.gross_pay, 0))}</td>
                        <td className="px-3 py-2 text-right font-mono text-red-600 hidden md:table-cell">{formatPKR(runLines.reduce((s, l) => s + l.total_deductions, 0))}</td>
                        <td className="px-3 py-2 text-right font-mono text-green-700 dark:text-green-400">{formatPKR(runLines.reduce((s, l) => s + l.net_pay, 0))}</td>
                        <td></td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ─── ADVANCE FORM DIALOG ─── */}
      {showAdvanceDialog && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={() => setShowAdvanceDialog(false)}>
          <div className="bg-white dark:bg-gray-800 rounded-xl w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between p-6 border-b border-gray-200 dark:border-gray-700">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white">New Salary Advance</h2>
              <button onClick={() => setShowAdvanceDialog(false)} className="p-1 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg">
                <X className="w-5 h-5 text-gray-500" />
              </button>
            </div>
            <div className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Employee *</label>
                <select value={advForm.employee_id} onChange={(e) => setAdvForm({ ...advForm, employee_id: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-blue-500 outline-none">
                  <option value="">Select employee...</option>
                  {employees.filter((e) => e.status === "ACTIVE").map((e) => (
                    <option key={e.id} value={e.id}>{e.employee_code} — {e.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Amount (PKR) *</label>
                <input type="number" value={advForm.amount} onChange={(e) => setAdvForm({ ...advForm, amount: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                  placeholder="e.g. 50000" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Purpose</label>
                <input type="text" value={advForm.purpose} onChange={(e) => setAdvForm({ ...advForm, purpose: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                  placeholder="Reason for advance" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Monthly Deduction</label>
                  <input type="number" value={advForm.monthly_deduction} onChange={(e) => setAdvForm({ ...advForm, monthly_deduction: e.target.value })}
                    className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                    placeholder="e.g. 5000" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Start Month</label>
                  <input type="month" value={advForm.start_deduction_month} onChange={(e) => setAdvForm({ ...advForm, start_deduction_month: e.target.value })}
                    className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-blue-500 outline-none" />
                </div>
              </div>
              <div className="flex gap-3 pt-2">
                <button onClick={() => setShowAdvanceDialog(false)}
                  className="flex-1 px-4 py-2.5 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 text-sm font-medium hover:bg-gray-50 dark:hover:bg-gray-700">
                  Cancel
                </button>
                <button onClick={handleCreateAdvance} disabled={submitting}
                  className="flex-1 px-4 py-2.5 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2">
                  {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                  Create Advance
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ─── COMMISSION FORM DIALOG ─── */}
      {showCommDialog && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={() => setShowCommDialog(false)}>
          <div className="bg-white dark:bg-gray-800 rounded-xl w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between p-6 border-b border-gray-200 dark:border-gray-700">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white">New Commission</h2>
              <button onClick={() => setShowCommDialog(false)} className="p-1 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg">
                <X className="w-5 h-5 text-gray-500" />
              </button>
            </div>
            <div className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Employee *</label>
                <select value={commForm.employee_id} onChange={(e) => setCommForm({ ...commForm, employee_id: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-blue-500 outline-none">
                  <option value="">Select employee...</option>
                  {employees.filter((e) => e.status === "ACTIVE").map((e) => (
                    <option key={e.id} value={e.id}>{e.employee_code} — {e.name}</option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Commission Type</label>
                  <select value={commForm.commission_type} onChange={(e) => setCommForm({ ...commForm, commission_type: e.target.value })}
                    className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-blue-500 outline-none">
                    <option value="PERFORMANCE_BASED">Performance</option>
                    <option value="PROJECT_BASED">Project</option>
                    <option value="SALES_BASED">Sales</option>
                    <option value="REFERRAL">Referral</option>
                    <option value="OTHER">Other</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Period Month</label>
                  <input type="month" value={commForm.period_month} onChange={(e) => setCommForm({ ...commForm, period_month: e.target.value })}
                    className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-blue-500 outline-none" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Base Amount</label>
                  <input type="number" value={commForm.base_amount} onChange={(e) => setCommForm({ ...commForm, base_amount: e.target.value })}
                    className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                    placeholder="0" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Rate (%)</label>
                  <input type="number" step="0.01" value={commForm.commission_rate} onChange={(e) => setCommForm({ ...commForm, commission_rate: e.target.value })}
                    className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                    placeholder="e.g. 10" />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Commission Amount (PKR) *</label>
                <input type="number" value={commForm.commission_amount} onChange={(e) => setCommForm({ ...commForm, commission_amount: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                  placeholder="Final amount" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Description</label>
                <textarea value={commForm.description} onChange={(e) => setCommForm({ ...commForm, description: e.target.value })} rows={2}
                  className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-blue-500 outline-none resize-none"
                  placeholder="Optional details..." />
              </div>
              <div className="flex gap-3 pt-2">
                <button onClick={() => setShowCommDialog(false)}
                  className="flex-1 px-4 py-2.5 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 text-sm font-medium hover:bg-gray-50 dark:hover:bg-gray-700">
                  Cancel
                </button>
                <button onClick={handleCreateCommission} disabled={submitting}
                  className="flex-1 px-4 py-2.5 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2">
                  {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                  Create Commission
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ─── DELETE CONFIRMATION DIALOG ─── */}
      {showDeleteModal && deleteTarget && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={() => setShowDeleteModal(false)}>
          <div className="bg-white dark:bg-gray-800 rounded-xl w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <div className="p-6 text-center">
              <div className="mx-auto w-12 h-12 rounded-full bg-red-100 dark:bg-red-900/30 flex items-center justify-center mb-4">
                <AlertTriangle className="w-6 h-6 text-red-600" />
              </div>
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Delete {deleteTarget.type}?</h3>
              <p className="text-sm text-gray-500 mt-2">Are you sure you want to delete &quot;{deleteTarget.name}&quot;? This action cannot be undone.</p>
              <div className="flex gap-3 mt-6">
                <button onClick={() => setShowDeleteModal(false)}
                  className="flex-1 px-4 py-2.5 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 text-sm font-medium hover:bg-gray-50 dark:hover:bg-gray-700">
                  Cancel
                </button>
                <button onClick={confirmDelete}
                  className="flex-1 px-4 py-2.5 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-700">
                  Delete
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ==========================================
// INLINE SUB-COMPONENTS (P0 Convention — same file)
// ==========================================

// ─── Employee Form ───
function EmployeeForm({
  initialData,
  onSubmit,
  onCancel,
  submitting,
}: {
  initialData?: EmployeeFormData;
  onSubmit: (data: EmployeeFormData) => void;
  onCancel: () => void;
  submitting: boolean;
}) {
  const [form, setForm] = useState<EmployeeFormData>(
    initialData || {
      name: "", email: "", phone: "", designation: "", department: "",
      employment_type: "FULL_TIME", join_date: "", bank_name: "", bank_account: "", cnic: "", notes: "",
    }
  );

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) { toast.error("Name is required"); return; }
    onSubmit(form);
  }

  return (
    <form onSubmit={handleSubmit} className="p-6 space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div className="col-span-2">
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Full Name *</label>
          <input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required
            className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-blue-500 outline-none" />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Email</label>
          <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })}
            className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-blue-500 outline-none" />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Phone</label>
          <input type="text" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })}
            className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-blue-500 outline-none" />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Designation</label>
          <input type="text" value={form.designation} onChange={(e) => setForm({ ...form, designation: e.target.value })}
            className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-blue-500 outline-none" />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Department</label>
          <input type="text" value={form.department} onChange={(e) => setForm({ ...form, department: e.target.value })}
            className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-blue-500 outline-none" />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Employment Type *</label>
          <select value={form.employment_type} onChange={(e) => setForm({ ...form, employment_type: e.target.value })}
            className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-blue-500 outline-none">
            {EMPLOYMENT_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Join Date</label>
          <input type="date" value={form.join_date} onChange={(e) => setForm({ ...form, join_date: e.target.value })}
            className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-blue-500 outline-none" />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">CNIC</label>
          <input type="text" value={form.cnic} onChange={(e) => setForm({ ...form, cnic: e.target.value })}
            className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-blue-500 outline-none"
            placeholder="00000-0000000-0" />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Bank Name</label>
          <input type="text" value={form.bank_name} onChange={(e) => setForm({ ...form, bank_name: e.target.value })}
            className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-blue-500 outline-none" />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Bank Account</label>
          <input type="text" value={form.bank_account} onChange={(e) => setForm({ ...form, bank_account: e.target.value })}
            className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-blue-500 outline-none" />
        </div>
      </div>
      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Notes</label>
        <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows={2}
          className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-blue-500 outline-none resize-none" />
      </div>
      <div className="flex gap-3 pt-2">
        <button type="button" onClick={onCancel}
          className="flex-1 px-4 py-2.5 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 text-sm font-medium hover:bg-gray-50 dark:hover:bg-gray-700">
          Cancel
        </button>
        <button type="submit" disabled={submitting}
          className="flex-1 px-4 py-2.5 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2">
          {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
          {initialData ? "Update Employee" : "Create Employee"}
        </button>
      </div>
    </form>
  );
}

// ─── Compensation Form ───
function CompensationForm({
  employeeId,
  projects,
  onSubmit,
  onCancel,
  submitting,
}: {
  employeeId: string;
  projects: { id: string; name: string }[];
  onSubmit: (data: CompensationFormData) => void;
  onCancel: () => void;
  submitting: boolean;
}) {
  const [form, setForm] = useState<CompensationFormData>({
    employee_id: employeeId,
    compensation_type: "MONTHLY_SALARY",
    amount: "",
    effective_from: new Date().toISOString().split("T")[0],
    effective_to: "",
    project_id: "",
    notes: "",
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    onSubmit(form);
  }

  return (
    <form onSubmit={handleSubmit} className="p-6 space-y-4">
      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Compensation Type</label>
        <select value={form.compensation_type} onChange={(e) => setForm({ ...form, compensation_type: e.target.value })}
          className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-blue-500 outline-none">
          {COMPENSATION_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
      </div>
      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Amount (PKR) *</label>
        <input type="number" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} required
          className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-blue-500 outline-none"
          placeholder="e.g. 150000" />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Effective From</label>
          <input type="date" value={form.effective_from} onChange={(e) => setForm({ ...form, effective_from: e.target.value })}
            className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-blue-500 outline-none" />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Effective To</label>
          <input type="date" value={form.effective_to} onChange={(e) => setForm({ ...form, effective_to: e.target.value })}
            className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-blue-500 outline-none" />
        </div>
      </div>
      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Project (Optional)</label>
        <select value={form.project_id} onChange={(e) => setForm({ ...form, project_id: e.target.value })}
          className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-blue-500 outline-none">
          <option value="">No project allocation</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>
      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Notes</label>
        <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows={2}
          className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-blue-500 outline-none resize-none" />
      </div>
      <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-3">
        <p className="text-xs text-blue-700 dark:text-blue-400">
          Setting new compensation will deactivate the previous active record. Old compensation history is preserved.
        </p>
      </div>
      <div className="flex gap-3 pt-2">
        <button type="button" onClick={onCancel}
          className="flex-1 px-4 py-2.5 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 text-sm font-medium hover:bg-gray-50 dark:hover:bg-gray-700">
          Cancel
        </button>
        <button type="submit" disabled={submitting}
          className="flex-1 px-4 py-2.5 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2">
          {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
          Save Compensation
        </button>
      </div>
    </form>
  );
}
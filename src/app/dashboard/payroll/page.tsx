'use client';
// ================================================================
// OSYSTIC Finance Management System — Payroll Management Page (P1)
// ================================================================

import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/context/AuthContext";
import { usePermissions } from "@/context/PermissionContext";
import { logAudit } from "@/lib/logAction";
import { usePayrollEmployees, usePayrollRuns, usePayrollLines, usePayrollAdvances, usePayrollCommissions,
         useCreatePayrollEmployee, useUpdatePayrollEmployee, useSetCompensation,} from "@/hooks/usePayroll";
import type { PayrollEmployee, PayrollRun, PayrollLine, PayrollAdvance, PayrollCommission, EmployeeFormData,
              CompensationFormData, } from "@/types/payroll.types";
import { formatPKR, formatDate, formatPeriod, timeAgo, getEmploymentTypeBadge, getLastDayOfMonth, } from "@/lib/helpers";
import { Plus, Search, Eye, Edit2, ChevronLeft, ChevronRight, Users, Calculator, Banknote, TrendingUp, FileText, X,
         Check, AlertTriangle, Loader2, Receipt, } from "lucide-react";
import toast from "react-hot-toast";
import { supabase } from "@/lib/supabase";

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

// COMMISSION TYPES
const COMMISSION_TYPES = [
  { value: "PERFORMANCE_BASED", label: "Performance" },
  { value: "PROJECT_BASED", label: "Project" },
  { value: "SALES_BASED", label: "Sales" },
  { value: "REFERRAL", label: "Referral" },
  { value: "OTHER", label: "Other" },
];

// REIMBURSEMENT CATEGORIES
const REIMBURSEMENT_CATEGORIES = [
  { value: "TRAVEL", label: "Travel" },
  { value: "MEAL", label: "Meal" },
  { value: "MEDICAL", label: "Medical" },
  { value: "EQUIPMENT", label: "Equipment" },
  { value: "INTERNET", label: "Internet" },
  { value: "OTHER", label: "Other" },
];

// ==========================================
// MAIN COMPONENT
// ==========================================
export default function PayrollPage() {
  const { user, profile } = useAuth();
  const { hasPermission } = usePermissions();
  const canAdd = hasPermission("PAYROLL_CREATE");
  const canUpdate = hasPermission("PAYROLL_UPDATE");
  const canApprove = hasPermission("PAYROLL_APPROVE");
  const canPost = hasPermission("PAYROLL_POST");
  const canDelete = hasPermission("PAYROLL_DELETE");
  const canAdvanceAdd = hasPermission("PAYROLL_ADVANCE_CREATE");
  const canAdvanceApprove = hasPermission("PAYROLL_ADVANCE_APPROVE");
  const canCommAdd = hasPermission("PAYROLL_COMMISSION_CREATE");
  const canCommApprove = hasPermission("PAYROLL_COMMISSION_APPROVE");
  const canReimbAdd = hasPermission("PAYROLL_REIMBURSEMENT_CREATE");
  const canReimbApprove = hasPermission("PAYROLL_REIMBURSEMENT_APPROVE");

  // ─── Tab State ───
  const [activeTab, setActiveTab] = useState<
    "employees" | "runs" | "advances" | "commissions" | "reimbursements"
  >("employees");

  // ─── Search State ───
  const [empSearch, setEmpSearch] = useState("");
  const [empPage, setEmpPage] = useState(1);
  const empPerPage = 10;

  // ─── Runs pagination ───
  const [runPage, setRunPage] = useState(1);
  const runPerPage = 10;

  // ─── Run detail view ───
  const [selectedRun, setSelectedRun] = useState<PayrollRun | null>(null);

  // ─── Dialog States ───
  const [showEmpForm, setShowEmpForm] = useState(false);
  const [editingEmp, setEditingEmp] = useState<PayrollEmployee | null>(null);
  const [showCompForm, setShowCompForm] = useState(false);
  const [compEmployeeId, setCompEmployeeId] = useState<string>("");
  const [showRunDialog, setShowRunDialog] = useState(false);
  const [showAdvanceDialog, setShowAdvanceDialog] = useState(false);
  const [showCommDialog, setShowCommDialog] = useState(false);
  const [showReimbDialog, setShowReimbDialog] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{
    type: string;
    id: string;
    name: string;
  } | null>(null);

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

  // ─── Reimbursement form ───
  const [reimbForm, setReimbForm] = useState({
    employee_id: "",
    amount: "",
    category: "OTHER",
    description: "",
    receipt_ref: "",
    expense_date: new Date().toISOString().split("T")[0],
  });

  // ─── Projects for dropdowns ───
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);

  // ─── Reimbursements state (local since no hook yet) ───
  const [reimbursements, setReimbursements] = useState<any[]>([]);
  const [reimbLoading, setReimbLoading] = useState(false);

  // ==========================================
  // REACT QUERY HOOKS
  // ==========================================

  const {
    data: employees = [],
    isLoading: empLoading,
    refetch: refetchEmployees,
  } = usePayrollEmployees(empSearch || undefined);

  const {
    data: runs = [],
    isLoading: runsLoading,
    refetch: refetchRuns,
  } = usePayrollRuns();

  const {
    data: runLines = [],
    isLoading: runLinesLoading,
  } = usePayrollLines(selectedRun?.id || null);

  const {
    data: advances = [],
    isLoading: advLoading,
    refetch: refetchAdvances,
  } = usePayrollAdvances();

  const {
    data: commissions = [],
    isLoading: commLoading,
    refetch: refetchCommissions,
  } = usePayrollCommissions();

  // ─── Mutations ───
  const createEmployeeMut = useCreatePayrollEmployee();
  const updateEmployeeMut = useUpdatePayrollEmployee();
  const setCompensationMut = useSetCompensation();

  // ==========================================
  // LOCAL FETCHES (for items without hooks)
  // ==========================================

  const fetchProjects = useCallback(async () => {
    const { data } = await supabase
      .from("projects")
      .select("id, name")
      .order("name");
    setProjects(data || []);
  }, []);

  const fetchReimbursements = useCallback(async () => {
    setReimbLoading(true);
    const { data, error } = await supabase
      .from("payroll_reimbursements")
      .select("*, payroll_employees(id, name, employee_code, department)")
      .order("expense_date", { ascending: false });
    if (error) {
      toast.error("Failed to load reimbursements: " + error.message);
    } else {
      setReimbursements(data || []);
    }
    setReimbLoading(false);
  }, []);

  // AUD-P2-017: side effects belong in useEffect, not useState initializers.
  useEffect(() => {
    fetchProjects();
  }, [fetchProjects]);

  useEffect(() => {
    if (activeTab === "reimbursements") {
      fetchReimbursements();
    }
  }, [activeTab, fetchReimbursements]);

  // ==========================================
  // EMPLOYEE CRUD
  // ==========================================
  async function handleEmployeeSubmit(formData: EmployeeFormData) {
    try {
      if (editingEmp) {
        await updateEmployeeMut.mutateAsync({
          id: editingEmp.id,
          updates: formData,
        });
        await logAudit.update(
          "payroll_employees",
          editingEmp.id,
          `Updated employee: ${formData.name}`
        );
        toast.success("Employee updated");
      } else {
        await createEmployeeMut.mutateAsync({
          ...formData,
          created_by: user?.id,
        });
        await logAudit.create(
          "payroll_employees",
          "",
          `Created employee: ${formData.name}`
        );
        toast.success("Employee created");
      }
      setShowEmpForm(false);
      setEditingEmp(null);
    } catch (err: any) {
      toast.error("Error: " + (err.message || "Unknown error"));
    }
  }

  async function handleTerminateEmployee(emp: PayrollEmployee) {
    if (!confirm(`Terminate ${emp.name}? This will mark them as inactive.`))
      return;
    try {
      const { error } = await supabase
        .from("payroll_employees")
        .update({ status: "TERMINATED" })
        .eq("id", emp.id);
      if (error) throw error;
      toast.success(`${emp.name} terminated`);
      await logAudit.update(
        "payroll_employees",
        emp.id,
        `Terminated employee: ${emp.name}`
      );
      refetchEmployees();
    } catch (err: any) {
      toast.error("Failed: " + (err.message || "Unknown"));
    }
  }

  // ==========================================
  // COMPENSATION
  // ==========================================
  async function handleCompensationSubmit(formData: CompensationFormData) {
    if (!formData.employee_id || !formData.amount) {
      toast.error("Employee and amount are required");
      return;
    }
    try {
      await setCompensationMut.mutateAsync({
        employeeId: formData.employee_id,
        compData: {
          compensation_type: formData.compensation_type,
          amount: parseFloat(formData.amount),
          effective_from: formData.effective_from || new Date().toISOString().split("T")[0],
          effective_to: formData.effective_to || null,
          project_id: formData.project_id || null,
          notes: formData.notes || null,
          created_by: user?.id,
        },
      });
      await logAudit.update(
        "payroll_compensation",
        formData.employee_id,
        "Updated compensation"
      );
      toast.success("Compensation updated");
      setShowCompForm(false);
      refetchEmployees();
    } catch (err: any) {
      toast.error("Error: " + (err.message || "Unknown"));
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

    try {
      const res = await fetch("/api/payroll/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          period_start: periodStart,
          period_end: periodEnd,
          payroll_period: payrollPeriod,
        }),
      });
      const result = await res.json();
      if (res.ok) {
        toast.success(result.message || "Payroll run created");
        await logAudit.create(
          "payroll_runs",
          "",
          `Created payroll run for period: ${payrollPeriod}`
        );
        setShowRunDialog(false);
        refetchRuns();
      } else {
        toast.error(result.error || "Failed to create payroll run");
      }
    } catch (err: any) {
      toast.error("Error: " + (err.message || "Network error"));
    }
  }

  async function handleRunAction(run: PayrollRun, action: string) {
    if (action === "view") {
      setSelectedRun(run);
      return;
    }

    if (action === "post") {
      try {
        // P0-11 FIX: PUT /api/payroll/runs is the plain status-update route
        // and explicitly refuses posting (see src/app/api/payroll/runs/route.ts
        // PUT handler: "Use /api/finance/payroll for posting..."). Posting
        // needs an accounting period + control accounts resolved and a GL
        // journal created — that logic only exists in the dedicated
        // POST /api/finance/payroll route (action: 'post'), so call that
        // instead. Its body shape is { action, run_id }, not { runId, action }.
        const res = await fetch(`/api/finance/payroll`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "post", run_id: run.id }),
        });
        const result = await res.json();
        if (res.ok) {
          toast.success(result.message || "Payroll posted to General Ledger");
          await logAudit.update(
            "payroll_runs",
            run.id,
            `Posted payroll run: ${run.payroll_period}`
          );
          refetchRuns();
        } else {
          toast.error(result.error || "Posting failed");
        }
      } catch (err: any) {
        toast.error("Error: " + (err.message || "Unknown"));
      }
      return;
    }

    if (action === "approve" && canApprove) {
      try {
        const res = await fetch('/api/payroll/runs', { method:'PUT', headers:{'Content-Type':'application/json'}, credentials:'include', body:JSON.stringify({runId:run.id,action:'approve'}) });
        const result = await res.json().catch(()=>({}));
        if(!res.ok) throw new Error(result.error || 'Approval failed');
        toast.success(result.message || 'Payroll run approved');
        await logAudit.update('payroll_runs', run.id, `Approved payroll run: ${run.payroll_period}`);
        refetchRuns();
      } catch(err:any){ toast.error('Failed: '+(err.message||'Unknown')); }
      return;
    }

    if (action === "cancel") {
      if (!confirm("Cancel this payroll run?")) return;
      try {
        const res = await fetch('/api/payroll/runs', { method:'PUT', headers:{'Content-Type':'application/json'}, credentials:'include', body:JSON.stringify({runId:run.id,action:'cancel'}) });
        const result = await res.json().catch(()=>({}));
        if(!res.ok) throw new Error(result.error || 'Cancellation failed');
        toast.success(result.message || 'Payroll run cancelled');
        refetchRuns();
      } catch(err:any){ toast.error('Failed: '+(err.message||'Unknown')); }
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
    try {
      if (!profile?.organization_id) throw new Error("Organization context is required");
      const { error } = await supabase.from("payroll_advances").insert({
        employee_id: advForm.employee_id,
        amount: parseFloat(advForm.amount),
        purpose: advForm.purpose || null,
        monthly_deduction: advForm.monthly_deduction
          ? parseFloat(advForm.monthly_deduction)
          : null,
        start_deduction_month: advForm.start_deduction_month || null,
        remaining_balance: parseFloat(advForm.amount),
        created_by: user?.id,
        organization_id: profile.organization_id,
      });
      if (error) throw error;
      toast.success("Advance created");
      await logAudit.create(
        "payroll_advances",
        "",
        `Created advance for employee: ${advForm.employee_id}`
      );
      setShowAdvanceDialog(false);
      setAdvForm({
        employee_id: "",
        amount: "",
        purpose: "",
        monthly_deduction: "",
        start_deduction_month: "",
      });
      refetchAdvances();
    } catch (err: any) {
      toast.error("Error: " + (err.message || "Unknown"));
    }
  }

  async function handleAdvanceAction(advance: PayrollAdvance, action: string) {
    if ((action === 'approve' || action === 'reject') && canAdvanceApprove) {
      try {
        const res = await fetch(`/api/payroll/advances/${advance.id}`, { method:'PATCH', headers:{'Content-Type':'application/json'}, credentials:'include', body:JSON.stringify({action}) });
        const result = await res.json().catch(()=>({}));
        if(!res.ok) throw new Error(result.error || `Advance ${action} failed`);
        toast.success(result.message || `Advance ${action}d`);
        refetchAdvances();
      } catch(err:any){ toast.error('Failed: '+(err.message||'Unknown')); }
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
    try {
      if (!profile?.organization_id) throw new Error("Organization context is required");
      const { error } = await supabase.from("payroll_commissions").insert({
        employee_id: commForm.employee_id,
        commission_type: commForm.commission_type,
        base_amount: commForm.base_amount ? parseFloat(commForm.base_amount) : 0,
        commission_rate: commForm.commission_rate
          ? parseFloat(commForm.commission_rate)
          : 0,
        commission_amount: parseFloat(commForm.commission_amount),
        period_month: commForm.period_month || null,
        description: commForm.description || null,
        status: "PENDING",
        created_by: user?.id,
        organization_id: profile.organization_id,
      });
      if (error) throw error;
      toast.success("Commission created");
      await logAudit.create(
        "payroll_commissions",
        "",
        `Created commission for employee: ${commForm.employee_id}`
      );
      setShowCommDialog(false);
      setCommForm({
        employee_id: "",
        commission_type: "PERFORMANCE_BASED",
        base_amount: "",
        commission_rate: "",
        commission_amount: "",
        period_month: "",
        description: "",
      });
      refetchCommissions();
    } catch (err: any) {
      toast.error("Error: " + (err.message || "Unknown"));
    }
  }

  async function handleCommissionAction(commission: PayrollCommission, action: string) {
    if (action === "approve" && canCommApprove) {
      try {
        const { error } = await supabase
          .from("payroll_commissions")
          .update({
            status: "APPROVED",
            approved_by: user?.id,
            approved_at: new Date().toISOString(),
          })
          .eq("id", commission.id);
        if (error) throw error;
        toast.success("Commission approved");
        refetchCommissions();
      } catch (err: any) {
        toast.error("Failed: " + (err.message || "Unknown"));
      }
      return;
    }
    if (action === "reject" && canCommApprove) {
      try {
        const { error } = await supabase
          .from("payroll_commissions")
          .update({ status: "REJECTED" })
          .eq("id", commission.id);
        if (error) throw error;
        toast.success("Commission rejected");
        refetchCommissions();
      } catch (err: any) {
        toast.error("Failed: " + (err.message || "Unknown"));
      }
    }
  }

  // ==========================================
  // REIMBURSEMENTS CRUD
  // ==========================================
  async function handleCreateReimbursement() {
    if (!reimbForm.employee_id || !reimbForm.amount) {
      toast.error("Employee and amount are required");
      return;
    }
    try {
      if (!profile?.organization_id) throw new Error("Organization context is required");
      const { error } = await supabase.from("payroll_reimbursements").insert({
        employee_id: reimbForm.employee_id,
        amount: parseFloat(reimbForm.amount),
        category: reimbForm.category,
        description: reimbForm.description || null,
        receipt_ref: reimbForm.receipt_ref || null,
        expense_date: reimbForm.expense_date || new Date().toISOString().split("T")[0],
        status: "PENDING",
        created_by: user?.id,
        organization_id: profile.organization_id,
      });
      if (error) throw error;
      toast.success("Reimbursement submitted");
      await logAudit.create(
        "payroll_reimbursements",
        "",
        `Created reimbursement for employee: ${reimbForm.employee_id}`
      );
      setShowReimbDialog(false);
      setReimbForm({
        employee_id: "",
        amount: "",
        category: "OTHER",
        description: "",
        receipt_ref: "",
        expense_date: new Date().toISOString().split("T")[0],
      });
      fetchReimbursements();
    } catch (err: any) {
      toast.error("Error: " + (err.message || "Unknown"));
    }
  }

  async function handleReimbAction(reimb: any, action: string) {
    if (action === "approve" && canReimbApprove) {
      try {
        const { error } = await supabase
          .from("payroll_reimbursements")
          .update({
            status: "APPROVED",
            approved_by: user?.id,
            approved_at: new Date().toISOString(),
          })
          .eq("id", reimb.id);
        if (error) throw error;
        toast.success("Reimbursement approved");
        fetchReimbursements();
      } catch (err: any) {
        toast.error("Failed: " + (err.message || "Unknown"));
      }
      return;
    }
    if (action === "reject" && canReimbApprove) {
      try {
        const { error } = await supabase
          .from("payroll_reimbursements")
          .update({
            status: "REJECTED",
            approved_by: user?.id,
            approved_at: new Date().toISOString(),
          })
          .eq("id", reimb.id);
        if (error) throw error;
        toast.success("Reimbursement rejected");
        fetchReimbursements();
      } catch (err: any) {
        toast.error("Failed: " + (err.message || "Unknown"));
      }
    }
  }

  // ==========================================
  // DELETE HANDLER
  // ==========================================
  async function confirmDelete() {
    if (!deleteTarget) return;
    try {
      const tableName = `payroll_${deleteTarget.type}s`;
      const { error } = await supabase
        .from(tableName as any)
        .delete()
        .eq("id", deleteTarget.id);
      if (error) throw error;
      toast.success(`${deleteTarget.name} deleted`);
      await logAudit.delete(
        `payroll_${deleteTarget.type}s`,
        deleteTarget.id,
        `Deleted ${deleteTarget.type}: ${deleteTarget.name}`
      );
      setShowDeleteModal(false);
      setDeleteTarget(null);
      refetchEmployees();
      refetchRuns();
      refetchAdvances();
      refetchCommissions();
    } catch (err: any) {
      toast.error("Delete failed: " + (err.message || "Unknown"));
    }
  }

  // ==========================================
  // PAGINATION HELPERS
  // ==========================================
  const empTotalPages = Math.ceil(employees.length / empPerPage);
  const empPaginated = employees.slice(
    (empPage - 1) * empPerPage,
    empPage * empPerPage
  );
  const runTotalPages = Math.ceil(runs.length / runPerPage);
  const runPaginated = runs.slice(
    (runPage - 1) * runPerPage,
    runPage * runPerPage
  );

  // Months / Years for form selects
  const months = Array.from({ length: 12 }, (_, i) => ({
    value: String(i + 1),
    label: new Date(2024, i).toLocaleString("en", { month: "long" }),
  }));
  const years = [2024, 2025, 2026, 2027, 2028].map((y) => ({
    value: String(y),
    label: String(y),
  }));

  // Active employees for dropdowns
  const activeEmployees = employees.filter((e) => e.status === "ACTIVE");

  // ==========================================
  // RENDER
  // ==========================================
  return (
    <div className="space-y-6">
      {/* ─── PAGE HEADER ─── */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
            Payroll Management
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            Manage employees, payroll runs, advances, commissions, and
            reimbursements
          </p>
        </div>
      </div>

      {/* ─── TAB NAVIGATION ─── */}
      <div className="flex flex-wrap gap-2 border-b border-gray-200 dark:border-gray-700 pb-2">
        {[
          {
            key: "employees" as const,
            label: "Employees",
            icon: Users,
          },
          {
            key: "runs" as const,
            label: "Payroll Runs",
            icon: Calculator,
          },
          {
            key: "advances" as const,
            label: "Advances",
            icon: Banknote,
          },
          {
            key: "commissions" as const,
            label: "Commissions",
            icon: TrendingUp,
          },
          {
            key: "reimbursements" as const,
            label: "Reimbursements",
            icon: Receipt,
          },
        ].map((tab) => (
          <button
            key={tab.key}
            onClick={() => {
              setActiveTab(tab.key);
              if (tab.key === "reimbursements") {
                fetchReimbursements();
              }
            }}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-t-lg text-sm font-medium transition-colors ${
              activeTab === tab.key
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
      {/* TAB 1: EMPLOYEES */}
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
                onChange={(e) => {
                  setEmpSearch(e.target.value);
                  setEmpPage(1);
                }}
                className="w-full pl-9 pr-4 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
              />
            </div>
            {canAdd && (
              <button
                onClick={() => {
                  setEditingEmp(null);
                  setShowEmpForm(true);
                }}
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
                    <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">
                      Code
                    </th>
                    <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">
                      Name
                    </th>
                    <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400 hidden md:table-cell">
                      Designation
                    </th>
                    <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400 hidden lg:table-cell">
                      Department
                    </th>
                    <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">
                      Type
                    </th>
                    <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">
                      Status
                    </th>
                    <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                  {empLoading ? (
                    <tr>
                      <td
                        colSpan={7}
                        className="text-center py-8 text-gray-400"
                      >
                        <Loader2 className="w-5 h-5 animate-spin inline mr-2" />
                        Loading...
                      </td>
                    </tr>
                  ) : employees.length === 0 ? (
                    <tr>
                      <td
                        colSpan={7}
                        className="text-center py-8 text-gray-400"
                      >
                        No employees found. Add your first employee.
                      </td>
                    </tr>
                  ) : (
                    empPaginated.map((emp) => (
                      <tr
                        key={emp.id}
                        className="hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors"
                      >
                        <td className="px-4 py-3 font-mono text-xs text-gray-600 dark:text-gray-400">
                          {emp.employee_code}
                        </td>
                        <td className="px-4 py-3 font-medium text-gray-900 dark:text-white">
                          {emp.name}
                        </td>
                        <td className="px-4 py-3 text-gray-600 dark:text-gray-400 hidden md:table-cell">
                          {emp.designation || "—"}
                        </td>
                        <td className="px-4 py-3 text-gray-600 dark:text-gray-400 hidden lg:table-cell">
                          {emp.department || "—"}
                        </td>
                        <td className="px-4 py-3">
                          <span
                            className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${getEmploymentTypeBadge(emp.employment_type)}`}
                          >
                            {emp.employment_type.replace(/_/g, " ")}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <span
                            className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_STYLES[emp.status] || STATUS_STYLES.DRAFT}`}
                          >
                            {emp.status}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1">
                            <button
                              onClick={() => {
                                setCompEmployeeId(emp.id);
                                setShowCompForm(true);
                              }}
                              className="p-1.5 text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded-lg transition-colors"
                              title="Set Compensation"
                            >
                              <FileText className="w-4 h-4" />
                            </button>
                            {canUpdate && (
                              <button
                                onClick={() => {
                                  setEditingEmp(emp);
                                  setShowEmpForm(true);
                                }}
                                className="p-1.5 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
                                title="Edit"
                              >
                                <Edit2 className="w-4 h-4" />
                              </button>
                            )}
                            {emp.status === "ACTIVE" && canUpdate && (
                              <button
                                onClick={() => handleTerminateEmployee(emp)}
                                className="p-1.5 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition-colors"
                                title="Terminate"
                              >
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
                <span className="text-sm text-gray-500">
                  Page {empPage} of {empTotalPages}
                </span>
                <div className="flex gap-1">
                  <button
                    onClick={() => setEmpPage((p) => Math.max(1, p - 1))}
                    disabled={empPage <= 1}
                    className="p-1.5 rounded-lg border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
                  >
                    <ChevronLeft className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() =>
                      setEmpPage((p) => Math.min(empTotalPages, p + 1))
                    }
                    disabled={empPage >= empTotalPages}
                    className="p-1.5 rounded-lg border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
                  >
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ================================================ */}
      {/* TAB 2: PAYROLL RUNS */}
      {/* ================================================ */}
      {activeTab === "runs" && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Create and manage payroll runs
            </p>
            {canAdd && (
              <button
                onClick={() => setShowRunDialog(true)}
                className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2.5 rounded-lg font-medium text-sm hover:bg-blue-700 transition-colors"
              >
                <Plus className="w-4 h-4" /> Create Payroll Run
              </button>
            )}
          </div>

          <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 dark:bg-gray-900/50">
                  <tr>
                    <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">
                      Period
                    </th>
                    <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">
                      Status
                    </th>
                    <th className="text-right px-4 py-3 font-medium text-gray-500 dark:text-gray-400">
                      Total Gross
                    </th>
                    <th className="text-right px-4 py-3 font-medium text-gray-500 dark:text-gray-400">
                      Total Net
                    </th>
                    <th className="text-center px-4 py-3 font-medium text-gray-500 dark:text-gray-400">
                      Employees
                    </th>
                    <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400 hidden md:table-cell">
                      Created
                    </th>
                    <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                  {runsLoading ? (
                    <tr>
                      <td
                        colSpan={7}
                        className="text-center py-8 text-gray-400"
                      >
                        <Loader2 className="w-5 h-5 animate-spin inline mr-2" />
                        Loading...
                      </td>
                    </tr>
                  ) : runs.length === 0 ? (
                    <tr>
                      <td
                        colSpan={7}
                        className="text-center py-8 text-gray-400"
                      >
                        No payroll runs yet. Create your first run.
                      </td>
                    </tr>
                  ) : (
                    runPaginated.map((run) => (
                      <tr
                        key={run.id}
                        className="hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors"
                      >
                        <td className="px-4 py-3 font-medium text-gray-900 dark:text-white">
                          {formatPeriod(run.payroll_period)}
                        </td>
                        <td className="px-4 py-3">
                          <span
                            className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_STYLES[run.status] || STATUS_STYLES.DRAFT}`}
                          >
                            {run.status}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-gray-900 dark:text-white">
                          {formatPKR(run.total_gross_pay)}
                        </td>
                        <td className="px-4 py-3 text-right font-mono font-semibold text-gray-900 dark:text-white">
                          {formatPKR(run.total_net_pay)}
                        </td>
                        <td className="px-4 py-3 text-center text-gray-600 dark:text-gray-400">
                          {run.total_employees}
                        </td>
                        <td className="px-4 py-3 text-gray-500 dark:text-gray-400 text-xs hidden md:table-cell">
                          {timeAgo(run.created_at)}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1">
                            <button
                              onClick={() => handleRunAction(run, "view")}
                              className="p-1.5 text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded-lg transition-colors"
                              title="View Details"
                            >
                              <Eye className="w-4 h-4" />
                            </button>
                            {run.status === "CALCULATED" && canApprove && (
                              <button
                                onClick={() => handleRunAction(run, "approve")}
                                className="p-1.5 text-green-600 hover:bg-green-50 dark:hover:bg-green-900/20 rounded-lg transition-colors"
                                title="Approve"
                              >
                                <Check className="w-4 h-4" />
                              </button>
                            )}
                            {run.status === "APPROVED" && canPost && (
                              <button
                                onClick={() => handleRunAction(run, "post")}
                                className="p-1.5 text-purple-600 hover:bg-purple-50 dark:hover:bg-purple-900/20 rounded-lg transition-colors"
                                title="Post to GL"
                              >
                                <Calculator className="w-4 h-4" />
                              </button>
                            )}
                            {(run.status === "DRAFT" ||
                              run.status === "CALCULATED") && (
                              <button
                                onClick={() => handleRunAction(run, "cancel")}
                                className="p-1.5 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition-colors"
                                title="Cancel"
                              >
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
                <span className="text-sm text-gray-500">
                  Page {runPage} of {runTotalPages}
                </span>
                <div className="flex gap-1">
                  <button
                    onClick={() => setRunPage((p) => Math.max(1, p - 1))}
                    disabled={runPage <= 1}
                    className="p-1.5 rounded-lg border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
                  >
                    <ChevronLeft className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() =>
                      setRunPage((p) => Math.min(runTotalPages, p + 1))
                    }
                    disabled={runPage >= runTotalPages}
                    className="p-1.5 rounded-lg border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
                  >
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ================================================ */}
      {/* TAB 3: ADVANCES */}
      {/* ================================================ */}
      {activeTab === "advances" && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Track salary advances and recoveries
            </p>
            {canAdvanceAdd && (
              <button
                onClick={() => setShowAdvanceDialog(true)}
                className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2.5 rounded-lg font-medium text-sm hover:bg-blue-700 transition-colors"
              >
                <Plus className="w-4 h-4" /> New Advance
              </button>
            )}
          </div>

          <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 dark:bg-gray-900/50">
                  <tr>
                    <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">
                      Employee
                    </th>
                    <th className="text-right px-4 py-3 font-medium text-gray-500 dark:text-gray-400">
                      Amount
                    </th>
                    <th className="text-right px-4 py-3 font-medium text-gray-500 dark:text-gray-400">
                      Remaining
                    </th>
                    <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400 hidden md:table-cell">
                      Purpose
                    </th>
                    <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">
                      Status
                    </th>
                    <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                  {advLoading ? (
                    <tr>
                      <td
                        colSpan={6}
                        className="text-center py-8 text-gray-400"
                      >
                        <Loader2 className="w-5 h-5 animate-spin inline mr-2" />
                        Loading...
                      </td>
                    </tr>
                  ) : advances.length === 0 ? (
                    <tr>
                      <td
                        colSpan={6}
                        className="text-center py-8 text-gray-400"
                      >
                        No advances found.
                      </td>
                    </tr>
                  ) : (
                    advances.map((adv) => (
                      <tr
                        key={adv.id}
                        className="hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors"
                      >
                        <td className="px-4 py-3">
                          <div className="font-medium text-gray-900 dark:text-white">
                            {adv.payroll_employees?.name || "—"}
                          </div>
                          <div className="text-xs text-gray-500">
                            {adv.payroll_employees?.employee_code || ""}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-gray-900 dark:text-white">
                          {formatPKR(adv.amount)}
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-gray-900 dark:text-white">
                          {formatPKR(adv.remaining_balance)}
                        </td>
                        <td className="px-4 py-3 text-gray-600 dark:text-gray-400 text-xs hidden md:table-cell max-w-[200px] truncate">
                          {adv.purpose || "—"}
                        </td>
                        <td className="px-4 py-3">
                          <span
                            className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_STYLES[adv.approval_status] || STATUS_STYLES.PENDING}`}
                          >
                            {adv.approval_status.replace(/_/g, " ")}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1">
                            {adv.approval_status === "PENDING" &&
                              canAdvanceApprove && (
                                <>
                                  <button
                                    onClick={() =>
                                      handleAdvanceAction(adv, "approve")
                                    }
                                    className="p-1.5 text-green-600 hover:bg-green-50 dark:hover:bg-green-900/20 rounded-lg transition-colors"
                                    title="Approve"
                                  >
                                    <Check className="w-4 h-4" />
                                  </button>
                                  <button
                                    onClick={() =>
                                      handleAdvanceAction(adv, "reject")
                                    }
                                    className="p-1.5 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition-colors"
                                    title="Reject"
                                  >
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
      {/* TAB 4: COMMISSIONS */}
      {/* ================================================ */}
      {activeTab === "commissions" && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Manage performance and project-based commissions
            </p>
            {canCommAdd && (
              <button
                onClick={() => setShowCommDialog(true)}
                className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2.5 rounded-lg font-medium text-sm hover:bg-blue-700 transition-colors"
              >
                <Plus className="w-4 h-4" /> New Commission
              </button>
            )}
          </div>

          <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 dark:bg-gray-900/50">
                  <tr>
                    <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">
                      Employee
                    </th>
                    <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">
                      Type
                    </th>
                    <th className="text-right px-4 py-3 font-medium text-gray-500 dark:text-gray-400">
                      Base
                    </th>
                    <th className="text-right px-4 py-3 font-medium text-gray-500 dark:text-gray-400">
                      Rate
                    </th>
                    <th className="text-right px-4 py-3 font-medium text-gray-500 dark:text-gray-400">
                      Amount
                    </th>
                    <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">
                      Status
                    </th>
                    <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                  {commLoading ? (
                    <tr>
                      <td
                        colSpan={7}
                        className="text-center py-8 text-gray-400"
                      >
                        <Loader2 className="w-5 h-5 animate-spin inline mr-2" />
                        Loading...
                      </td>
                    </tr>
                  ) : commissions.length === 0 ? (
                    <tr>
                      <td
                        colSpan={7}
                        className="text-center py-8 text-gray-400"
                      >
                        No commissions found.
                      </td>
                    </tr>
                  ) : (
                    commissions.map((comm) => (
                      <tr
                        key={comm.id}
                        className="hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors"
                      >
                        <td className="px-4 py-3">
                          <div className="font-medium text-gray-900 dark:text-white">
                            {comm.payroll_employees?.name || "—"}
                          </div>
                          <div className="text-xs text-gray-500">
                            {comm.payroll_employees?.employee_code || ""}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-gray-600 dark:text-gray-400">
                          {comm.commission_type.replace(/_/g, " ")}
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-gray-900 dark:text-white">
                          {formatPKR(comm.base_amount)}
                        </td>
                        <td className="px-4 py-3 text-right text-gray-600 dark:text-gray-400">
                          {(comm.commission_rate * 100).toFixed(1)}%
                        </td>
                        <td className="px-4 py-3 text-right font-mono font-semibold text-gray-900 dark:text-white">
                          {formatPKR(comm.commission_amount)}
                        </td>
                        <td className="px-4 py-3">
                          <span
                            className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_STYLES[comm.status] || STATUS_STYLES.PENDING}`}
                          >
                            {comm.status}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1">
                            {comm.status === "PENDING" && canCommApprove && (
                              <>
                                <button
                                  onClick={() =>
                                    handleCommissionAction(comm, "approve")
                                  }
                                  className="p-1.5 text-green-600 hover:bg-green-50 dark:hover:bg-green-900/20 rounded-lg transition-colors"
                                  title="Approve"
                                >
                                  <Check className="w-4 h-4" />
                                </button>
                                <button
                                  onClick={() =>
                                    handleCommissionAction(comm, "reject")
                                  }
                                  className="p-1.5 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition-colors"
                                  title="Reject"
                                >
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
      {/* TAB 5: REIMBURSEMENTS */}
      {/* ================================================ */}
      {activeTab === "reimbursements" && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Track employee reimbursement claims
            </p>
            {canReimbAdd && (
              <button
                onClick={() => setShowReimbDialog(true)}
                className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2.5 rounded-lg font-medium text-sm hover:bg-blue-700 transition-colors"
              >
                <Plus className="w-4 h-4" /> New Reimbursement
              </button>
            )}
          </div>

          <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 dark:bg-gray-900/50">
                  <tr>
                    <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">
                      Employee
                    </th>
                    <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">
                      Category
                    </th>
                    <th className="text-right px-4 py-3 font-medium text-gray-500 dark:text-gray-400">
                      Amount
                    </th>
                    <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400 hidden md:table-cell">
                      Description
                    </th>
                    <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400 hidden lg:table-cell">
                      Date
                    </th>
                    <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">
                      Status
                    </th>
                    <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                  {reimbLoading ? (
                    <tr>
                      <td
                        colSpan={7}
                        className="text-center py-8 text-gray-400"
                      >
                        <Loader2 className="w-5 h-5 animate-spin inline mr-2" />
                        Loading...
                      </td>
                    </tr>
                  ) : reimbursements.length === 0 ? (
                    <tr>
                      <td
                        colSpan={7}
                        className="text-center py-8 text-gray-400"
                      >
                        No reimbursements found.
                      </td>
                    </tr>
                  ) : (
                    reimbursements.map((reimb: any) => (
                      <tr
                        key={reimb.id}
                        className="hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors"
                      >
                        <td className="px-4 py-3">
                          <div className="font-medium text-gray-900 dark:text-white">
                            {reimb.payroll_employees?.name || "—"}
                          </div>
                          <div className="text-xs text-gray-500">
                            {reimb.payroll_employees?.employee_code || ""}
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300">
                            {reimb.category.replace(/_/g, " ")}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right font-mono font-semibold text-gray-900 dark:text-white">
                          {formatPKR(reimb.amount)}
                        </td>
                        <td className="px-4 py-3 text-gray-600 dark:text-gray-400 text-xs hidden md:table-cell max-w-[200px] truncate">
                          {reimb.description || "—"}
                        </td>
                        <td className="px-4 py-3 text-gray-500 dark:text-gray-400 text-xs hidden lg:table-cell">
                          {formatDate(reimb.expense_date)}
                        </td>
                        <td className="px-4 py-3">
                          <span
                            className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_STYLES[reimb.status] || STATUS_STYLES.PENDING}`}
                          >
                            {reimb.status}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1">
                            {reimb.status === "PENDING" && canReimbApprove && (
                              <>
                                <button
                                  onClick={() =>
                                    handleReimbAction(reimb, "approve")
                                  }
                                  className="p-1.5 text-green-600 hover:bg-green-50 dark:hover:bg-green-900/20 rounded-lg transition-colors"
                                  title="Approve"
                                >
                                  <Check className="w-4 h-4" />
                                </button>
                                <button
                                  onClick={() =>
                                    handleReimbAction(reimb, "reject")
                                  }
                                  className="p-1.5 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition-colors"
                                  title="Reject"
                                >
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
      {/* DIALOGS */}
      {/* ================================================ */}

      {/* ─── EMPLOYEE FORM DIALOG ─── */}
      {showEmpForm && (
        <DialogOverlay onClose={() => setShowEmpForm(false)}>
          <div className="bg-white dark:bg-gray-800 rounded-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <DialogHeader
              title={editingEmp ? "Edit Employee" : "Add New Employee"}
              onClose={() => {
                setShowEmpForm(false);
                setEditingEmp(null);
              }}
            />
            <EmployeeForm
              initialData={
                editingEmp
                  ? {
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
                    }
                  : undefined
              }
              onSubmit={handleEmployeeSubmit}
              onCancel={() => {
                setShowEmpForm(false);
                setEditingEmp(null);
              }}
              submitting={
                createEmployeeMut.isPending || updateEmployeeMut.isPending
              }
            />
          </div>
        </DialogOverlay>
      )}

      {/* ─── COMPENSATION FORM DIALOG ─── */}
      {showCompForm && (
        <DialogOverlay onClose={() => setShowCompForm(false)}>
          <div className="bg-white dark:bg-gray-800 rounded-xl w-full max-w-md">
            <DialogHeader
              title="Set Compensation"
              onClose={() => setShowCompForm(false)}
            />
            <CompensationForm
              employeeId={compEmployeeId}
              projects={projects}
              onSubmit={handleCompensationSubmit}
              onCancel={() => setShowCompForm(false)}
              submitting={setCompensationMut.isPending}
            />
          </div>
        </DialogOverlay>
      )}

      {/* ─── RUN CREATION DIALOG ─── */}
      {showRunDialog && (
        <DialogOverlay onClose={() => setShowRunDialog(false)}>
          <div className="bg-white dark:bg-gray-800 rounded-xl w-full max-w-sm">
            <DialogHeader
              title="Create Payroll Run"
              onClose={() => setShowRunDialog(false)}
            />
            <div className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Month
                </label>
                <select
                  value={runForm.month}
                  onChange={(e) =>
                    setRunForm({ ...runForm, month: e.target.value })
                  }
                  className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                >
                  {months.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Year
                </label>
                <select
                  value={runForm.year}
                  onChange={(e) =>
                    setRunForm({ ...runForm, year: e.target.value })
                  }
                  className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                >
                  {years.map((y) => (
                    <option key={y.value} value={y.value}>
                      {y.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg p-3 flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
                <p className="text-xs text-amber-700 dark:text-amber-400">
                  This will calculate payroll for all ACTIVE employees with
                  active compensation. Make sure compensation is set correctly
                  before running.
                </p>
              </div>
              <div className="flex gap-3 pt-2">
                <button
                  onClick={() => setShowRunDialog(false)}
                  className="flex-1 px-4 py-2.5 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 text-sm font-medium hover:bg-gray-50 dark:hover:bg-gray-700"
                >
                  Cancel
                </button>
                <button
                  onClick={handleCreateRun}
                  className="flex-1 px-4 py-2.5 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 flex items-center justify-center gap-2"
                >
                  Create Payroll Run
                </button>
              </div>
            </div>
          </div>
        </DialogOverlay>
      )}

      {/* ─── RUN DETAIL DIALOG (Payslip View) ─── */}
      {selectedRun && (
        <DialogOverlay
          onClose={() => {
            setSelectedRun(null);
          }}
        >
          <div className="bg-white dark:bg-gray-800 rounded-xl w-full max-w-5xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between p-6 border-b border-gray-200 dark:border-gray-700 sticky top-0 bg-white dark:bg-gray-800 z-10">
              <div>
                <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
                  Payroll Run — {formatPeriod(selectedRun.payroll_period)}
                </h2>
                <div className="flex items-center gap-3 mt-1">
                  <span
                    className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_STYLES[selectedRun.status] || STATUS_STYLES.DRAFT}`}
                  >
                    {selectedRun.status}
                  </span>
                  <span className="text-xs text-gray-500">
                    {selectedRun.total_employees} employees
                  </span>
                </div>
              </div>
              <button
                onClick={() => setSelectedRun(null)}
                className="p-1 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg"
              >
                <X className="w-5 h-5 text-gray-500" />
              </button>
            </div>

            {/* Summary Cards */}
            <div className="grid grid-cols-3 gap-4 p-6">
              <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-4">
                <p className="text-xs text-blue-600 dark:text-blue-400 font-medium">
                  Total Gross Pay
                </p>
                <p className="text-xl font-bold text-blue-900 dark:text-blue-100 mt-1">
                  {formatPKR(selectedRun.total_gross_pay)}
                </p>
              </div>
              <div className="bg-red-50 dark:bg-red-900/20 rounded-lg p-4">
                <p className="text-xs text-red-600 dark:text-red-400 font-medium">
                  Total Deductions
                </p>
                <p className="text-xl font-bold text-red-900 dark:text-red-100 mt-1">
                  {formatPKR(selectedRun.total_deductions)}
                </p>
              </div>
              <div className="bg-green-50 dark:bg-green-900/20 rounded-lg p-4">
                <p className="text-xs text-green-600 dark:text-green-400 font-medium">
                  Total Net Pay
                </p>
                <p className="text-xl font-bold text-green-900 dark:text-green-100 mt-1">
                  {formatPKR(selectedRun.total_net_pay)}
                </p>
              </div>
            </div>

            {/* Lines Table */}
            <div className="px-6 pb-6">
              {runLinesLoading ? (
                <p className="text-center py-8 text-gray-400">
                  <Loader2 className="w-5 h-5 animate-spin inline mr-2" />
                  Loading payslips...
                </p>
              ) : !runLines || runLines.length === 0 ? (
                <p className="text-center py-8 text-gray-400">
                  No payroll lines found for this run.
                </p>
              ) : (
                <div className="overflow-x-auto border border-gray-200 dark:border-gray-700 rounded-lg">
                  <table className="w-full text-xs">
                    <thead className="bg-gray-50 dark:bg-gray-900/50">
                      <tr>
                        <th className="text-left px-3 py-2 font-medium text-gray-500">
                          Employee
                        </th>
                        <th className="text-right px-3 py-2 font-medium text-gray-500">
                          Basic
                        </th>
                        <th className="text-right px-3 py-2 font-medium text-gray-500 hidden md:table-cell">
                          Allowances
                        </th>
                        <th className="text-right px-3 py-2 font-medium text-gray-500">
                          Gross
                        </th>
                        <th className="text-right px-3 py-2 font-medium text-gray-500 hidden md:table-cell">
                          Deductions
                        </th>
                        <th className="text-right px-3 py-2 font-medium text-gray-500">
                          Net Pay
                        </th>
                        <th className="text-center px-3 py-2 font-medium text-gray-500">
                          Payment
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                      {runLines.map((line) => (
                        <tr
                          key={line.id}
                          className="hover:bg-gray-50 dark:hover:bg-gray-700/50"
                        >
                          <td className="px-3 py-2">
                            <div className="font-medium text-gray-900 dark:text-white">
                              {line.employee_name || "—"}
                            </div>
                            <div className="text-gray-500">
                              {line.employee_code || ""}
                            </div>
                          </td>
                          <td className="px-3 py-2 text-right font-mono">
                            {formatPKR(line.basic_salary)}
                          </td>
                          <td className="px-3 py-2 text-right font-mono hidden md:table-cell">
                            {formatPKR(
                              line.housing_allow +
                                line.medical_allow +
                                line.conveyance_allow +
                                line.other_allowances +
                                line.overtime_pay
                            )}
                          </td>
                          <td className="px-3 py-2 text-right font-mono font-medium">
                            {formatPKR(line.gross_pay)}
                          </td>
                          <td className="px-3 py-2 text-right font-mono text-red-600 hidden md:table-cell">
                            {formatPKR(line.total_deductions)}
                          </td>
                          <td className="px-3 py-2 text-right font-mono font-bold text-green-700 dark:text-green-400">
                            {formatPKR(line.net_pay)}
                          </td>
                          <td className="px-3 py-2 text-center">
                            <span
                              className={`inline-flex px-1.5 py-0.5 rounded-full text-xs font-medium ${STATUS_STYLES[line.payment_status] || STATUS_STYLES.PENDING}`}
                            >
                              {line.payment_status.replace(/_/g, " ")}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot className="bg-gray-50 dark:bg-gray-900/50 font-bold">
                      <tr>
                        <td className="px-3 py-2 text-gray-900 dark:text-white">
                          TOTAL
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-gray-900 dark:text-white">
                          {formatPKR(
                            runLines.reduce((s, l) => s + l.basic_salary, 0)
                          )}
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-gray-900 dark:text-white hidden md:table-cell">
                          {formatPKR(
                            runLines.reduce(
                              (s, l) =>
                                s +
                                l.housing_allow +
                                l.medical_allow +
                                l.conveyance_allow +
                                l.other_allowances +
                                l.overtime_pay,
                              0
                            )
                          )}
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-gray-900 dark:text-white">
                          {formatPKR(
                            runLines.reduce((s, l) => s + l.gross_pay, 0)
                          )}
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-red-600 hidden md:table-cell">
                          {formatPKR(
                            runLines.reduce(
                              (s, l) => s + l.total_deductions,
                              0
                            )
                          )}
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-green-700 dark:text-green-400">
                          {formatPKR(
                            runLines.reduce((s, l) => s + l.net_pay, 0)
                          )}
                        </td>
                        <td></td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}
            </div>
          </div>
        </DialogOverlay>
      )}

      {/* ─── ADVANCE FORM DIALOG ─── */}
      {showAdvanceDialog && (
        <DialogOverlay onClose={() => setShowAdvanceDialog(false)}>
          <div className="bg-white dark:bg-gray-800 rounded-xl w-full max-w-md">
            <DialogHeader
              title="New Salary Advance"
              onClose={() => setShowAdvanceDialog(false)}
            />
            <div className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Employee *
                </label>
                <select
                  value={advForm.employee_id}
                  onChange={(e) =>
                    setAdvForm({ ...advForm, employee_id: e.target.value })
                  }
                  className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                >
                  <option value="">Select employee...</option>
                  {activeEmployees.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.employee_code} — {e.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Amount (PKR) *
                </label>
                <input
                  type="number"
                  value={advForm.amount}
                  onChange={(e) =>
                    setAdvForm({ ...advForm, amount: e.target.value })
                  }
                  className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                  placeholder="e.g. 50000"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Purpose
                </label>
                <input
                  type="text"
                  value={advForm.purpose}
                  onChange={(e) =>
                    setAdvForm({ ...advForm, purpose: e.target.value })
                  }
                  className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                  placeholder="Reason for advance"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Monthly Deduction
                  </label>
                  <input
                    type="number"
                    value={advForm.monthly_deduction}
                    onChange={(e) =>
                      setAdvForm({
                        ...advForm,
                        monthly_deduction: e.target.value,
                      })
                    }
                    className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                    placeholder="e.g. 5000"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Start Month
                  </label>
                  <input
                    type="month"
                    value={advForm.start_deduction_month}
                    onChange={(e) =>
                      setAdvForm({
                        ...advForm,
                        start_deduction_month: e.target.value,
                      })
                    }
                    className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                  />
                </div>
              </div>
              <div className="flex gap-3 pt-2">
                <button
                  onClick={() => setShowAdvanceDialog(false)}
                  className="flex-1 px-4 py-2.5 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 text-sm font-medium hover:bg-gray-50 dark:hover:bg-gray-700"
                >
                  Cancel
                </button>
                <button
                  onClick={handleCreateAdvance}
                  className="flex-1 px-4 py-2.5 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700"
                >
                  Create Advance
                </button>
              </div>
            </div>
          </div>
        </DialogOverlay>
      )}

      {/* ─── COMMISSION FORM DIALOG ─── */}
      {showCommDialog && (
        <DialogOverlay onClose={() => setShowCommDialog(false)}>
          <div className="bg-white dark:bg-gray-800 rounded-xl w-full max-w-md">
            <DialogHeader
              title="New Commission"
              onClose={() => setShowCommDialog(false)}
            />
            <div className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Employee *
                </label>
                <select
                  value={commForm.employee_id}
                  onChange={(e) =>
                    setCommForm({ ...commForm, employee_id: e.target.value })
                  }
                  className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                >
                  <option value="">Select employee...</option>
                  {activeEmployees.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.employee_code} — {e.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Commission Type
                  </label>
                  <select
                    value={commForm.commission_type}
                    onChange={(e) =>
                      setCommForm({
                        ...commForm,
                        commission_type: e.target.value,
                      })
                    }
                    className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                  >
                    {COMMISSION_TYPES.map((t) => (
                      <option key={t.value} value={t.value}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Period Month
                  </label>
                  <input
                    type="month"
                    value={commForm.period_month}
                    onChange={(e) =>
                      setCommForm({ ...commForm, period_month: e.target.value })
                    }
                    className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Base Amount
                  </label>
                  <input
                    type="number"
                    value={commForm.base_amount}
                    onChange={(e) =>
                      setCommForm({ ...commForm, base_amount: e.target.value })
                    }
                    className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                    placeholder="0"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Rate (%)
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    value={commForm.commission_rate}
                    onChange={(e) =>
                      setCommForm({
                        ...commForm,
                        commission_rate: e.target.value,
                      })
                    }
                    className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                    placeholder="e.g. 10"
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Commission Amount (PKR) *
                </label>
                <input
                  type="number"
                  value={commForm.commission_amount}
                  onChange={(e) =>
                    setCommForm({
                      ...commForm,
                      commission_amount: e.target.value,
                    })
                  }
                  className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                  placeholder="Final amount"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Description
                </label>
                <textarea
                  value={commForm.description}
                  onChange={(e) =>
                    setCommForm({ ...commForm, description: e.target.value })
                  }
                  rows={2}
                  className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-blue-500 outline-none resize-none"
                  placeholder="Optional details..."
                />
              </div>
              <div className="flex gap-3 pt-2">
                <button
                  onClick={() => setShowCommDialog(false)}
                  className="flex-1 px-4 py-2.5 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 text-sm font-medium hover:bg-gray-50 dark:hover:bg-gray-700"
                >
                  Cancel
                </button>
                <button
                  onClick={handleCreateCommission}
                  className="flex-1 px-4 py-2.5 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700"
                >
                  Create Commission
                </button>
              </div>
            </div>
          </div>
        </DialogOverlay>
      )}

      {/* ─── REIMBURSEMENT FORM DIALOG ─── */}
      {showReimbDialog && (
        <DialogOverlay onClose={() => setShowReimbDialog(false)}>
          <div className="bg-white dark:bg-gray-800 rounded-xl w-full max-w-md">
            <DialogHeader
              title="New Reimbursement Claim"
              onClose={() => setShowReimbDialog(false)}
            />
            <div className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Employee *
                </label>
                <select
                  value={reimbForm.employee_id}
                  onChange={(e) =>
                    setReimbForm({ ...reimbForm, employee_id: e.target.value })
                  }
                  className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                >
                  <option value="">Select employee...</option>
                  {activeEmployees.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.employee_code} — {e.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Category
                  </label>
                  <select
                    value={reimbForm.category}
                    onChange={(e) =>
                      setReimbForm({ ...reimbForm, category: e.target.value })
                    }
                    className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                  >
                    {REIMBURSEMENT_CATEGORIES.map((c) => (
                      <option key={c.value} value={c.value}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Expense Date
                  </label>
                  <input
                    type="date"
                    value={reimbForm.expense_date}
                    onChange={(e) =>
                      setReimbForm({
                        ...reimbForm,
                        expense_date: e.target.value,
                      })
                    }
                    className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Amount (PKR) *
                </label>
                <input
                  type="number"
                  value={reimbForm.amount}
                  onChange={(e) =>
                    setReimbForm({ ...reimbForm, amount: e.target.value })
                  }
                  className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                  placeholder="e.g. 5000"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Description
                </label>
                <textarea
                  value={reimbForm.description}
                  onChange={(e) =>
                    setReimbForm({ ...reimbForm, description: e.target.value })
                  }
                  rows={2}
                  className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-blue-500 outline-none resize-none"
                  placeholder="Details of the expense..."
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Receipt Reference
                </label>
                <input
                  type="text"
                  value={reimbForm.receipt_ref}
                  onChange={(e) =>
                    setReimbForm({ ...reimbForm, receipt_ref: e.target.value })
                  }
                  className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                  placeholder="Receipt or bill number"
                />
              </div>
              <div className="flex gap-3 pt-2">
                <button
                  onClick={() => setShowReimbDialog(false)}
                  className="flex-1 px-4 py-2.5 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 text-sm font-medium hover:bg-gray-50 dark:hover:bg-gray-700"
                >
                  Cancel
                </button>
                <button
                  onClick={handleCreateReimbursement}
                  className="flex-1 px-4 py-2.5 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700"
                >
                  Submit Claim
                </button>
              </div>
            </div>
          </div>
        </DialogOverlay>
      )}

      {/* ─── DELETE CONFIRMATION DIALOG ─── */}
      {showDeleteModal && deleteTarget && (
        <DialogOverlay onClose={() => setShowDeleteModal(false)}>
          <div className="bg-white dark:bg-gray-800 rounded-xl w-full max-w-sm">
            <div className="p-6 text-center">
              <div className="mx-auto w-12 h-12 rounded-full bg-red-100 dark:bg-red-900/30 flex items-center justify-center mb-4">
                <AlertTriangle className="w-6 h-6 text-red-600" />
              </div>
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
                Delete {deleteTarget.type}?
              </h3>
              <p className="text-sm text-gray-500 mt-2">
                Are you sure you want to delete &quot;{deleteTarget.name}&quot;?
                This action cannot be undone.
              </p>
              <div className="flex gap-3 mt-6">
                <button
                  onClick={() => setShowDeleteModal(false)}
                  className="flex-1 px-4 py-2.5 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 text-sm font-medium hover:bg-gray-50 dark:hover:bg-gray-700"
                >
                  Cancel
                </button>
                <button
                  onClick={confirmDelete}
                  className="flex-1 px-4 py-2.5 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-700"
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        </DialogOverlay>
      )}
    </div>
  );
}

// ==========================================
// REUSABLE DIALOG COMPONENTS
// ==========================================

function DialogOverlay({
  children,
  onClose,
}: {
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div onClick={(e) => e.stopPropagation()}>{children}</div>
    </div>
  );
}

function DialogHeader({
  title,
  onClose,
}: {
  title: string;
  onClose: () => void;
}) {
  return (
    <div className="flex items-center justify-between p-6 border-b border-gray-200 dark:border-gray-700">
      <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
        {title}
      </h2>
      <button
        onClick={onClose}
        className="p-1 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg"
      >
        <X className="w-5 h-5 text-gray-500" />
      </button>
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
      name: "",
      email: "",
      phone: "",
      designation: "",
      department: "",
      employment_type: "FULL_TIME",
      join_date: "",
      bank_name: "",
      bank_account: "",
      cnic: "",
      notes: "",
    }
  );

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) {
      toast.error("Name is required");
      return;
    }
    onSubmit(form);
  }

  return (
    <form onSubmit={handleSubmit} className="p-6 space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div className="col-span-2">
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            Full Name *
          </label>
          <input
            type="text"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            required
            className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-blue-500 outline-none"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            Email
          </label>
          <input
            type="email"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
            className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-blue-500 outline-none"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            Phone
          </label>
          <input
            type="text"
            value={form.phone}
            onChange={(e) => setForm({ ...form, phone: e.target.value })}
            className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-blue-500 outline-none"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            Designation
          </label>
          <input
            type="text"
            value={form.designation}
            onChange={(e) =>
              setForm({ ...form, designation: e.target.value })
            }
            className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-blue-500 outline-none"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            Department
          </label>
          <input
            type="text"
            value={form.department}
            onChange={(e) =>
              setForm({ ...form, department: e.target.value })
            }
            className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-blue-500 outline-none"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            Employment Type *
          </label>
          <select
            value={form.employment_type}
            onChange={(e) =>
              setForm({ ...form, employment_type: e.target.value })
            }
            className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-blue-500 outline-none"
          >
            {EMPLOYMENT_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            Join Date
          </label>
          <input
            type="date"
            value={form.join_date}
            onChange={(e) =>
              setForm({ ...form, join_date: e.target.value })
            }
            className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-blue-500 outline-none"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            CNIC
          </label>
          <input
            type="text"
            value={form.cnic}
            onChange={(e) => setForm({ ...form, cnic: e.target.value })}
            className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-blue-500 outline-none"
            placeholder="00000-0000000-0"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            Bank Name
          </label>
          <input
            type="text"
            value={form.bank_name}
            onChange={(e) =>
              setForm({ ...form, bank_name: e.target.value })
            }
            className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-blue-500 outline-none"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            Bank Account
          </label>
          <input
            type="text"
            value={form.bank_account}
            onChange={(e) =>
              setForm({ ...form, bank_account: e.target.value })
            }
            className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-blue-500 outline-none"
          />
        </div>
      </div>
      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          Notes
        </label>
        <textarea
          value={form.notes}
          onChange={(e) => setForm({ ...form, notes: e.target.value })}
          rows={2}
          className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-blue-500 outline-none resize-none"
        />
      </div>
      <div className="flex gap-3 pt-2">
        <button
          type="button"
          onClick={onCancel}
          className="flex-1 px-4 py-2.5 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 text-sm font-medium hover:bg-gray-50 dark:hover:bg-gray-700"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={submitting}
          className="flex-1 px-4 py-2.5 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2"
        >
          {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
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
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          Compensation Type
        </label>
        <select
          value={form.compensation_type}
          onChange={(e) =>
            setForm({ ...form, compensation_type: e.target.value })
          }
          className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-blue-500 outline-none"
        >
          {COMPENSATION_TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          Amount (PKR) *
        </label>
        <input
          type="number"
          value={form.amount}
          onChange={(e) => setForm({ ...form, amount: e.target.value })}
          required
          className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-blue-500 outline-none"
          placeholder="e.g. 150000"
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            Effective From
          </label>
          <input
            type="date"
            value={form.effective_from}
            onChange={(e) =>
              setForm({ ...form, effective_from: e.target.value })
            }
            className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-blue-500 outline-none"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            Effective To
          </label>
          <input
            type="date"
            value={form.effective_to}
            onChange={(e) =>
              setForm({ ...form, effective_to: e.target.value })
            }
            className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-blue-500 outline-none"
          />
        </div>
      </div>
      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          Project (Optional)
        </label>
        <select
          value={form.project_id}
          onChange={(e) => setForm({ ...form, project_id: e.target.value })}
          className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-blue-500 outline-none"
        >
          <option value="">No project allocation</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          Notes
        </label>
        <textarea
          value={form.notes}
          onChange={(e) => setForm({ ...form, notes: e.target.value })}
          rows={2}
          className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-blue-500 outline-none resize-none"
        />
      </div>
      <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-3">
        <p className="text-xs text-blue-700 dark:text-blue-400">
          Setting new compensation will deactivate the previous active record.
          Old compensation history is preserved.
        </p>
      </div>
      <div className="flex gap-3 pt-2">
        <button
          type="button"
          onClick={onCancel}
          className="flex-1 px-4 py-2.5 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 text-sm font-medium hover:bg-gray-50 dark:hover:bg-gray-700"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={submitting}
          className="flex-1 px-4 py-2.5 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2"
        >
          {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
          Save Compensation
        </button>
      </div>
    </form>
  );
}
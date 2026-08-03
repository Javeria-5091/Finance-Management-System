"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/context/AuthContext";
import { usePermissions } from "@/context/PermissionContext";
import Link from "next/link";
import {
  Calculator, FileCheck2, ArrowRight, RotateCcw, Info,
  TrendingDown, TrendingUp, ArrowUpRight, ChevronDown, Clock,
  CheckCircle2, Circle, AlertTriangle, ExternalLink,
} from "lucide-react";
import toast from "react-hot-toast";

// ==========================================
// TYPES
// ==========================================
interface TaxReconciliation {
  id: string;
  tax_year: string;
  fiscal_year_id: string;
  accounting_profit_before_tax: number;
  taxable_income: number;
  gross_tax_liability: number;
  withholding_credits: number;
  advance_tax_credits: number;
  other_tax_credits: number;
  net_tax_payable: number;
  profit_after_tax: number;
  effective_tax_rate: number;
  status: string;
  filing_date: string | null;
  filing_reference: string | null;
  payment_reference: string | null;
  payment_date: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  tax_rule_set_id: string;
}

interface TaxAdjustment {
  id: string;
  tax_reconciliation_id: string;
  adjustment_category: string;
  description: string;
  amount: number;
  created_at: string;
}

// ==========================================
// HELPERS
// ==========================================
const f = (n: number) =>
  new Intl.NumberFormat("en-PK", {
    style: "currency",
    currency: "PKR",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(n || 0);

const STATUS_CFG: Record<string, { label: string; color: string; bg: string; dot: string }> = {
  DRAFT:               { label: "Draft Estimate",     color: "text-gray-600 dark:text-gray-400", bg: "bg-gray-100 dark:bg-gray-700", dot: "bg-gray-400" },
  CALCULATED:          { label: "Calculated",          color: "text-blue-600",   bg: "bg-blue-50 dark:bg-blue-900/20",   dot: "bg-blue-500" },
  UNDER_REVIEW:        { label: "Under Review",        color: "text-amber-600",  bg: "bg-amber-50 dark:bg-amber-900/20", dot: "bg-amber-500" },
  ACCOUNTANT_APPROVED: { label: "Accountant Approved",  color: "text-indigo-600", bg: "bg-indigo-50 dark:bg-indigo-900/20", dot: "bg-indigo-500" },
  FILED:               { label: "Filed",               color: "text-purple-600", bg: "bg-purple-50 dark:bg-purple-900/20", dot: "bg-purple-500" },
  PAYMENT_PENDING:     { label: "Payment Pending",     color: "text-orange-600", bg: "bg-orange-50 dark:bg-orange-900/20", dot: "bg-orange-500" },
  PAID:                { label: "Paid",                color: "text-green-600",  bg: "bg-green-50 dark:bg-green-900/20",  dot: "bg-green-500" },
  REFUND_PENDING:      { label: "Refund Pending",      color: "text-teal-600",   bg: "bg-teal-50 dark:bg-teal-900/20",   dot: "bg-teal-500" },
  AMENDED:             { label: "Amended",             color: "text-rose-600",   bg: "bg-rose-50 dark:bg-rose-900/20",   dot: "bg-rose-500" },
  CLOSED:              { label: "Closed",              color: "text-gray-500",   bg: "bg-gray-100 dark:bg-gray-800",     dot: "bg-gray-500" },
};

const ADJ_LABELS: Record<string, string> = {
  ADD_BACK: "Add-back (Non-Deductible)",
  DEDUCTION: "Allowable Deduction",
  NON_DEDUCTIBLE: "Non-Deductible Expense",
  EXEMPTION: "Tax Exemption",
  DEPRECIATION_DIFF: "Depreciation Difference",
  PROVISION_ADJUST: "Provision Adjustment",
  PRIVATE_EXPENSE: "Private / Non-Business",
  CAPITAL_VS_REVENUE: "Capital vs Revenue",
  LOSS_CARRY_FORWARD: "Loss Carry Forward",
  SEPARATE_BLOCK: "Separate Block Income",
  TAX_DEPRECIATION: "Tax Depreciation",
  OTHER: "Other Adjustment",
};

// ==========================================
// STATUS BADGE
// ==========================================
function StatusBadge({ status }: { status: string }) {
  const c = STATUS_CFG[status] || STATUS_CFG.DRAFT;
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wide ${c.bg} ${c.color}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${c.dot}`} />
      {c.label}
    </span>
  );
}

// ==========================================
// WATERFALL BAR (horizontal bridge)
// ==========================================
function BridgeBar({
  segments,
}: {
  segments: { label: string; value: number; color: string; isTotal?: boolean }[];
}) {
  const max = Math.max(...segments.map((s) => Math.abs(s.value)), 1);
  let cum = 0;
  const running: number[] = [];
  for (const s of segments) {
    cum += s.value;
    running.push(cum);
  }

  return (
    <div className="space-y-2.5">
      {segments.map((s, i) => {
        const wPct = (Math.abs(s.value) / max) * 100;
        const baseOffset = i === 0 ? 0 : Math.max(running[i - 1], 0);
        const barLeft = `${(baseOffset / max) * 100}%`;
        return (
          <div key={i} className="flex items-center gap-3">
            <span className={`text-[11px] w-44 text-right flex-shrink-0 ${
              s.isTotal ? "font-bold text-gray-900 dark:text-white" : "text-gray-600 dark:text-gray-400"
            }`}>
              {s.label}
            </span>
            <div className="flex-1 h-7 bg-gray-100 dark:bg-gray-700 rounded-lg overflow-hidden relative">
              {baseOffset > 0 && (
                <div className="absolute left-0 top-0 h-full bg-white dark:bg-gray-800" style={{ width: barLeft }} />
              )}
              <div
                className="absolute top-1 bottom-1 rounded-md transition-all duration-700"
                style={{
                  left: barLeft,
                  width: `${Math.max(wPct, 0.5)}%`,
                  backgroundColor: s.color,
                }}
              />
            </div>
            <span
              className={`text-[11px] font-mono w-28 text-right flex-shrink-0 ${
                s.isTotal ? "font-bold text-gray-900 dark:text-white" : "text-gray-600 dark:text-gray-400"
              }`}
            >
              {s.isTotal ? f(s.value) : s.value > 0 ? `+${f(s.value)}` : f(s.value)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ==========================================
// MAIN PAGE
// ==========================================
export default function TaxReportsPage() {
  const { user } = useAuth();
  const { hasPermission } = usePermissions();
  const [loading, setLoading] = useState(true);
  const [reconciliations, setReconciliations] = useState<TaxReconciliation[]>([]);
  const [adjustments, setAdjustments] = useState<Record<string, TaxAdjustment[]>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dataAsOf, setDataAsOf] = useState<string>("");

  // ---- FETCH ----
  const fetchAll = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const { data, error } = await supabase
        .schema("finance")
        .from("tax_reconciliations")
        .select("*")
        .order("tax_year", { ascending: false });

      if (error) throw error;

      setReconciliations((data as TaxReconciliation[]) || []);
      setDataAsOf(new Date().toLocaleString("en-PK", { dateStyle: "medium", timeStyle: "short" }));

      // Fetch adjustments for all reconciliations
      if (data && data.length > 0) {
        const ids = data.map((r: TaxReconciliation) => r.id);
        const { data: adj } = await supabase
          .schema("finance")
          .from("tax_adjustments")
          .select("*")
          .in("tax_reconciliation_id", ids)
          .order("created_at", { ascending: false });

        if (adj) {
          const map: Record<string, TaxAdjustment[]> = {};
          for (const a of adj) {
            const rid = (a as TaxAdjustment).tax_reconciliation_id;
            if (!map[rid]) map[rid] = [];
            map[rid].push(a as TaxAdjustment);
          }
          setAdjustments(map);
        }
      }
    } catch (err: any) {
      console.error("[TaxReports]", err);
      toast.error("Could not load tax reports: " + (err?.message || "Table not found"));
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  // ---- SELECTED RECONCILIATION ----
  const sel = reconciliations.find((r) => r.id === selectedId) || reconciliations[0] || null;
  const selAdj = sel ? adjustments[sel.id] || [] : [];

  const addBacks = selAdj
    .filter((a) => ["ADD_BACK", "NON_DEDUCTIBLE", "PRIVATE_EXPENSE"].includes(a.adjustment_category))
    .reduce((s, a) => s + a.amount, 0);
  const deductions = selAdj
    .filter((a) => ["DEDUCTION", "EXEMPTION", "LOSS_CARRY_FORWARD"].includes(a.adjustment_category))
    .reduce((s, a) => s + Math.abs(a.amount), 0);
  const otherAdj = selAdj
    .filter(
      (a) =>
        !["ADD_BACK", "NON_DEDUCTIBLE", "PRIVATE_EXPENSE", "DEDUCTION", "EXEMPTION", "LOSS_CARRY_FORWARD"].includes(a.adjustment_category)
    )
    .reduce((s, a) => s + a.amount, 0);
  const totalCredits = sel
    ? sel.withholding_credits + sel.advance_tax_credits + sel.other_tax_credits
    : 0;

  const pbtBridge = sel
    ? [
        { label: "Accounting PBT", value: sel.accounting_profit_before_tax, color: "#3b82f6" },
        { label: "Add-backs", value: addBacks, color: "#ef4444" },
        { label: "Deductions", value: -deductions, color: "#22c55e" },
        { label: "Other Adjustments", value: otherAdj, color: "#f59e0b" },
        { label: "Taxable Income", value: sel.taxable_income, color: "#8b5cf6", isTotal: true },
      ]
    : [];

  const taxBridge = sel
    ? [
        { label: "Gross Tax", value: sel.gross_tax_liability, color: "#ef4444" },
        { label: "WHT Credits", value: -sel.withholding_credits, color: "#22c55e" },
        { label: "Advance Tax", value: -sel.advance_tax_credits, color: "#22c55e" },
        { label: "Other Credits", value: -sel.other_tax_credits, color: "#22c55e" },
        { label: "Net Tax Payable", value: sel.net_tax_payable, color: "#dc2626", isTotal: true },
      ]
    : [];

  // ---- RENDER ----
  return (
    <div className="p-6 max-w-[1400px] mx-auto space-y-5">
      {/* HEADER */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h2 className="text-2xl font-bold text-gray-900 dark:text-white flex items-center gap-3">
            <Calculator className="w-7 h-7 text-purple-600" /> Tax Reports
          </h2>
          <p className="text-sm text-gray-500 mt-1">
            Tax computation summary, reconciliation bridge, and return status
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={fetchAll}
            disabled={loading}
            className="inline-flex items-center gap-2 px-3 py-2 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors disabled:opacity-50"
          >
            <RotateCcw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </button>
          <Link
            href="/dashboard/tax-equity/tax-reconciliation"
            className="inline-flex items-center gap-1.5 px-3 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-lg text-sm font-medium transition-colors"
          >
            <ExternalLink className="w-4 h-4" />
            Open Tax Module
          </Link>
        </div>
      </div>

      {/* REPORT METADATA BAR */}
      <div className="bg-gray-50 dark:bg-gray-800/50 border border-gray-200 dark:border-gray-700 rounded-lg px-4 py-2.5 flex flex-wrap items-center gap-x-6 gap-y-1 text-[11px] text-gray-500">
        <span>
          Organization: <strong className="text-gray-700 dark:text-gray-300">OSYSTIC</strong>
        </span>
        <span>
          Basis: <strong className="text-gray-700 dark:text-gray-300">Accrual (PKR)</strong>
        </span>
        <span>
          Fiscal Calendar: <strong className="text-gray-700 dark:text-gray-300">1 Jul – 30 Jun</strong>
        </span>
        <span>
          Data as of: <strong className="text-gray-700 dark:text-gray-300">{dataAsOf}</strong>
        </span>
      </div>

      {/* LOADING */}
      {loading && (
        <div className="flex flex-col items-center justify-center py-20 gap-3">
          <div className="w-10 h-10 border-4 border-purple-600 border-t-transparent rounded-full animate-spin" />
          <p className="text-sm text-gray-400">Loading tax reports...</p>
        </div>
      )}

      {/* EMPTY STATE */}
      {!loading && reconciliations.length === 0 && (
        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-12 text-center">
          <div className="w-16 h-16 bg-purple-100 dark:bg-purple-900/20 rounded-full flex items-center justify-center mx-auto mb-4">
            <FileCheck2 className="w-8 h-8 text-purple-500" />
          </div>
          <h3 className="text-lg font-bold text-gray-900 dark:text-white mb-2">No Tax Reports Available</h3>
          <p className="text-sm text-gray-500 max-w-md mx-auto mb-6">
            Tax reports are generated from reconciliation data. Create a tax reconciliation
            in the Tax & Equity module to see reports here.
          </p>
          <Link
            href="/dashboard/tax-equity/tax-reconciliation"
            className="inline-flex items-center gap-2 px-5 py-2.5 bg-purple-600 hover:bg-purple-700 text-white rounded-lg text-sm font-medium transition-colors"
          >
            Go to Tax Reconciliation
            <ArrowRight className="w-4 h-4" />
          </Link>
        </div>
      )}

      {/* REPORT CONTENT */}
      {!loading && reconciliations.length > 0 && sel && (
        <>
          {/* TAX YEAR SELECTOR */}
          <div className="flex items-center gap-3">
            <label className="text-xs font-medium text-gray-500">Tax Year:</label>
            <div className="flex gap-1">
              {reconciliations.map((r) => (
                <button
                  key={r.id}
                  onClick={() => setSelectedId(r.id)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                    sel.id === r.id
                      ? "bg-purple-600 text-white shadow-md shadow-purple-600/20"
                      : "bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-600"
                  }`}
                >
                  {r.tax_year}
                </button>
              ))}
            </div>
            <StatusBadge status={sel.status} />
          </div>

          {/* KPI CARDS */}
          <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-3">
            <KPICard label="Accounting PBT" value={f(sel.accounting_profit_before_tax)} color="text-blue-600" />
            <KPICard label="Total Add-backs" value={f(addBacks)} color="text-red-500" />
            <KPICard label="Total Deductions" value={f(-deductions)} color="text-green-600" />
            <KPICard label="Taxable Income" value={f(sel.taxable_income)} color="text-purple-600" bold />
            <KPICard label="Gross Tax" value={f(sel.gross_tax_liability)} color="text-red-600" />
            <KPICard label="Total Credits" value={f(totalCredits)} color="text-green-600" />
            <KPICard label="Net Tax Payable" value={f(sel.net_tax_payable)} color="text-red-700" bold />
            <KPICard label="Eff. Tax Rate" value={`${sel.effective_tax_rate}%`} color="text-purple-600" />
          </div>

          {/* BRIDGE CHARTS */}
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
            <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-5">
              <h4 className="text-xs font-bold uppercase tracking-wider text-gray-400 mb-5">
                PBT to Taxable Income Bridge
              </h4>
              <BridgeBar segments={pbtBridge} />
              <p className="text-[10px] text-gray-400 mt-3 italic">
                Accounting Profit Before Tax and Taxable Income are NOT interchangeable.
                This bridge shows every adjustment between them.
              </p>
            </div>
            <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-5">
              <h4 className="text-xs font-bold uppercase tracking-wider text-gray-400 mb-5">
                Gross Tax to Net Payable
              </h4>
              <BridgeBar segments={taxBridge} />
              <p className="text-[10px] text-gray-400 mt-3 italic">
                WHT/advance tax certificates are tracked separately and offset against gross liability.
              </p>
            </div>
          </div>

          {/* RECONCILIATION SUMMARY + PBT→PAT */}
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
            {/* Adjustment breakdown */}
            <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-5">
              <h4 className="text-xs font-bold uppercase tracking-wider text-gray-400 mb-4">
                Tax Adjustments ({selAdj.length})
              </h4>
              {selAdj.length === 0 ? (
                <p className="text-xs text-gray-400 text-center py-8">No adjustments recorded for this period.</p>
              ) : (
                <div className="space-y-2">
                  {Object.entries(
                    selAdj.reduce<Record<string, { total: number; items: TaxAdjustment[] }>>((acc, a) => {
                      if (!acc[a.adjustment_category]) acc[a.adjustment_category] = { total: 0, items: [] };
                      acc[a.adjustment_category].total += a.amount;
                      acc[a.adjustment_category].items.push(a);
                      return acc;
                    }, {})
                  )
                    .sort(([, a], [, b]) => Math.abs(b.total) - Math.abs(a.total))
                    .map(([cat, { total, items }]) => (
                      <div key={cat} className="flex items-center justify-between py-1.5 px-2 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700/30">
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] text-gray-400 font-mono">{items.length}</span>
                          <span className="text-xs text-gray-700 dark:text-gray-300">
                            {ADJ_LABELS[cat] || cat}
                          </span>
                        </div>
                        <span className={`text-xs font-mono font-bold ${total > 0 ? "text-red-600" : "text-green-600"}`}>
                          {total > 0 ? "+" : ""}{f(total)}
                        </span>
                      </div>
                    ))}
                </div>
              )}
            </div>

            {/* Reconciliation summary table */}
            <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-5">
              <h4 className="text-xs font-bold uppercase tracking-wider text-gray-400 mb-4">
                Reconciliation Summary — {sel.tax_year}
              </h4>
              <div className="space-y-2.5">
                <SumRow label="Accounting Profit Before Tax" value={sel.accounting_profit_before_tax} bold />
                <SumRow label="+ Add-backs" value={addBacks} negative />
                <SumRow label="- Allowable Deductions" value={-deductions} positive />
                <div className="border-t border-dashed border-gray-300 dark:border-gray-600 my-1" />
                <SumRow label="Taxable Income" value={sel.taxable_income} bold highlight />
                <div className="border-t border-gray-200 dark:border-gray-700 my-1" />
                <SumRow label="Gross Tax Liability" value={-sel.gross_tax_liability} negative />
                <SumRow label="- WHT Credits" value={sel.withholding_credits} positive />
                <SumRow label="- Advance Tax Credits" value={sel.advance_tax_credits} positive />
                <SumRow label="- Other Credits" value={sel.other_tax_credits} positive />
                <div className="border-t border-dashed border-gray-300 dark:border-gray-600 my-1" />
                <SumRow label="Net Tax Payable" value={-sel.net_tax_payable} negative bold highlight />
                <div className="border-t border-gray-200 dark:border-gray-700 my-1" />
                <SumRow label="Profit After Tax" value={sel.profit_after_tax} bold />
              </div>
            </div>
          </div>

          {/* PBT → PAT VISUAL BAR */}
          <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-5">
            <h4 className="text-xs font-bold uppercase tracking-wider text-gray-400 mb-4">
              Profit Before Tax → Profit After Tax
            </h4>
            <div className="flex items-center gap-4">
              <div className="flex-1">
                <div className="flex justify-between mb-1">
                  <span className="text-[10px] text-gray-500">PBT</span>
                  <span className="text-[10px] font-mono font-bold text-blue-600">{f(sel.accounting_profit_before_tax)}</span>
                </div>
                <div className="h-5 bg-blue-500 rounded-full" style={{ width: "100%" }} />
              </div>
              <div className="flex flex-col items-center gap-1">
                <ArrowRight className="w-5 h-5 text-red-500" />
                <span className="text-[10px] font-mono font-bold text-red-600">-{f(sel.net_tax_payable)}</span>
                <span className="text-[9px] text-gray-400">Tax</span>
              </div>
              <div className="flex-1">
                <div className="flex justify-between mb-1">
                  <span className="text-[10px] text-gray-500">PAT</span>
                  <span className={`text-[10px] font-mono font-bold ${sel.profit_after_tax >= 0 ? "text-green-600" : "text-red-600"}`}>
                    {f(sel.profit_after_tax)}
                  </span>
                </div>
                <div
                  className={`h-5 rounded-full ${sel.profit_after_tax >= 0 ? "bg-green-500" : "bg-red-500"}`}
                  style={{ width: `${Math.max((Math.abs(sel.profit_after_tax) / Math.max(sel.accounting_profit_before_tax, 1)) * 100, 2)}%` }}
                />
              </div>
              <div className="text-right">
                <p className="text-[10px] text-gray-400">Eff. Rate</p>
                <p className="text-sm font-bold text-purple-600">{sel.effective_tax_rate}%</p>
              </div>
            </div>
          </div>

          {/* FILING / PAYMENT STATUS */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-5">
              <h4 className="text-xs font-bold uppercase tracking-wider text-gray-400 mb-3">Filing Status</h4>
              {sel.filing_reference ? (
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between"><span className="text-gray-500">Reference</span><span className="font-mono font-medium text-gray-900 dark:text-white">{sel.filing_reference}</span></div>
                  <div className="flex justify-between"><span className="text-gray-500">Filed On</span><span className="font-medium text-gray-900 dark:text-white">{sel.filing_date}</span></div>
                </div>
              ) : (
                <div className="flex items-center gap-2 text-sm text-gray-400">
                  <Clock className="w-4 h-4" /> Not yet filed
                </div>
              )}
            </div>
            <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-5">
              <h4 className="text-xs font-bold uppercase tracking-wider text-gray-400 mb-3">Payment Status</h4>
              {sel.payment_reference ? (
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between"><span className="text-gray-500">Reference</span><span className="font-mono font-medium text-gray-900 dark:text-white">{sel.payment_reference}</span></div>
                  <div className="flex justify-between"><span className="text-gray-500">Paid On</span><span className="font-medium text-gray-900 dark:text-white">{sel.payment_date}</span></div>
                </div>
              ) : (
                <div className="flex items-center gap-2 text-sm text-gray-400">
                  <Clock className="w-4 h-4" /> Payment pending
                </div>
              )}
            </div>
          </div>

          {/* NOTES */}
          {sel.notes && (
            <div className="bg-gray-50 dark:bg-gray-800/50 border border-gray-200 dark:border-gray-700 rounded-xl p-4 text-xs text-gray-500">
              <span className="font-semibold">Notes: </span>{sel.notes}
            </div>
          )}

          {/* NAVIGATION LINKS TO TAX MODULE */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Link
              href="/dashboard/tax-equity/tax-reconciliation"
              className="flex items-center gap-3 p-4 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl hover:border-purple-300 dark:hover:border-purple-700 transition-colors group"
            >
              <div className="w-10 h-10 bg-purple-100 dark:bg-purple-900/20 rounded-lg flex items-center justify-center group-hover:bg-purple-200 dark:group-hover:bg-purple-900/30 transition-colors">
                <FileCheck2 className="w-5 h-5 text-purple-600" />
              </div>
              <div>
                <p className="text-sm font-medium text-gray-900 dark:text-white">Tax Reconciliation</p>
                <p className="text-[11px] text-gray-400">Manage reconciliations & adjustments</p>
              </div>
              <ArrowUpRight className="w-4 h-4 text-gray-300 ml-auto group-hover:text-purple-500 transition-colors" />
            </Link>
            <Link
              href="/dashboard/tax-equity/tax-configuration"
              className="flex items-center gap-3 p-4 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl hover:border-blue-300 dark:hover:border-blue-700 transition-colors group"
            >
              <div className="w-10 h-10 bg-blue-100 dark:bg-blue-900/20 rounded-lg flex items-center justify-center group-hover:bg-blue-200 dark:group-hover:bg-blue-900/30 transition-colors">
                <Calculator className="w-5 h-5 text-blue-600" />
              </div>
              <div>
                <p className="text-sm font-medium text-gray-900 dark:text-white">Tax Configuration</p>
                <p className="text-[11px] text-gray-400">Rule sets, slabs & taxpayer profile</p>
              </div>
              <ArrowUpRight className="w-4 h-4 text-gray-300 ml-auto group-hover:text-blue-500 transition-colors" />
            </Link>
            <Link
              href="/dashboard/tax-equity/tax-returns"
              className="flex items-center gap-3 p-4 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl hover:border-green-300 dark:hover:border-green-700 transition-colors group"
            >
              <div className="w-10 h-10 bg-green-100 dark:bg-green-900/20 rounded-lg flex items-center justify-center group-hover:bg-green-200 dark:group-hover:bg-green-900/30 transition-colors">
                <CheckCircle2 className="w-5 h-5 text-green-600" />
              </div>
              <div>
                <p className="text-sm font-medium text-gray-900 dark:text-white">Tax Returns & Filings</p>
                <p className="text-[11px] text-gray-400">Filing, amendments & evidence</p>
              </div>
              <ArrowUpRight className="w-4 h-4 text-gray-300 ml-auto group-hover:text-green-500 transition-colors" />
            </Link>
          </div>
        </>
      )}
    </div>
  );
}

// ==========================================
// SUB-COMPONENTS
// ==========================================
function KPICard({ label, value, color, bold }: { label: string; value: string; color: string; bold?: boolean }) {
  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-3.5">
      <p className="text-[10px] uppercase tracking-wider text-gray-400 mb-1">{label}</p>
      <p className={`text-sm lg:text-base font-mono ${color} ${bold ? "font-bold" : "font-semibold"}`}>{value}</p>
    </div>
  );
}

function SumRow({ label, value, bold, highlight, negative, positive }: {
  label: string; value: number; bold?: boolean; highlight?: boolean; negative?: boolean; positive?: boolean;
}) {
  return (
    <div className={`flex items-center justify-between ${highlight ? "bg-gray-50 dark:bg-gray-900/30 -mx-2 px-2 py-1.5 rounded-lg" : ""}`}>
      <span className={`text-xs ${bold ? "font-bold text-gray-900 dark:text-white" : "text-gray-600 dark:text-gray-400"}`}>{label}</span>
      <span className={`text-xs font-mono ${bold ? "font-bold" : "font-medium"} ${
        negative ? "text-red-600" : positive ? "text-green-600" : "text-gray-900 dark:text-white"
      }`}>
        {value >= 0 ? "" : "-"}{f(Math.abs(value))}
      </span>
    </div>
  );
}
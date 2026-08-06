'use client';

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useTheme } from "@/context/ThemeContext";
import { useQuery } from "@tanstack/react-query";
import {
  getProfitAndLoss, getBalanceSheet, getCashFlow, getAgingReport, getProjectProfitability, getTaxReport
} from "@/services/report.service";
import type { PLData } from '@/types/reports.types';
import {
  CheckCircle, XCircle, AlertTriangle, FileText, Wallet, TrendingUp, TrendingDown,
  Landmark, Clock, BarChart3, ShieldCheck, ArrowRight, RefreshCw
} from "lucide-react";
import Link from "next/link";

const f = (n: number) => new Intl.NumberFormat("en-PK", {
  style: "currency", currency: "PKR", minimumFractionDigits: 0, maximumFractionDigits: 0
}).format(n || 0);

// ==========================================
// MINI CHARTS
// ==========================================
function ReconciliationBar({ matched, total, name }: { matched: number; total: number; name: string }) {
  const pct = total > 0 ? Math.round((matched / total) * 100) : 0;
  const color = pct === 100 ? '#22c55e' : pct >= 70 ? '#f59e0b' : '#ef4444';
  return (
    <div className="flex items-center justify-between p-3 rounded-lg bg-gray-50 dark:bg-gray-800/50">
      <div className="flex items-center gap-3 min-w-0">
        <Landmark className="w-4 h-4 text-gray-400 flex-shrink-0" />
        <div>
          <p className="font-medium text-sm text-gray-800 dark:text-white truncate">{name}</p>
        </div>
      </div>
      <div className="text-right flex-shrink-0 ml-3">
        <p className={`text-xs font-bold px-2.5 py-1 rounded-full ${pct === 100 ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' : pct >= 70 ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400' : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'}`}>
          {pct}% Matched
        </p>
      </div>
    </div>
  );
}

function PLBreakdownCard() {
  const { data: pl, isLoading } = useQuery({
    queryKey: ['cfo-pl'],
    queryFn: () => getProfitAndLoss(),
    staleTime: 60000,
  });

  const totalRev = pl?.revenue?.reduce((s, a) => s + a.total, 0) || 0;
  const totalExp = (pl?.cost_of_sales?.reduce((s, a) => s + a.total, 0) || 0) + (pl?.operating_expenses?.reduce((s, a) => s + a.total, 0) || 0);
  const netPL = totalRev - totalExp;

  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-5">
      <h3 className="font-bold text-sm text-gray-900 dark:text-white mb-4">Current Period P&L Summary</h3>
      {isLoading ? (
        <div className="flex items-center justify-center py-8"><RefreshCw className="w-5 h-5 text-blue-500 animate-spin" /></div>
      ) : (
        <div className="space-y-3">
          <div className="flex justify-between items-center">
            <span className="text-sm text-gray-600 dark:text-gray-400">Total Revenue</span>
            <span className="text-sm font-mono font-bold text-green-600">{f(totalRev)}</span>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-sm text-gray-600 dark:text-gray-400">Total Expenses</span>
            <span className="text-sm font-mono font-bold text-red-600">{f(totalExp)}</span>
          </div>
          <div className="border-t border-gray-200 dark:border-gray-700 pt-3 mt-3">
            <div className="flex justify-between items-center">
              <span className="text-sm font-bold text-gray-900 dark:text-white">Net Profit / (Loss)</span>
              <span className={`text-lg font-bold font-mono ${netPL >= 0 ? 'text-green-600' : 'text-red-600'}`}>{f(netPL)}</span>
            </div>
          </div>
          {pl?.revenue?.length === 0 && pl?.operating_expenses?.length === 0 && (
            <p className="text-xs text-gray-400 text-center py-2">No posted entries this period</p>
          )}
        </div>
      )}
    </div>
  );
}

// ==========================================
// RECONCILIATION DATA HOOK (replaces Math.random)
// ==========================================
function useReconciliationStatus() {
  return useQuery({
    queryKey: ['cfo-reconciliation-status'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('unreconciled_summary');
      if (error) throw new Error(error.message);
      // Returns array of { account_id, account_name, unreconciled_count, unreconciled_amount }
      return (data || []) as Array<{ account_id: string; account_name: string; unreconciled_count: number; unreconciled_amount: number }>;
    },
    staleTime: 30000,
  });
}

// ==========================================
// MAIN CFO DASHBOARD
// ==========================================
export function CFODashboard() {
  const { isDark } = useTheme();

  // Reconciliation data (direct query for real-time status)
  const { data: financialAccounts, isLoading: faLoading } = useQuery({
    queryKey: ['cfo-financial-accounts'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('financial_accounts')
        .select('id, account_name, institution_type, currency, masked_identifier, opening_balance, is_active')
        .eq('is_active', true)
        .order('account_name');
      if (error) throw new Error(error.message);
      return data || [];
    },
  });

  // ✅ FIXED: Uses real reconciliation data from RPC, not Math.random()
  const { data: reconStatus } = useReconciliationStatus();

  // Pending journals
  const { data: pendingJournals } = useQuery({
    queryKey: ['cfo-pending-journals'],
    queryFn: async () => {
      const { count } = await supabase
        .from('journal_entries')
        .select('id', { count: 'exact', head: true })
        .in('status', ['DRAFT', 'SUBMITTED', 'VERIFIED']);
      return count || 0;
    },
    refetchInterval: 15000,
  });

  // Pending approvals (invoices + bills)
  const { data: pendingApprovals } = useQuery({
    queryKey: ['cfo-pending-approvals'],
    queryFn: async () => {
      const [invRes, billRes] = await Promise.all([
        supabase.from('invoices').select('id, invoice_number, total_amount, client_name, due_date, status').in('status', ['SUBMITTED', 'VERIFIED']).order('due_date'),
        supabase.from('vendor_bills').select('id, bill_number, total_amount, vendor_name, due_date, status').in('status', ['SUBMITTED', 'VERIFIED']).order('due_date'),
      ]);
      return [
        ...(invRes.data || []).map((i: any) => ({ ...i, source_type: 'INVOICE' })),
        ...(billRes.data || []).map((b: any) => ({ ...b, source_type: 'VENDOR_BILL' })),
      ];
    },
    refetchInterval: 15000,
  });

  // Aging summary
  const { data: aging } = useQuery({
    queryKey: ['cfo-aging'],
    queryFn: getAgingReport,
    staleTime: 30000,
  });

  // Period close status
  const { data: periods } = useQuery({
    queryKey: ['cfo-periods'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('accounting_periods')
        .select('id, name, start_date, end_date, status')
        .order('start_date');
      if (error) throw new Error(error.message);
      return data || [];
    },
  });

  // Reconciled count from reconciliation_summary RPC
  const { data: reconSummary } = useQuery({
    queryKey: ['cfo-recon-summary'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('reconciliation_summary');
      if (error) throw new Error(error.message);
      return data || [];
    },
    staleTime: 30000,
  });

  const totalCash = (financialAccounts || []).reduce((s, a) => s + (a.opening_balance || 0), 0);
  const totalReceivables = (aging?.receivable || []).reduce((s, a) => s + a.total, 0);
  const totalPayables = (aging?.payable || []).reduce((s, a) => s + a.total, 0);
  const highRiskRecv = (aging?.receivable || []).filter(a => a.overdue_over_90 > 0).length || 0;
  const highRiskPay = (aging?.payable || []).filter(a => a.overdue_over_90 > 0).length || 0;
  const openPeriods = (periods || []).filter(p => p.status === 'OPEN').length || 0;
  const softClosedPeriods = (periods || []).filter(p => p.status === 'SOFT_CLOSED').length || 0;
  const hasRisks = highRiskRecv > 0 || highRiskPay > 0 || openPeriods > 1;

  // ✅ FIXED: Real reconciliation counts from RPC data
  const totalReconAccounts = (reconSummary || []).length || 0;
  const fullyReconciledAccounts = (reconSummary || []).filter((r: any) => r.reconciliation_pct === 100).length || 0;

  // ✅ FIXED: Build a lookup map from unreconciled_summary for per-account match %
  const reconLookup = new Map<string, number>();
  (reconStatus || []).forEach((r: any) => {
    // If no unreconciled items, it's 100% reconciled
    reconLookup.set(r.account_id, r.unreconciled_count === 0 ? 100 : 0);
  });
  (reconSummary || []).forEach((r: any) => {
    reconLookup.set(r.financial_account_id, Math.round(r.reconciliation_pct || 0));
  });

  return (
    <div className={`space-y-5 p-6 max-w-[1500px] mx-auto transition-colors duration-300 ${isDark ? 'bg-gray-950' : 'bg-gray-50'}`}>

      {/* Header */}
      <div className={`relative h-40 rounded-2xl overflow-hidden shadow-2xl flex items-center p-8 border ${isDark ? 'bg-gradient-to-r from-slate-900 via-purple-950 to-slate-900 border-gray-800' : 'bg-gradient-to-r from-purple-600 via-indigo-600 to-purple-700 border-purple-400'}`}>
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_80%_50%,rgba(255,255,255,0.1),transparent_50%)]" />
        <div className="relative z-10">
          <span className="text-xs font-bold uppercase tracking-widest text-purple-200">CFO Finance Portal</span>
          <h1 className="text-3xl font-extrabold text-white mt-1">Finance Control Center</h1>
          <p className="text-purple-200 mt-1 text-sm">Accounting integrity, reconciliation, and fiscal control</p>
        </div>
      </div>

      {/* Risk Alerts */}
      {hasRisks && (
        <div className="flex flex-wrap gap-2 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/30 rounded-xl">
          {highRiskRecv > 0 && <span className="text-xs font-medium bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400 px-2.5 py-1 rounded-full">{highRiskRecv} High Risk Receivables</span>}
          {highRiskPay > 0 && <span className="text-xs font-medium bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 px-2.5 py-1 rounded-full">{highRiskPay} High Risk Payables</span>}
          {openPeriods > 1 && <span className="text-xs font-medium bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400 px-2.5 py-1 rounded-full">{openPeriods} Open Periods</span>}
        </div>
      )}

      {/* KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-4">
          <div className="flex items-center gap-2 mb-2"><div className="p-1.5 rounded-lg bg-emerald-50 dark:bg-emerald-900/20"><Wallet className="w-4 h-4 text-emerald-600" /></div><span className="text-[10px] uppercase text-gray-500">Cash Position</span></div>
          <p className="text-xl font-bold text-gray-900 dark:text-white">{f(totalCash)}</p>
        </div>
        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-4">
          <div className="flex items-center gap-2 mb-2"><div className="p-1.5 rounded-lg bg-amber-50 dark:bg-amber-900/20"><AlertTriangle className="w-4 h-4 text-amber-600" /></div><span className="text-[10px] uppercase text-gray-500">Receivables</span></div>
          <p className="text-xl font-bold text-amber-600">{f(totalReceivables)}</p>
        </div>
        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-4">
          <div className="flex items-center gap-2 mb-2"><div className="p-1.5 rounded-lg bg-red-50 dark:bg-red-900/20"><XCircle className="w-4 h-4 text-red-600" /></div><span className="text-[10px] uppercase text-gray-500">Payables</span></div>
          <p className="text-xl font-bold text-red-600">{f(totalPayables)}</p>
        </div>
        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-4">
          <div className="flex items-center gap-2 mb-2"><div className="p-1.5 rounded-lg bg-blue-50 dark:bg-blue-900/20"><FileText className="w-4 h-4 text-blue-600" /></div><span className="text-[10px] uppercase text-gray-500">Pending Journals</span></div>
          <p className="text-xl font-bold text-blue-600">{pendingJournals || 0}</p>
        </div>
        {/* ✅ FIXED: Real reconciliation count from RPC, not hardcoded false */}
        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-4">
          <div className="flex items-center gap-2 mb-2"><div className="p-1.5 rounded-lg bg-green-50 dark:bg-green-900/20"><CheckCircle className="w-4 h-4 text-green-600" /></div><span className="text-[10px] uppercase text-gray-500">Reconciled</span></div>
          <p className="text-xl font-bold text-green-600">{fullyReconciledAccounts} / {totalReconAccounts}</p>
        </div>
        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-4">
          <div className="flex items-center gap-2 mb-2"><div className="p-1.5 rounded-lg bg-purple-50 dark:bg-purple-900/20"><Clock className="w-4 h-4 text-purple-600" /></div><span className="text-[10px] uppercase text-gray-500">Period Status</span></div>
          <p className="text-xl font-bold text-purple-600">{softClosedPeriods} Soft Closed</p>
        </div>
      </div>

      {/* Main Content */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">

        {/* Left: Reconciliation Status */}
        <div className="lg:col-span-2 space-y-5">
          <div className={`rounded-xl p-5 border ${isDark ? 'bg-gray-900/60 border-gray-800' : 'bg-white border-gray-200 shadow-sm'}`}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-bold text-sm text-gray-900 dark:text-white">Bank & Wallet Reconciliation</h3>
              <Link href="/dashboard/reconciliation" className="text-xs text-blue-600 hover:underline flex items-center gap-1">Manage <ArrowRight className="w-3 h-3" /></Link>
            </div>
            <div className="space-y-2 max-h-[320px] overflow-y-auto">
              {faLoading ? (
                <div className="flex justify-center py-8"><RefreshCw className="w-5 h-5 text-blue-500 animate-spin" /></div>
              ) : (financialAccounts || []).length === 0 ? (
                <p className="text-sm text-gray-400 text-center py-8">No financial accounts configured</p>
              ) : (financialAccounts || []).map((acc: any) => {
                // ✅ FIXED: Uses real reconciliation % from RPC, NOT Math.random()
                const matchedPct = reconLookup.get(acc.id) ?? 0;
                const totalLines = (reconSummary || []).find((r: any) => r.financial_account_id === acc.id)?.total_lines || 0;
                return (
                  <ReconciliationBar
                    matched={matchedPct}
                    total={totalLines || acc.opening_balance || 1}
                    name={`${acc.account_name} (${acc.institution_type})`}
                  />
                );
              })}
            </div>
          </div>

          {/* Pending Approvals */}
          <div className={`rounded-xl p-5 border ${isDark ? 'bg-gray-900/60 border-gray-800' : 'bg-white border-gray-200 shadow-sm'}`}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-bold text-sm text-gray-900 dark:text-white">Pending Approvals</h3>
              <span className="text-xs bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 px-2.5 py-1 rounded-full font-medium">
                {(pendingApprovals || []).length} Pending
              </span>
            </div>
            <div className="space-y-2 max-h-[280px] overflow-y-auto">
              {(pendingApprovals || []).length === 0 ? (
                <p className="text-sm text-gray-400 text-center py-6">All caught up! No pending approvals.</p>
              ) : (pendingApprovals || []).slice(0, 10).map((item: any) => (
                <div key={item.id} className="flex items-center justify-between p-2.5 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700/30 transition-colors">
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                      item.source_type === 'INVOICE' ? 'bg-blue-100 text-blue-700' : 'bg-orange-100 text-orange-700'
                    }`}>{item.source_type}</span>
                    <span className="text-xs text-gray-700 dark:text-gray-300 truncate">{item.invoice_number || item.bill_number}</span>
                    {item.client_name && <span className="text-[10px] text-gray-400">— {item.client_name || item.vendor_name}</span>}
                  </div>
                  <div className="text-right flex-shrink-0 ml-2">
                    <p className="text-sm font-semibold text-gray-900 dark:text-white">{f(item.total_amount)}</p>
                    {item.due_date && <p className="text-[10px] text-gray-400">Due: {new Date(item.due_date).toLocaleDateString('en-PK', { day: '2-digit', month: 'short' })}</p>}
                  </div>
                </div>
              ))}
            </div>
            {(pendingApprovals || []).length > 10 && (
              <p className="text-xs text-center text-blue-600 pt-2">+{(pendingApprovals || []).length - 10} more</p>
            )}
          </div>
        </div>

        {/* Right Column */}
        <div className="space-y-5">
          <PLBreakdownCard />

          {/* Fiscal Period Progress */}
          <div className={`rounded-xl p-5 border ${isDark ? 'bg-gray-900/60 border-gray-800' : 'bg-white border-gray-200 shadow-sm'}`}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-bold text-sm text-gray-900 dark:text-white">Fiscal Year Progress</h3>
              <Link href="/dashboard/settings/fiscal-year" className="text-xs text-blue-600 hover:underline flex items-center gap-1">Settings <ArrowRight className="w-3 h-3" /></Link>
            </div>
            <div className="space-y-2">
              {(periods || []).slice(-6).map((p: any) => {
                const statusColor = p.status === 'OPEN' ? '#22c55e' : p.status === 'SOFT_CLOSED' ? '#f59e0b' : '#9ca3af';
                const statusLabel = p.status === 'OPEN' ? 'Open' : p.status === 'SOFT_CLOSED' ? 'Soft Closed' : 'Hard Closed';
                return (
                  <div key={p.id} className="flex items-center gap-3">
                    <span className="text-[10px] text-gray-500 w-8 text-right">{p.name?.split('-')[1]?.trim() || '-'}</span>
                    <div className="flex-1 h-5 bg-gray-100 dark:bg-gray-700 rounded-full overflow-hidden relative">
                      <div className="absolute top-0 left-0 h-full bg-gray-300 dark:bg-gray-600" style={{ width: '100%' }} />
                      <div className="absolute top-0 h-full rounded-full" style={{ backgroundColor: statusColor }} />
                    </div>
                    <span className={`text-[10px] w-20 text-right ${p.status === 'OPEN' ? 'text-green-600 font-medium' : 'text-gray-500'}`}>{statusLabel}</span>
                  </div>
                );
              })}
            </div>
            <div className="flex gap-3 mt-3 text-[10px]">
              <span className="flex items-center gap-1"><div className="w-2 h-2 rounded-full" style={{ backgroundColor: '#22c55e' }} /> Open</span>
              <span className="flex items-center gap-1"><div className="w-2 h-2 rounded-full" style={{ backgroundColor: '#f59e0b' }} /> Soft Closed</span>
              <span className="flex items-center gap-1"><div className="w-2 h-2 rounded-full" style={{ backgroundColor: '#9ca3af' }} /> Hard Closed</span>
            </div>
          </div>

          {/* Quick Links */}
          <div className={`rounded-xl p-5 border ${isDark ? 'bg-gray-900/60 border-gray-800' : 'bg-white border-gray-200 shadow-sm'}`}>
            <h3 className="font-bold text-sm text-gray-900 dark:text-white mb-4">Quick Actions</h3>
            <div className="space-y-2">
              {[
                { label: 'Financial Statements', href: '/dashboard/reports', icon: BarChart3, color: 'text-blue-600 bg-blue-50 dark:bg-blue-900/20' },
                { label: 'Aging Reports', href: '/dashboard/reports/aging', icon: Clock, color: 'text-orange-600 bg-orange-50 dark:bg-orange-900/20' },
                { label: 'Project Profitability', href: '/dashboard/reports/project-profitability', icon: TrendingUp, color: 'text-purple-600 bg-purple-50 dark:bg-purple-900/20' },
                { label: 'Tax Report', href: '/dashboard/reports/tax', icon: ShieldCheck, color: 'text-emerald-600 bg-emerald-50 dark:bg-emerald-900/20' },
                { label: 'Journal Entries', href: '/dashboard/journal-entries', icon: FileText, color: 'text-gray-600 bg-gray-100 dark:bg-gray-700' },
              ].map((link, i) => (
                <Link key={i} href={link.href} className="flex items-center gap-3 p-2.5 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700/30 transition-colors">
                  <div className={`p-2 rounded-lg ${link.color}`}><link.icon className="w-4 h-4" /></div>
                  <span className="text-sm text-gray-700 dark:text-gray-300">{link.label}</span>
                </Link>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
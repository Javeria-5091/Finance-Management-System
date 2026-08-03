'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getTaxReport } from '@/services/report.service';
import { ShieldCheck, AlertTriangle, FileText, Calculator, ArrowRight, CheckCircle2, Circle } from 'lucide-react';
import type { TaxReportData } from '@/types/reports.types';

const f = (n: number) => new Intl.NumberFormat('en-PK', { style: 'currency', currency: 'PKR', minimumFractionDigits: 0 }).format(n || 0);

// ==========================================
// WATERFALL CHART
// ==========================================
function TaxWaterfall({ data }: { data: { label: string; value: number; color: string; isTotal?: boolean }[] }) {
  const max = Math.max(...data.map(d => Math.abs(d.value)), 1);
  let cum = 0;
  const running: number[] = [];

  for (const d of data) {
    cum += d.value;
    running.push(cum);
  }

  return (
    <div className="space-y-2">
      {data.map((d, i) => {
        const widthPct = (Math.abs(d.value) / max) * 100;
        const offset = i === 0 ? 0 : Math.max(running[i - 1], 0);
        return (
          <div key={i} className="flex items-center gap-3">
            <span className={`text-[11px] w-36 text-right flex-shrink-0 ${d.isTotal ? 'font-bold text-gray-900 dark:text-white' : 'text-gray-600 dark:text-gray-400'}`}>{d.label}</span>
            <div className="flex-1 h-7 bg-gray-100 dark:bg-gray-700 rounded-lg overflow-hidden relative">
              {offset > 0 && <div className="absolute left-0 top-0 h-full bg-white dark:bg-gray-800" style={{ width: `${(offset / max) * 100}%` }} />}
              <div className="absolute top-0 h-full rounded-lg transition-all" style={{ left: `${(offset / max) * 100}%`, width: `${widthPct}%`, backgroundColor: d.color }} />
            </div>
            <span className={`text-[11px] font-mono w-24 text-right flex-shrink-0 ${d.isTotal ? 'font-bold text-gray-900 dark:text-white' : 'text-gray-600 dark:text-gray-400'}`}>
              {d.isTotal ? f(d.value) : (d.value > 0 ? `+${f(d.value)}` : f(d.value))}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ==========================================
// STATUS STEP
// ==========================================
const TAX_STEPS = [
  { key: 'calculated', label: 'Estimated' },
  { key: 'reviewed', label: 'Under Review' },
  { key: 'approved', label: 'Approved' },
  { key: 'filed', label: 'Filed' },
  { key: 'paid', label: 'Paid' },
];

function TaxStatusTimeline({ currentStep }: { currentStep: string }) {
  const currentIdx = TAX_STEPS.findIndex(s => s.key === currentStep);

  return (
    <div className="flex items-center gap-0">
      {TAX_STEPS.map((s, i) => {
        const isCompleted = i < currentIdx;
        const isCurrent = i === currentIdx;
        return (
          <div key={s.key} className="flex items-center">
            <div className="flex flex-col items-center gap-1">
              <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold ${
                isCompleted ? 'bg-green-500 text-white' : isCurrent ? 'bg-blue-500 text-white ring-4 ring-blue-500/20' : 'bg-gray-200 dark:bg-gray-700 text-gray-400'
              }`}>
                {isCompleted ? <CheckCircle2 className="w-4 h-4" /> : <Circle className="w-3 h-3" />}
              </div>
              <span className={`text-[9px] whitespace-nowrap ${isCurrent ? 'font-bold text-blue-600' : isCompleted ? 'text-green-600' : 'text-gray-400'}`}>{s.label}</span>
            </div>
            {i < TAX_STEPS.length - 1 && <div className={`w-6 h-0.5 mx-0.5 mt-[-12px] ${i < currentIdx ? 'bg-green-400' : 'bg-gray-200 dark:bg-gray-700'}`} />}
          </div>
        );
      })}
    </div>
  );
}

// ==========================================
// MAIN PAGE
// ==========================================
export default function TaxReportPage() {
  const [taxYear, setTaxYear] = useState('');
  const { data: tax, isLoading } = useQuery({
    queryKey: ['tax-report', taxYear],
    queryFn: () => getTaxReport(taxYear || undefined),
  });

  const isRefund = (tax?.net_tax_refund || 0) > 0;

  const waterfallData = tax ? [
    { label: 'Profit Before Tax', value: tax.profit_before_tax, color: '#3b82f6' },
    { label: 'WHT/Advance Credits', value: tax.adjustable_wht_credits, color: '#22c55e' },
    { label: 'Gross Tax', value: tax.gross_estimated_tax, color: '#ef4444' },
    { label: 'Net Tax Payable', value: tax.net_tax_payable, color: '#dc2626', isTotal: true },
  ] : [];

  const patWaterfall = tax ? [
    { label: 'Profit Before Tax', value: tax.profit_before_tax, color: '#3b82f6' },
    { label: 'Tax Payable', value: -tax.net_tax_payable, color: '#ef4444' },
    { label: 'Tax Refund', value: tax.net_tax_refund, color: '#22c55e' },
    { label: 'Profit After Tax', value: tax.profit_after_tax, color: '#16a34a', isTotal: true },
  ] : [];

  return (
    <div className="p-6 max-w-[1400px] mx-auto space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-900 dark:text-white flex items-center gap-3">
            <Calculator className="w-7 h-7 text-purple-600" /> Tax Reconciliation & Return Support
          </h2>
          <p className="text-sm text-gray-500">Document Section 5.12.1 — Accounting Profit ≠ Taxable Income</p>
        </div>
      </div>

      {/* Document Warning */}
      <div className="bg-amber-50 dark:bg-amber-900/10 border border-amber-200 dark:border-amber-800/30 rounded-xl p-4 text-xs text-amber-700 dark:text-amber-400">
        <div className="flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <div>
            <p className="font-bold mb-1">Important — Per Document Specification:</p>
            <ul className="list-disc list-inside space-y-0.5">
              <li>Every recorded expense is NOT automatically tax-deductible</li>
              <li>AI-generated tax answers cannot be the legal basis for a return</li>
              <li>This system prepares and tracks the return package — it does NOT autonomously file</li>
              <li>A qualified accountant/tax adviser must file through the applicable official process</li>
            </ul>
          </div>
        </div>
      </div>

      {isLoading && <div className="flex justify-center py-20"><div className="w-8 h-8 border-4 border-purple-600 border-t-transparent rounded-full animate-spin" /></div>}

      {tax && !isLoading && (
        <>
          {/* Status Timeline */}
          <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-5">
            <h4 className="text-xs font-bold uppercase text-gray-500 mb-4">Return Status</h4>
            <TaxStatusTimeline currentStep="calculated" />
            <p className="text-[10px] text-gray-400 mt-3">Status: <span className="font-medium text-blue-600">Estimated</span> — Awaiting accountant review</p>
          </div>

          {/* KPI Cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3">
            <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-4">
              <p className="text-[10px] uppercase text-gray-500 mb-1">Profit Before Tax</p>
              <p className="text-lg font-bold text-blue-600">{f(tax.profit_before_tax)}</p>
            </div>
            <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-4">
              <p className="text-[10px] uppercase text-gray-500 mb-1">Taxable Income</p>
              <p className="text-lg font-bold text-gray-900 dark:text-white">{f(tax.taxable_income)}</p>
            </div>
            <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-4">
              <p className="text-[10px] uppercase text-gray-500 mb-1">Gross Tax</p>
              <p className="text-lg font-bold text-red-600">{f(tax.gross_estimated_tax)}</p>
            </div>
            <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-4">
              <p className="text-[10px] uppercase text-gray-500 mb-1">WHT Credits</p>
              <p className="text-lg font-bold text-green-600">{f(tax.adjustable_wht_credits)}</p>
            </div>
            <div className={`bg-white dark:bg-gray-800 border-2 rounded-xl p-4 ${isRefund ? 'border-green-500' : 'border-red-500'}`}>
              <p className="text-[10px] uppercase text-gray-500 mb-1">{isRefund ? 'Net Refund' : 'Net Payable'}</p>
              <p className={`text-lg font-bold ${isRefund ? 'text-green-600' : 'text-red-600'}`}>{f(isRefund ? tax.net_tax_refund : tax.net_tax_payable)}</p>
            </div>
            <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-4">
              <p className="text-[10px] uppercase text-gray-500 mb-1">Profit After Tax</p>
              <p className={`text-lg font-bold ${tax.profit_after_tax >= 0 ? 'text-green-600' : 'text-red-600'}`}>{f(tax.profit_after_tax)}</p>
            </div>
            <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-4">
              <p className="text-[10px] uppercase text-gray-500 mb-1">Eff. Tax Rate</p>
              <p className="text-lg font-bold text-purple-600">{tax.effective_tax_rate}%</p>
            </div>
          </div>

          {/* Tax Reconciliation Waterfall */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-5">
              <h4 className="text-xs font-bold uppercase text-gray-500 mb-4">Tax Calculation Waterfall</h4>
              <TaxWaterfall data={waterfallData} />
            </div>
            <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-5">
              <h4 className="text-xs font-bold uppercase text-gray-500 mb-4">Profit After Tax Bridge</h4>
              <TaxWaterfall data={patWaterfall} />
            </div>
          </div>

          {/* P&L Breakdown + Tax Components */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-5">
              <h4 className="text-xs font-bold uppercase text-gray-500 mb-4">P&L Contributing to PBT</h4>
              <div className="space-y-2">
                {tax.pnl_breakdown.map((item:any, i:any) => (
                  <div key={i} className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div className={`w-2.5 h-2.5 rounded-sm ${item.total >= 0 ? 'bg-green-500' : 'bg-red-500'}`} />
                      <span className="text-xs text-gray-700 dark:text-gray-300">{item.section}</span>
                    </div>
                    <span className={`text-xs font-mono font-medium ${item.total >= 0 ? 'text-green-600' : 'text-red-600'}`}>{item.total >= 0 ? '+' : ''}{f(item.total)}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-5">
              <h4 className="text-xs font-bold uppercase text-gray-500 mb-4">Tax Components (GL Accounts)</h4>
              <div className="space-y-2">
                {tax.components.map((comp:any, i:any) => (
                  <div key={i} className="flex items-center justify-between p-2 bg-gray-50 dark:bg-gray-900/30 rounded-lg">
                    <div>
                      <span className="text-[10px] font-mono text-gray-400">{comp.code}</span>
                      <p className="text-xs text-gray-700 dark:text-gray-300">{comp.account_name}</p>
                    </div>
                    <span className={`text-xs font-mono font-bold ${
                      comp.component_type === 'WHT/Advance Tax Credits' ? 'text-green-600' : 'text-red-600'
                    }`}>{f(comp.amount)}</span>
                  </div>
                ))}
                {tax.components.length === 0 && <p className="text-xs text-gray-400 text-center py-4">No tax entries posted yet</p>}
              </div>
            </div>
          </div>

          {/* Bottom Summary */}
          <div className={`rounded-xl p-5 flex items-center gap-4 ${
            isRefund ? 'bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800/30' :
            'bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/30'
          }`}>
            {isRefund ? (
              <ShieldCheck className="w-6 h-6 text-green-600 flex-shrink-0" />
            ) : (
              <AlertTriangle className="w-6 h-6 text-red-600 flex-shrink-0" />
            )}
            <div>
              <p className={`font-bold text-sm ${isRefund ? 'text-green-700 dark:text-green-400' : 'text-red-700 dark:text-red-400'}`}>
                {isRefund ? `Net Tax Refund: ${f(tax.net_tax_refund)}` : `Net Tax Payable: ${f(tax.net_tax_payable)}`}
              </p>
              <p className="text-xs text-gray-500 mt-0.5">
                Effective rate: {tax.effective_tax_rate}% on PBT of {f(tax.profit_before_tax)}
              </p>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
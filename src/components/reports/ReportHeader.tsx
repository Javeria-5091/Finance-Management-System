"use client";

import { Building2, CalendarDays, Coins, Clock, Filter, ShieldCheck } from "lucide-react";

export interface ReportHeaderProps {
  /** Organization name */
  organization?: string;
  /** Accounting basis e.g. "Accrual Basis" */
  basis?: string;
  /** Period label e.g. "Jul 2025 - Jun 2026" */
  period?: string;
  /** Currency code e.g. "PKR" */
  currency?: string;
  /** ISO timestamp when data was last refreshed */
  dataAsOf?: string;
  /** Active filter summary */
  filters?: { label: string; value: string }[];
  /** Whether this report reconciles to the GL */
  reconciled?: boolean;
  /** Report title */
  title: string;
  /** Report subtitle/description */
  subtitle?: string;
  /** Extra actions slot (export buttons etc) */
  actions?: React.ReactNode;
}

export default function ReportHeader({
  organization = "OSYSTIC",
  basis = "Accrual Basis",
  period,
  currency = "PKR",
  dataAsOf,
  filters = [],
  reconciled = true,
  title,
  subtitle,
  actions,
}: ReportHeaderProps) {
  return (
    <div className="space-y-4">
      {/* Title Row */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h2 className="text-2xl font-bold text-gray-900 dark:text-white tracking-tight">
            {title}
          </h2>
          {subtitle && (
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
              {subtitle}
            </p>
          )}
        </div>
        {actions && <div className="flex items-center gap-2 flex-shrink-0">{actions}</div>}
      </div>

      {/* Spec 13.3 Metadata Bar */}
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl px-5 py-3">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs">
          <div className="flex items-center gap-1.5 text-gray-600 dark:text-gray-400">
            <Building2 className="w-3.5 h-3.5" />
            <span className="font-medium text-gray-900 dark:text-white">{organization}</span>
          </div>
          <div className="flex items-center gap-1.5 text-gray-600 dark:text-gray-400">
            <ShieldCheck className="w-3.5 h-3.5" />
            <span>{basis}</span>
          </div>
          {period && (
            <div className="flex items-center gap-1.5 text-gray-600 dark:text-gray-400">
              <CalendarDays className="w-3.5 h-3.5" />
              <span>{period}</span>
            </div>
          )}
          <div className="flex items-center gap-1.5 text-gray-600 dark:text-gray-400">
            <Coins className="w-3.5 h-3.5" />
            <span>{currency}</span>
          </div>
          {dataAsOf && (
            <div className="flex items-center gap-1.5 text-gray-600 dark:text-gray-400">
              <Clock className="w-3.5 h-3.5" />
              <span>Data as of {new Date(dataAsOf).toLocaleString("en-PK", { dateStyle: "medium", timeStyle: "short" })}</span>
            </div>
          )}
          {reconciled && (
            <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">
              <ShieldCheck className="w-3 h-3" /> Reconciled to GL
            </span>
          )}
          {!reconciled && (
            <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
              Operational / Forecast
            </span>
          )}
        </div>

        {/* Active Filters */}
        {filters.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 mt-2.5 pt-2.5 border-t border-gray-100 dark:border-gray-700">
            <Filter className="w-3 h-3 text-gray-400" />
            <span className="text-[10px] uppercase text-gray-400 font-bold tracking-wider">Filters:</span>
            {filters.map((f, i) => (
              <span
                key={i}
                className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-md bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300"
              >
                <span className="text-gray-400">{f.label}:</span> {f.value}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
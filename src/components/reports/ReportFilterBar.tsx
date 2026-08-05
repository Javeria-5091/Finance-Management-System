"use client";

import { useState } from "react";
import { CalendarDays, Coins, Search, RotateCcw, ChevronDown } from "lucide-react";

export interface FilterOption {
  value: string;
  label: string;
}

export interface ReportFilterBarProps {
  /** Show date range filter */
  showDateRange?: boolean;
  /** Show fiscal year selector */
  showFiscalYear?: boolean;
  /** Show currency selector */
  showCurrency?: boolean;
  /** Show comparison toggle (prior period / budget) */
  showComparison?: boolean;
  /** Show account/project/client filter */
  showEntityFilter?: boolean;
  /** Entity filter label */
  entityLabel?: string;
  /** Entity filter options */
  entityOptions?: FilterOption[];
  /** Fiscal year options */
  fiscalYearOptions?: FilterOption[];
  /** Currency options */
  currencyOptions?: FilterOption[];
  /** Comparison options */
  comparisonOptions?: FilterOption[];
  /** Initial values */
  defaultValues?: {
    startDate?: string;
    endDate?: string;
    fiscalYear?: string;
    currency?: string;
    comparison?: string;
    entity?: string;
  };
  /** Callback when filters change */
  onApply?: (filters: {
    startDate?: string;
    endDate?: string;
    fiscalYear?: string;
    currency?: string;
    comparison?: string;
    entity?: string;
  }) => void;
  /** Loading state */
  isLoading?: boolean;
}

export default function ReportFilterBar({
  showDateRange = true,
  showFiscalYear = false,
  showCurrency = false,
  showComparison = false,
  showEntityFilter = false,
  entityLabel = "Entity",
  entityOptions = [],
  fiscalYearOptions = [],
  currencyOptions = [
    { value: "PKR", label: "PKR (Consolidated)" },
    { value: "USD", label: "USD" },
    { value: "EUR", label: "EUR" },
    { value: "GBP", label: "GBP" },
    { value: "SAR", label: "SAR" },
  ],
  comparisonOptions = [
    { value: "none", label: "No Comparison" },
    { value: "prior_period", label: "Prior Period" },
    { value: "prior_year", label: "Prior Year" },
    { value: "budget", label: "Budget" },
  ],
  defaultValues = {},
  onApply,
  isLoading = false,
}: ReportFilterBarProps) {
  const [startDate, setStartDate] = useState(defaultValues.startDate || "");
  const [endDate, setEndDate] = useState(defaultValues.endDate || "");
  const [fiscalYear, setFiscalYear] = useState(defaultValues.fiscalYear || "");
  const [currency, setCurrency] = useState(defaultValues.currency || "PKR");
  const [comparison, setComparison] = useState(defaultValues.comparison || "none");
  const [entity, setEntity] = useState(defaultValues.entity || "");

  const handleApply = () => {
    onApply?.({
      startDate: startDate || undefined,
      endDate: endDate || undefined,
      fiscalYear: fiscalYear || undefined,
      currency: currency || undefined,
      comparison: comparison !== "none" ? comparison : undefined,
      entity: entity || undefined,
    });
  };

  const handleReset = () => {
    setStartDate(defaultValues.startDate || "");
    setEndDate(defaultValues.endDate || "");
    setFiscalYear(defaultValues.fiscalYear || "");
    setCurrency(defaultValues.currency || "PKR");
    setComparison(defaultValues.comparison || "none");
    setEntity(defaultValues.entity || "");
    onApply?.({
      startDate: defaultValues.startDate,
      endDate: defaultValues.endDate,
      fiscalYear: defaultValues.fiscalYear,
      currency: defaultValues.currency || "PKR",
      comparison: defaultValues.comparison,
      entity: defaultValues.entity,
    });
  };

  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-4">
      <div className="flex flex-wrap items-end gap-3">
        {showDateRange && (
          <>
            <FilterField label="From">
              <div className="relative">
                <CalendarDays className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
                <input
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  className="w-full pl-8 pr-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg dark:bg-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all"
                />
              </div>
            </FilterField>
            <FilterField label="To">
              <div className="relative">
                <CalendarDays className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
                <input
                  type="date"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  className="w-full pl-8 pr-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg dark:bg-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all"
                />
              </div>
            </FilterField>
          </>
        )}

        {showFiscalYear && fiscalYearOptions.length > 0 && (
          <FilterField label="Fiscal Year">
            <select
              value={fiscalYear}
              onChange={(e) => setFiscalYear(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg dark:bg-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none appearance-none pr-8 bg-[url('data:image/svg+xml;charset=UTF-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2212%22%20height%3D%2212%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22%239ca3af%22%20stroke-width%3D%222%22%3E%3Cpolyline%20points%3D%226%209%2012%2015%2018%209%22%3E%3C%2Fpolyline%3E%3C%2Fsvg%3E')] bg-no-repeat bg-[position:right_8px_center]"
            >
              <option value="">All Periods</option>
              {fiscalYearOptions.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </FilterField>
        )}

        {showCurrency && (
          <FilterField label="Currency">
            <div className="relative">
              <Coins className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
              <select
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
                className="w-full pl-8 pr-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg dark:bg-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none appearance-none pr-8 bg-[url('data:image/svg+xml;charset=UTF-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2212%22%20height%3D%2212%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22%239ca3af%22%20stroke-width%3D%222%22%3E%3Cpolyline%20points%3D%226%209%2012%2015%2018%209%22%3E%3C%2Fpolyline%3E%3C%2Fsvg%3E')] bg-no-repeat bg-[position:right_8px_center]"
              >
                {currencyOptions.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
          </FilterField>
        )}

        {showComparison && (
          <FilterField label="Compare With">
            <select
              value={comparison}
              onChange={(e) => setComparison(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg dark:bg-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none appearance-none pr-8 bg-[url('data:image/svg+xml;charset=UTF-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2212%22%20height%3D%2212%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22%239ca3af%22%20stroke-width%3D%222%22%3E%3Cpolyline%20points%3D%226%209%2012%2015%2018%209%22%3E%3C%2Fpolyline%3E%3C%2Fsvg%3E')] bg-no-repeat bg-[position:right_8px_center]"
            >
              {comparisonOptions.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </FilterField>
        )}

        {showEntityFilter && entityOptions.length > 0 && (
          <FilterField label={entityLabel}>
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
              <select
                value={entity}
                onChange={(e) => setEntity(e.target.value)}
                className="w-full pl-8 pr-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg dark:bg-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none appearance-none pr-8 bg-[url('data:image/svg+xml;charset=UTF-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2212%22%20height%3D%2212%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22%239ca3af%22%20stroke-width%3D%222%22%3E%3Cpolyline%20points%3D%226%209%2012%2015%2018%209%22%3E%3C%2Fpolyline%3E%3C%2Fsvg%3E')] bg-no-repeat bg-[position:right_8px_center]"
              >
                <option value="">All</option>
                {entityOptions.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
          </FilterField>
        )}

        <div className="flex gap-2">
          <button
            onClick={handleApply}
            disabled={isLoading}
            className="px-5 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors shadow-sm"
          >
            {isLoading ? (
              <span className="flex items-center gap-2">
                <RotateCcw className="w-3.5 h-3.5 animate-spin" /> Loading…
              </span>
            ) : (
              "Generate"
            )}
          </button>
          <button
            onClick={handleReset}
            className="px-3 py-2 bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 rounded-lg text-sm hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}

function FilterField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-[160px]">
      <label className="block text-[10px] uppercase tracking-wider font-bold text-gray-500 dark:text-gray-400 mb-1.5">
        {label}
      </label>
      {children}
    </div>
  );
}
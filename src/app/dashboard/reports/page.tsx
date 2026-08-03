"use client";
import Link from "next/link";
import { BarChart3, FileText, Clock, Target, Calculator, List, CheckCircle, TrendingUp, ArrowRight } from "lucide-react";
import { usePermissions } from "@/context/PermissionContext";

/* ═══════════════════════════════════════════════════════
   Reports Landing Page — CEO Spec v1.3
   All formal & management reports in one place
   ═══════════════════════════════════════════════════════ */

interface ReportCard {
  id: string;
  title: string;
  description: string;
  href: string;
  icon: any;
  perm: string;
  tag?: string;
  tagColor?: string;
}

const reportCards: ReportCard[] = [
  {
    id: "financial-statements",
    title: "Financial Statements",
    description: "Profit & Loss, Balance Sheet, Cash Flow, and Statement of Changes in Equity",
    href: "/dashboard/reports/financial-statments",
    icon: FileText,
    perm: "REPORT_READ",
    tag: "Core",
    tagColor: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
  },
  {
    id: "general-ledger",
    title: "General Ledger",
    description: "Detailed transaction history for any ledger account with running balances",
    href: "/dashboard/reports/general-ledger",
    icon: List,
    perm: "REPORT_READ",
    tag: "Core",
    tagColor: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
  },
  {
    id: "trial-balance",
    title: "Trial Balance",
    description: "Account-wise debit/credit totals and net balances for any accounting period",
    href: "/dashboard/reports/trial-balance",
    icon: CheckCircle,
    perm: "REPORT_READ",
    tag: "Core",
    tagColor: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
  },
  {
    id: "aging-reports",
    title: "Aging Reports",
    description: "Receivable & payable aging by client/vendor, currency, and overdue bucket",
    href: "/dashboard/reports/aging-reports",
    icon: Clock,
    perm: "REPORT_READ",
    tag: "AR/AP",
    tagColor: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  },
  {
    id: "project-profitability",
    title: "Project Profitability",
    description: "Revenue, costs, gross profit, margin, and budget variance per project",
    href: "/dashboard/reports/project-profitability",
    icon: Target,
    perm: "REPORT_READ",
    tag: "Projects",
    tagColor: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400",
  },
  {
    id: "tax-reports",
    title: "Tax Reports",
    description: "PBT, taxable income reconciliation, estimated tax, credits, and filing status",
    href: "/dashboard/reports/tax-reports",
    icon: Calculator,
    perm: "REPORT_READ",
    tag: "Tax",
    tagColor: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400",
  },
];

export default function ReportsLandingPage() {
  const { hasPermission, isLoading } = usePermissions();

  // Filter cards based on permission
  const visibleCards = isLoading
    ? reportCards
    : reportCards.filter((card) => hasPermission(card.perm));

  return (
    <div>
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-1">
          <BarChart3 className="w-6 h-6 text-blue-600 dark:text-blue-400" />
          <h2 className="text-2xl font-bold text-gray-900 dark:text-white">Reports</h2>
        </div>
        <p className="text-gray-500 dark:text-gray-400 text-sm ml-9">
          Formal financial statements, operational reports, and management analysis
        </p>
      </div>

      {/* Report Cards Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {visibleCards.map((card) => {
          const Icon = card.icon;
          return (
            <Link
              key={card.id}
              href={card.href}
              className="group bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-5 shadow-sm hover:shadow-md dark:hover:shadow-none hover:border-blue-300 dark:hover:border-blue-700 transition-all duration-200"
            >
              <div className="flex items-start justify-between mb-3">
                <div className="w-10 h-10 bg-blue-50 dark:bg-blue-900/30 rounded-lg flex items-center justify-center">
                  <Icon className="w-5 h-5 text-blue-600 dark:text-blue-400" />
                </div>
                {card.tag && (
                  <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded ${card.tagColor}`}>
                    {card.tag}
                  </span>
                )}
              </div>
              <h3 className="text-sm font-semibold text-gray-900 dark:text-white group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors">
                {card.title}
              </h3>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1.5 leading-relaxed">
                {card.description}
              </p>
              <div className="flex items-center gap-1 mt-3 text-xs text-blue-600 dark:text-blue-400 font-medium opacity-0 group-hover:opacity-100 transition-opacity">
                Open Report <ArrowRight size={12} />
              </div>
            </Link>
          );
        })}
      </div>

      {/* Info Banner */}
      <div className="mt-6 bg-amber-50 dark:bg-amber-900/10 border border-amber-200 dark:border-amber-800/30 rounded-xl p-4">
        <div className="flex items-start gap-3">
          <TrendingUp className="w-5 h-5 text-amber-600 dark:text-amber-400 mt-0.5 flex-shrink-0" />
          <div>
            <p className="text-sm font-medium text-amber-800 dark:text-amber-300">CEO Spec Compliance</p>
            <p className="text-xs text-amber-700 dark:text-amber-400 mt-1">
              Per CEO Spec v1.3 Section 13.2, every report must display organization, basis, period, currency, data-as-of timestamp, and filters. Reports must reconcile to the ledger or clearly state they are operational/forecast reports.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
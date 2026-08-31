"use client";
 
import Link from "next/link";
import { usePermissions } from "@/context/PermissionContext";
import {
  FileText, BookOpen, ScrollText, Receipt, FolderKanban,
  Landmark, PieChart, PiggyBank, CreditCard, Building2,
  CalendarDays, ShieldCheck, ArrowRight, BarChart3,
  DollarSign, TrendingUp, Calculator, FileSpreadsheet,
  ArrowLeftRight, Scale, Clock, AlertTriangle, Users,
  Coins, History, Repeat,
} from "lucide-react";
 
/* Reports Landing Page - CEO Spec v1.3 Section 13.2 */
 
interface ReportCard {
  id: string;
  title: string;
  description: string;
  href: string;
  icon: any;
  perm: string;
  reports?: string[];
}
 
interface ReportGroup {
  id: string;
  label: string;
  color: string;
  icon: any;
  cards: ReportCard[];
}
 
const COLOR_MAP: Record<string, string> = {
  blue:    "#3B82F6",
  amber:   "#F59E0B",
  emerald: "#10B981",
  cyan:    "#06B6D4",
  violet:  "#8B5CF6",
  orange:  "#F97316",
  teal:    "#14B8A6",
  purple:  "#A855F7",
  indigo:  "#6366F1",
  red:     "#EF4444",
  fuchsia: "#D946EF",
};
 
const reportGroups: ReportGroup[] = [
  {
    id: "financial-statements",
    label: "Financial Statements",
    color: "blue",
    icon: FileText,
    cards: [
      {
        id: "financial-statements",
        title: "Financial Statements",
        description: "P&L, Balance Sheet, Cash Flow, Statement of Changes in Equity",
        href: "/dashboard/reports/financial-statements",
        icon: BarChart3,
        perm: "REPORT_READ",
        reports: ["Profit & Loss", "Balance Sheet", "Cash Flow", "SOCE"],
      },
      {
        id: "general-ledger",
        title: "General Ledger",
        description: "Detailed transaction history with running balances per account",
        href: "/dashboard/reports/general-ledger",
        icon: BookOpen,
        perm: "GL_READ",
        reports: ["General Ledger"],
      },
      {
        id: "trial-balance",
        title: "Trial Balance",
        description: "Account-wise debit/credit totals with comparative periods",
        href: "/dashboard/reports/trial-balance",
        icon: Scale,
        perm: "GL_READ",
        reports: ["Trial Balance"],
      },
    ],
  },
  {
    id: "multi-currency-fx",
    label: "Multi-Currency and FX",
    color: "fuchsia",
    icon: Coins,
    cards: [
      {
        id: "general-ledger-multi-currency",
        title: "Original-Currency Ledgers",
        description: "Foreign-currency journal entries shown in their original currency alongside PKR and the applied rate",
        href: "/dashboard/reports/general-ledger-multi-currency",
        icon: Coins,
        perm: "GL_READ",
        reports: ["Original-Currency Ledgers"],
      },
      {
        id: "exchange-rate-history",
        title: "Manual-Rate History",
        description: "Full history of every exchange rate entered, who entered/approved it, and its evidence reference",
        href: "/dashboard/reports/exchange-rate-history",
        icon: History,
        perm: "GL_READ",
        reports: ["Manual-Rate History"],
      },
      {
        id: "pkr-conversion",
        title: "PKR Conversion",
        description: "Every foreign-currency amount converted to PKR, labeled by rate method and rate date/period",
        href: "/dashboard/reports/pkr-conversion",
        icon: Repeat,
        perm: "GL_READ",
        reports: ["PKR Conversion"],
      },
    ],
  },
  {
    id: "receivables-payables",
    label: "Receivables & Payables",
    color: "amber",
    icon: Receipt,
    cards: [
      {
        id: "aging-reports",
        title: "Aging Reports",
        description: "AR/AP aging by client/vendor, currency, and overdue bucket",
        href: "/dashboard/reports/aging-reports",
        icon: Clock,
        perm: "REPORT_READ",
        reports: ["AR Aging", "AP Aging", "Client Statements", "Vendor Statements", "Overdue & Expected Cash"],
      },
    ],
  },
  {
    id: "projects",
    label: "Projects",
    color: "emerald",
    icon: FolderKanban,
    cards: [
      {
        id: "project-profitability",
        title: "Project Profitability",
        description: "Revenue, costs, margins, budget vs actual, cost by category/user",
        href: "/dashboard/reports/project-profitability",
        icon: TrendingUp,
        perm: "REPORT_READ",
        reports: ["Profitability", "Margin", "Budget vs Actual", "Billed/Received/Outstanding", "Cost by Category/User"],
      },
    ],
  },
  {
    id: "cash-bank",
    label: "Cash & Bank",
    color: "cyan",
    icon: Landmark,
    cards: [
      {
        id: "cash-bank",
        title: "Cash & Bank Reports",
        description: "Account balances, reconciliation, transfers, fees, cash forecast",
        href: "/dashboard/reports/cash-bank",
        icon: DollarSign,
        perm: "BANK_READ",
        reports: ["Account Balances", "Bank Reconciliation", "Transfers", "Fees", "Cash Forecast"],
      },
    ],
  },
  {
    id: "platform-settlements",
    label: "Platforms & Settlements",
    color: "violet",
    icon: ArrowLeftRight,
    cards: [
      {
        id: "platform-settlements",
        title: "Platform Settlements",
        description: "Gross settlements, fees, effective rate, variance, net payout",
        href: "/dashboard/reports/platform-settlements",
        icon: CreditCard,
        perm: "REPORT_READ",
        reports: ["Gross Settlements", "Expected/Actual Fee", "Effective Rate", "Fee Variance", "Deductions", "Net Payout", "Reconciliation Status"],
      },
    ],
  },
  {
    id: "budgets",
    label: "Budgets",
    color: "orange",
    icon: PieChart,
    cards: [
      {
        id: "budget-variance",
        title: "Budget Variance",
        description: "Original/revised/committed/actual/forecast/variance analysis",
        href: "/dashboard/reports/budget-variance",
        icon: PieChart,
        perm: "BUDGET_READ",
        reports: ["Original Budget", "Revised Budget", "Committed", "Actual", "Forecast", "Variance"],
      },
    ],
  },
  {
    id: "ownership",
    label: "Ownership & Equity",
    color: "teal",
    icon: PiggyBank,
    cards: [
      {
        id: "ownership-equity",
        title: "Ownership & Equity",
        description: "Capital, owner loans, reserves, retained earnings, distributions",
        href: "/dashboard/reports/ownership-equity",
        icon: PiggyBank,
        perm: "EQUITY_READ",
        reports: ["Capital", "Owner Loans", "Configurable Reserve", "Retained Earnings", "Distributions", "Payment Status"],
      },
    ],
  },
  {
    id: "tax",
    label: "Tax & Return Support",
    color: "purple",
    icon: Calculator,
    cards: [
      {
        id: "tax-reports",
        title: "Tax Reports",
        description: "PBT, taxable income reconciliation, estimated tax, credits, filing status",
        href: "/dashboard/reports/tax-reports",
        icon: Calculator,
        perm: "TAX_READ",
        reports: ["PBT", "Tax Adjustment Reconciliation", "Taxable Income", "Rule-set Calculation", "Credits/Rebates", "Withholding/Advance Tax", "Net Payable/Refund", "Return Pack", "Filing Status"],
      },
    ],
  },
  {
    id: "fiscal-close",
    label: "Fiscal Calendar & Close",
    color: "indigo",
    icon: CalendarDays,
    cards: [
      {
        id: "fiscal-close",
        title: "Fiscal Close",
        description: "Period status, close checklist, adjustments, year-end statements",
        href: "/dashboard/reports/fiscal-close",
        icon: CalendarDays,
        perm: "PERIOD_READ",
        reports: ["Period Status", "Close Checklist", "Adjustments", "Close Package", "Year-end Statements", "Retained Earnings Carry-forward", "Comparative Fiscal Years"],
      },
    ],
  },
  {
    id: "controls",
    label: "Controls & Audit",
    color: "red",
    icon: ShieldCheck,
    cards: [
      {
        id: "controls-audit",
        title: "Controls & Audit",
        description: "Approval aging, policy exceptions, audit trail, access review, AI activity",
        href: "/dashboard/reports/controls-audit",
        icon: ShieldCheck,
        perm: "ADMIN_AUDIT",
        reports: ["Approval Aging", "Policy Exceptions", "Audit Trail", "Access Review", "AI Activity & Cost"],
      },
    ],
  },
];
 
const colorStyles: Record<string, { badge: string; iconBg: string; border: string; hoverBorder: string }> = {
  blue:    { badge: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400", iconBg: "bg-blue-50 dark:bg-blue-900/20", border: "border-gray-200 dark:border-gray-700", hoverBorder: "hover:border-blue-300 dark:hover:border-blue-700" },
  amber:   { badge: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400", iconBg: "bg-amber-50 dark:bg-amber-900/20", border: "border-gray-200 dark:border-gray-700", hoverBorder: "hover:border-amber-300 dark:hover:border-amber-700" },
  emerald: { badge: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400", iconBg: "bg-emerald-50 dark:bg-emerald-900/20", border: "border-gray-200 dark:border-gray-700", hoverBorder: "hover:border-emerald-300 dark:hover:border-emerald-700" },
  cyan:    { badge: "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400", iconBg: "bg-cyan-50 dark:bg-cyan-900/20", border: "border-gray-200 dark:border-gray-700", hoverBorder: "hover:border-cyan-300 dark:hover:border-cyan-700" },
  violet:  { badge: "bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400", iconBg: "bg-violet-50 dark:bg-violet-900/20", border: "border-gray-200 dark:border-gray-700", hoverBorder: "hover:border-violet-300 dark:hover:border-violet-700" },
  orange:  { badge: "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400", iconBg: "bg-orange-50 dark:bg-orange-900/20", border: "border-gray-200 dark:border-gray-700", hoverBorder: "hover:border-orange-300 dark:hover:border-orange-700" },
  teal:    { badge: "bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400", iconBg: "bg-teal-50 dark:bg-teal-900/20", border: "border-gray-200 dark:border-gray-700", hoverBorder: "hover:border-teal-300 dark:hover:border-teal-700" },
  purple:  { badge: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400", iconBg: "bg-purple-50 dark:bg-purple-900/20", border: "border-gray-200 dark:border-gray-700", hoverBorder: "hover:border-purple-300 dark:hover:border-purple-700" },
  indigo:  { badge: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400", iconBg: "bg-indigo-50 dark:bg-indigo-900/20", border: "border-gray-200 dark:border-gray-700", hoverBorder: "hover:border-indigo-300 dark:hover:border-indigo-700" },
  red:     { badge: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400", iconBg: "bg-red-50 dark:bg-red-900/20", border: "border-gray-200 dark:border-gray-700", hoverBorder: "hover:border-red-300 dark:hover:border-red-700" },
  fuchsia: { badge: "bg-fuchsia-100 text-fuchsia-700 dark:bg-fuchsia-900/30 dark:text-fuchsia-400", iconBg: "bg-fuchsia-50 dark:bg-fuchsia-900/20", border: "border-gray-200 dark:border-gray-700", hoverBorder: "hover:border-fuchsia-300 dark:hover:border-fuchsia-700" },
};
 
export default function ReportsLandingPage() {
  const { hasPermission, isLoading } = usePermissions();
 
  const visibleGroups = isLoading
    ? reportGroups
    : reportGroups
        .map((g) => ({
          ...g,
          cards: g.cards.filter((c) => hasPermission(c.perm)),
        }))
        .filter((g) => g.cards.length > 0);
 
  return (
    <div className="max-w-[1600px] mx-auto space-y-8">
      {/* Page Header */}
      <div>
        <div className="flex items-center gap-3 mb-1">
          <BarChart3 className="w-7 h-7 text-blue-600 dark:text-blue-400" />
          <h2 className="text-2xl font-bold text-gray-900 dark:text-white tracking-tight">Reports</h2>
        </div>
        <p className="text-sm text-gray-500 dark:text-gray-400 ml-10">
          Formal financial statements, operational reports, and management analysis - CEO Spec v1.3 Section 13
        </p>
      </div>
 
      {/* Report Groups */}
      {visibleGroups.map((group) => {
        const styles = colorStyles[group.color] || colorStyles.blue;
        const GroupIcon = group.icon;
        const iconColor = COLOR_MAP[group.color] || COLOR_MAP.blue;
        return (
          <section key={group.id}>
            <div className="flex items-center gap-2.5 mb-4">
              <div className={`w-7 h-7 rounded-lg ${styles.iconBg} flex items-center justify-center`}>
                <GroupIcon className="w-4 h-4" style={{ color: iconColor }} />
              </div>
              <h3 className="text-sm font-bold text-gray-900 dark:text-white uppercase tracking-wider">
                {group.label}
              </h3>
              <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded ${styles.badge}`}>
                {group.cards.reduce((sum, c) => sum + (c.reports?.length || 1), 0)} reports
              </span>
            </div>
 
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {group.cards.map((card) => {
                const CardIcon = card.icon;
                return (
                  <Link
                    key={card.id}
                    href={card.href}
                    className={`group bg-white dark:bg-gray-800 border ${styles.border} ${styles.hoverBorder} rounded-xl p-5 shadow-sm hover:shadow-md dark:hover:shadow-none transition-all duration-200`}
                  >
                    <div className="flex items-start justify-between mb-3">
                      <div className={`w-10 h-10 ${styles.iconBg} rounded-lg flex items-center justify-center`}>
                        <CardIcon className="w-5 h-5" style={{ color: iconColor }} />
                      </div>
                      <ArrowRight className="w-4 h-4 text-gray-300 dark:text-gray-600 group-hover:text-gray-500 dark:group-hover:text-gray-400 transition-colors" />
                    </div>
                    <h4 className="text-sm font-semibold text-gray-900 dark:text-white group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors">
                      {card.title}
                    </h4>
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-1.5 leading-relaxed">
                      {card.description}
                    </p>
                    {card.reports && card.reports.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 mt-3">
                        {card.reports.slice(0, 4).map((r) => (
                          <span
                            key={r}
                            className="text-[9px] font-medium px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400"
                          >
                            {r}
                          </span>
                        ))}
                        {card.reports.length > 4 && (
                          <span className="text-[9px] font-medium px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-700 text-gray-400">
                            +{card.reports.length - 4} more
                          </span>
                        )}
                      </div>
                    )}
                  </Link>
                );
              })}
            </div>
          </section>
        );
      })}

    </div>
  );
}

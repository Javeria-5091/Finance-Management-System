"use client";
 
import { useState, useMemo } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import { usePermissions } from "@/context/PermissionContext";
import {LayoutDashboard, FolderKanban, ArrowDownCircle, ArrowUpCircle, FileText, BarChart3, Users, UserCog,
  ShieldCheck, X, LogOut, CreditCard, Wallet, BookOpen, ScrollText, CalendarDays, Building2, ChevronDown,
  ChevronRight, ArrowLeftRight, Scale, TrendingUp, TrendingDown, Calculator, Shield, Landmark, PieChart, Receipt,
  RotateCcw, Download, Upload, CheckCircle, PiggyBank, UserCircle, UserPlus, Bell, FileSpreadsheet, Hash, BookCheck,
  FileBarChart, UsersRound, FileCheck, CircleDollarSign, Banknote, Repeat, HardHat, Percent, ShieldAlert, KeyRound, 
  Coins, History
} from "lucide-react";
 
interface SidebarProps {
  open: boolean;
  onClose: () => void;
}
 
// ICON MAP - All icons used in navigation
const ICONS: Record<string, any> = {
  LayoutDashboard, FolderKanban, ArrowDownCircle, ArrowUpCircle, FileText, BarChart3,
  Users,
  ShieldCheck,
  CreditCard,
  Wallet,
  BookOpen,
  ScrollText,
  CalendarDays,
  Building2,
  ChevronDown,
  ChevronRight,
  ArrowLeftRight,
  Scale,
  TrendingUp,
  TrendingDown,
  Calculator,
  Shield,
  Landmark,
  PieChart,
  Receipt,
  RotateCcw,
  Download,
  Upload,
  CheckCircle,
  PiggyBank,
  UserCircle,
  UserPlus,
  Bell,
  FileSpreadsheet,
  Hash,
  BookCheck,
  FileBarChart,
  UsersRound,
  FileCheck,
  CircleDollarSign,
  Banknote,
  Repeat,
  HardHat,
  Percent,
  ShieldAlert,
  KeyRound,
  UserCog,
  Coins,
  History,
};
 
interface NavItem {
  id: string;
  label: string;
  icon: string;
  path: string;
  perm?: string;
  children?: NavItem[];
}
 
interface NavGroup {
  id: string;
  label: string;
  items: NavItem[];
}
 
// CORRECT PATHS - Only pages that actually exist in your file structure
// Based on: src/app/dashboard/
const navGroups: NavGroup[] = [
  {
    id: "overview",
    label: "Overview",
    items: [
      { id: "dashboard", label: "Dashboard", icon: "LayoutDashboard", path: "/dashboard" },
    ],
  },
  {
    id: "income-expense",
    label: "Income & Expenses",
    items: [
      { id: "incomes", label: "Income", icon: "ArrowDownCircle", path: "/dashboard/income", perm: "INCOME_READ" },
      { id: "expenses", label: "Expenses", icon: "ArrowUpCircle", path: "/dashboard/expenses", perm: "EXPENSE_READ" },
      { id: "budgets", label: "Budgets", icon: "PieChart", path: "/dashboard/budgets", perm: "BUDGET_READ" },
    ],
  },
  {
    id: "projects-clients",
    label: "Projects & Clients",
    items: [
      { id: "projects", label: "All Projects", icon: "FolderKanban", path: "/dashboard/projects", perm: "PROJECT_READ" },
      { id: "clients", label: "Clients", icon: "UsersRound", path: "/dashboard/clients", perm: "CLIENT_READ" },
    ],
  },
  {
    id: "receivables",
    label: "Accounts Receivable",
    items: [
      { id: "invoices", label: "Invoices", icon: "FileText", path: "/dashboard/invoices", perm: "INVOICE_READ" },
      { id: "payment-receipts", label: "Payment Receipts", icon: "Download", path: "/dashboard/payment-receipts", perm: "PAYMENT_RECEIPT_READ" },
      { id: "credit-notes", label: "Credit Notes", icon: "RotateCcw", path: "/dashboard/credit-notes", perm: "CREDIT_NOTE_READ" },
    ],
  },
  {
    id: "payables",
    label: "Accounts Payable",
    items: [
      { id: "vendor", label: "Vendors", icon: "Building2", path: "/dashboard/vendors", perm: "VENDOR_READ" },
      { id: "vendor-bills", label: "Vendor Bills", icon: "FileText", path: "/dashboard/vendor-bills", perm: "VENDOR_BILL_READ" },
      { id: "vendor-payments", label: "Vendor Payments", icon: "CreditCard", path: "/dashboard/vendor-payments", perm: "VENDOR_PAYMENT_READ" },
    ],
  },
  {
    id: "banking",
    label: "Banking & Cash",
    items: [
      { id: "bank-accounts", label: "Bank Accounts", icon: "Landmark", path: "/dashboard/banking/accounts", perm: "BANK_READ" },
      { id: "statements", label: "Statements & Reconciliation", icon: "Scale", path: "/dashboard/banking/statements", perm: "BANK_RECONCILE" },
      { id: "transfers", label: "Transfers", icon: "ArrowLeftRight", path: "/dashboard/banking/transfer", perm: "BANK_TRANSFER" },
    ],
  },
  {
    id: "accounting",
    label: "Accounting",
    items: [
      { id: "coa", label: "Chart of Accounts", icon: "BookOpen", path: "/dashboard/accounting/chart-of-accounts", perm: "COA_READ" },
      { id: "journals", label: "Journal Entries", icon: "ScrollText", path: "/dashboard/accounting/journal-entries", perm: "JOURNAL_READ" },
      { id: "fiscal", label: "Fiscal Calendar", icon: "CalendarDays", path: "/dashboard/accounting/fiscal-calendar", perm: "PERIOD_READ" },
      {id: "opening-balance", label: "Opening Balance", icon: "Scale", path: "/dashboard/accounting/opening-balance", perm: "JOURNAL_READ"}
    ],
  },
  {
    id: "fixed-assets",
    label: "Fixed Assets",
    items: [
      { id: "asset-register", label: "Asset Register", icon: "Building2", path: "/dashboard/assets/asset-register", perm: "FIXED_ASSET_READ" },
      { id: "asset-depreciation", label: "Depreciation", icon: "TrendingDown", path: "/dashboard/assets/depreciation", perm: "FIXED_ASSET_READ" },
      { id: "asset-verification", label: "Verifications", icon: "CheckCircle", path: "/dashboard/assets/verifications", perm: "FIXED_ASSET_READ" },
    ],
  },
  {
    id: "tax-equity",
    label: "Tax & Equity",
    items: [
      { id: "tax-config", label: "Tax Configuration", icon: "Shield", path: "/dashboard/tax-equity/tax-configuration", perm: "TAX_READ" },
      { id: "tax-recon", label: "Tax Reconciliation", icon: "Calculator", path: "/dashboard/tax-equity/tax-reconciliation", perm: "TAX_READ" },
      { id: "tax-returns", label: "Tax Returns", icon: "FileCheck", path: "/dashboard/tax-equity/tax-returns", perm: "TAX_READ" },
      { id: "profit-dist", label: "Profit Distribution", icon: "TrendingUp", path: "/dashboard/tax-equity/profit-distribution", perm: "EQUITY_READ" },
      { id: "ownership-reserves", label: "Ownership & Reserves", icon: "PiggyBank", path: "/dashboard/tax-equity/ownership-reserves", perm: "EQUITY_READ" },
    ],
  },
  {
    id: "payroll",
    label: "Payroll",
    items: [
      { id: "payroll-management", label: "Payroll Management", icon: "Banknote", path: "/dashboard/payroll", perm: "PAYROLL_READ" },
    ],
  },
  {
    id: "subscriptions",
    label: "Subscriptions",  
    items: [
    {id: "subscriptions", label: "Subscriptions", icon: "Repeat", path: "/dashboard/subscriptions", perm: "SUBSCRIPTION_READ" },
    ],
  },
  {
  id: 'contractors',
  label: 'Contractors',
  items: [
    { id: 'contractors-list', label: 'All Contractors', icon: 'HardHat', path: '/dashboard/contractors', perm: 'CONTRACTOR_READ' },
  ],
},
{
  id: 'commissions',
  label: 'Commissions',
  items: [
    { id: 'commissions-list', label: 'All Commissions', icon: 'Percent', path: '/dashboard/commissions', perm: 'COMMISSION_READ' },
  ],
},
  {
    id: "reports",
    label: "Reports",
    items: [
      { id: "all-reports", label: "Report Hub", icon: "BarChart3", path: "/dashboard/reports", perm: "REPORT_READ" },
      { id: "financial-statements", label: "Financial Statements", icon: "FileSpreadsheet", path: "/dashboard/reports/financial-statements", perm: "REPORT_READ" },
      { id: "general-ledger", label: "General Ledger", icon: "BookCheck", path: "/dashboard/reports/general-ledger", perm: "GL_READ" },
      { id: "trial-balance", label: "Trial Balance", icon: "FileBarChart", path: "/dashboard/reports/trial-balance", perm: "GL_READ" },
      { id: "general-ledger-multi-currency", label: "Original-Currency Ledgers", icon: "Coins", path: "/dashboard/reports/general-ledger-multi-currency", perm: "GL_READ" },
      { id: "exchange-rate-history", label: "Manual-Rate History", icon: "History", path: "/dashboard/reports/exchange-rate-history", perm: "GL_READ" },
      { id: "pkr-conversion", label: "PKR Conversion", icon: "Repeat", path: "/dashboard/reports/pkr-conversion", perm: "GL_READ" },
      { id: "aging-reports", label: "Aging (AR/AP)", icon: "Receipt", path: "/dashboard/reports/aging-reports", perm: "REPORT_READ" },
      { id: "project-profitability", label: "Project Profitability", icon: "TrendingUp", path: "/dashboard/reports/project-profitability", perm: "REPORT_READ" },
      { id: "cash-bank", label: "Cash & Bank", icon: "Landmark", path: "/dashboard/reports/cash-bank", perm: "BANK_READ" },
      { id: "budget-variance", label: "Budget Variance", icon: "PieChart", path: "/dashboard/reports/budget-variance", perm: "BUDGET_READ" },
      { id: "ownership-equity", label: "Ownership & Equity", icon: "PiggyBank", path: "/dashboard/reports/ownership-equity", perm: "EQUITY_READ" },
      { id: "platform-settlements", label: "Platform Settlements", icon: "CreditCard", path: "/dashboard/reports/platform-settlements", perm: "REPORT_READ" },
      { id: "fiscal-close", label: "Fiscal Close", icon: "CalendarDays", path: "/dashboard/reports/fiscal-close", perm: "PERIOD_READ" },
      { id: "tax-reports", label: "Tax Reports", icon: "FileCheck", path: "/dashboard/reports/tax-reports", perm: "TAX_READ" },
      { id: "controls-audit", label: "Controls & Audit", icon: "ShieldCheck", path: "/dashboard/reports/controls-audit", perm: "ADMIN_AUDIT" },
    ],
  },
  {
    id: "settings",
    label: "Settings",
    items: [
      { id: "organization", label: "Organization", icon: "Building2", path: "/dashboard/settings/organization", perm: "SETTINGS_READ" },
      { id: "financial-accounts", label: "Financial Accounts", icon: "CircleDollarSign", path: "/dashboard/settings/financial-accounts", perm: "SETTINGS_READ" },
      { id: "numbering", label: "Numbering Sequences", icon: "Hash", path: "/dashboard/settings/numbering", perm: "SETTINGS_READ" },
      { id: "exchange-rates", label: "Exchange Rates", icon: "Scale", path: "/dashboard/settings/exchange-rates", perm: "SETTINGS_READ" },
      { id: "platform-fees", label: "Platform Fees", icon: "ReceiptPercent", path: "/dashboard/settings/platform-fees", perm: "SETTINGS_READ" },
      { id: "notifications", label: "Notifications", icon: "Bell", path: "/dashboard/settings/notifications", perm: "SETTINGS_READ" },
      { id: "approval-limits", label: "Approval Limits", icon: "ShieldAlert", path: "/dashboard/settings/approval-limits", perm: "ADMIN_USERS" },
      { id: "permission-overrides", label: "Permission Overrides", icon: "KeyRound", path: "/dashboard/settings/permission-overrides", perm: "ADMIN_USERS" },
      { id: "delegations", label: "Delegations", icon: "UserCog", path: "/dashboard/settings/delegations", perm: "ADMIN_USERS" },
      
    ],
  },
  {
    id: "admin",
    label: "Administration",
    items: [
      { id: "user-roles", label: "Users & Roles", icon: "UserCircle", path: "/dashboard/admin/users-roles", perm: "ADMIN_USERS" },
      { id: "audit-log", label: "Audit Log", icon: "ShieldCheck", path: "/dashboard/admin/audit-log", perm: "ADMIN_AUDIT" },
      { id: "migration", label: "Data Migration", icon: "ArrowLeftRight", path: "/dashboard/admin/migration", perm: "ADMIN_MIGRATION" },
    ],
  },
];
 
export default function Sidebar({ open, onClose }: SidebarProps) {
  const pathname = usePathname();
  const { role, profile, signOut } = useAuth();
  const { hasPermission, isLoading: permLoading } = usePermissions();
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
 
  const toggleGroup = (groupId: string) => {
    setCollapsedGroups((prev) => ({ ...prev, [groupId]: !prev[groupId] }));
  };
 
  const handleSignOut = async () => {
    await signOut();
    onClose();
  };
 
  // Filter items based on permission
  const filterItems = (items: NavItem[]): NavItem[] => {
    if (permLoading) return items;
    return items.filter((item) => {
      if (!item.perm) return true;
      return hasPermission(item.perm);
    });
  };
 
  // Filter groups - remove empty groups
  const visibleGroups = useMemo(() => {
    return navGroups
      .map((group) => ({
        ...group,
        items: filterItems(group.items),
      }))
      .filter((group) => group.items.length > 0);
  }, [permLoading, hasPermission]);
 
  return (
    <>
      {/* Mobile overlay */}
      {open && (
        <div
          className="fixed inset-0 bg-black/50 z-40 lg:hidden backdrop-blur-sm"
          onClick={onClose}
        />
      )}
 
      <aside
        className={`fixed top-0 left-0 z-50 h-screen w-64 bg-white dark:bg-gray-800 border-r border-gray-200 dark:border-gray-700 transform transition-transform duration-300 lg:translate-x-0 lg:static lg:z-auto flex flex-col overflow-hidden ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        {/* HEADER */}
        <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
          <Link href="/dashboard" onClick={onClose} className="flex items-center gap-2.5">
            <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center">
              <span className="text-white font-bold text-xs">O</span>
            </div>
            <div>
              <h1 className="text-base font-bold text-gray-900 dark:text-white leading-tight">OSYSTIC</h1>
              <p className="text-[10px] text-gray-500 dark:text-gray-400 leading-tight -mt-0.5">Finance System</p>
            </div>
          </Link>
          <button onClick={onClose} className="lg:hidden p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500 transition-colors">
            <X size={20} />
          </button>
        </div>
 
        {/* USER INFO */}
        {profile && (
          <div className="p-4 border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 bg-gray-200 dark:bg-gray-700 rounded-full flex items-center justify-center">
                <span className="text-gray-600 dark:text-gray-300 font-medium text-sm">
                  {profile.full_name?.[0]?.toUpperCase() || profile.email?.[0]?.toUpperCase() || 'U'}
                </span>
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-900 dark:text-white truncate">
                  {profile.full_name || profile.email?.split('@')[0]}
                </p>
                <span className="inline-flex items-center w-fit px-2 py-0.5 rounded mt-1 text-[10px] font-bold uppercase tracking-wider bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400">
                  {role}
                </span>
              </div>
            </div>
          </div>
        )}
 
        {/* NAVIGATION */}
        <nav className="p-3 space-y-4 overflow-y-auto flex-1 min-h-0">
          {visibleGroups.map((group) => {
            const isCollapsed = collapsedGroups[group.id] || false;
            return (
              <div key={group.id}>
                <button
                  onClick={() => toggleGroup(group.id)}
                  className="flex items-center justify-between w-full px-2 py-1 text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
                >
                  <span>{group.label}</span>
                  {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                </button>
                {!isCollapsed && (
                  <div className="mt-1 space-y-0.5">
                    {group.items.map((item) => {
                      const Icon = ICONS[item.icon] || FileText;
                      const isActive = pathname === item.path;
                      return (
                        <Link key={item.id} href={item.path} onClick={onClose}
                          className={`flex items-center gap-3 px-3 py-2 rounded-lg text-[13px] font-medium transition-all duration-150 ${
                            isActive
                              ? "bg-blue-600 text-white shadow-md shadow-blue-600/20"
                              : "text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-white/10 hover:text-gray-900 dark:hover:text-white"
                          }`}
                        >
                          <Icon size={18} className={`flex-shrink-0 ${isActive ? "text-white" : "text-gray-400 dark:text-gray-500"}`} />
                          <span>{item.label}</span>
                        </Link>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </nav>
 
        {/* FOOTER */}
        <div className="p-3 border-t border-gray-200 dark:border-gray-700 flex-shrink-0 mt-auto">
          <button onClick={handleSignOut} className="flex items-center gap-3 w-full px-3 py-2.5 rounded-lg text-sm font-medium text-red-500 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors">
            <LogOut size={18} /> Sign Out
          </button>
        </div>
      </aside>
    </>
  );
}

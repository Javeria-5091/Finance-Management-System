"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import { usePermissions } from "@/hooks/usePermissions";
import {
  LayoutDashboard, FolderKanban, ArrowDownCircle, ArrowUpCircle,
  FileText, BarChart3, Users, ShieldCheck, X, LogOut, CreditCard,
  Wallet, BookOpen, ScrollText, CalendarDays, Building2,
  ChevronDown, ChevronRight, ArrowUpDown, Table2, List,
} from "lucide-react";

interface SidebarProps {
  open: boolean;
  onClose: () => void;
}

// ✅ Strict Permission Mapping
const navGroups = [
  {
    id: "overview",
    label: "Overview",
    items: [
      { label: "Dashboard", href: "/dashboard", icon: LayoutDashboard, permission: null },
      { label: "Transactions", href: "/dashboard/transactions", icon: FileText, permission: "INCOME_READ" },
    ],
  },
  {
    id: "operations",
    label: "Operations",
    items: [
      { label: "Projects", href: "/dashboard/projects", icon: FolderKanban, permission: "INCOME_READ" },
      { label: "Income", href: "/dashboard/income", icon: ArrowDownCircle, permission: "INCOME_READ" },
      { label: "Expenses", href: "/dashboard/expenses", icon: ArrowUpCircle, permission: "EXPENSE_READ" },
      { label: "Budgets", href: "/dashboard/budgets", icon: Wallet, permission: "EXPENSE_READ" },
      { label: "Payments", href: "/dashboard/payments", icon: CreditCard, permission: "INCOME_READ" },
      { label: "Invoices", href: "/dashboard/invoices", icon: FileText, permission: "INCOME_READ" },
    ],
  },
  {
    id: "accounting",
    label: "Accounting",
    items: [
      { label: "Chart of Accounts", href: "/dashboard/accounting/chart-of-accounts", icon: BookOpen, permission: "COA_READ" },
      { label: "Journal Entries", href: "/dashboard/accounting/journal-entries", icon: ScrollText, permission: "JOURNAL_READ" },
      { label: "Fiscal Calendar", href: "/dashboard/accounting/fiscal-calendar", icon: CalendarDays, permission: "PERIOD_READ" },
    ],
  },
  {
    id: "reports",
    label: "Reports",
    items: [
      { label: "All Reports", href: "/dashboard/reports", icon: BarChart3, permission: "REPORT_READ" },
      { label: "Trial Balance", href: "/dashboard/reports/trial-balance", icon: Table2, permission: "REPORT_READ" },
      { label: "General Ledger", href: "/dashboard/reports/general-ledger", icon: List, permission: "REPORT_READ" },
    ],
  },
  {
    id: "admin",
    label: "Admin",
    items: [
      { label: "Users & Roles", href: "/dashboard/admin/users-roles", icon: Users, permission: "ADMIN_USERS" },
      { label: "Audit Log", href: "/dashboard/admin/audit-log", icon: ShieldCheck, permission: "ADMIN_AUDIT" },
    ],
  },
  {
    id: "settings",
    label: "Settings",
    items: [
      { label: "Organization", href: "/dashboard/settings/organization", icon: Building2, permission: "ADMIN_CONFIG" },
      { label: "Exchange Rates", href: "/dashboard/settings/exchange-rates", icon: ArrowUpDown, permission: "ADMIN_CONFIG" },
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

  // ✅ Secure Filter Logic: Agar loading hai toh sab dikhao (Blank screen prevent karo)
  const filterItems = (items: typeof navGroups[0]['items']) => {
    if (permLoading) return items; 
    return items.filter((item) => {
      if (!item.permission) return true;
      return hasPermission(item.permission);
    });
  };

  return (
    <>
      {open && (
        <div className="fixed inset-0 bg-black/50 z-40 lg:hidden backdrop-blur-sm" onClick={onClose} />
      )}

      <aside className={`fixed top-0 left-0 z-50 h-screen w-64 bg-white dark:bg-gray-800 border-r border-gray-200 dark:border-gray-700 transform transition-transform duration-300 lg:translate-x-0 lg:static lg:z-auto flex flex-col overflow-hidden ${open ? "translate-x-0" : "-translate-x-full"}`}>
        
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
          <Link href="/dashboard" className="flex items-center gap-2.5">
            <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center">
              <span className="text-white font-bold text-xs">O</span>
            </div>
            <div>
              <h1 className="text-base font-bold text-gray-900 dark:text-white leading-tight">Osystic</h1>
              <p className="text-[10px] text-gray-500 dark:text-gray-400 leading-tight -mt-0.5">Finance ERP</p>
            </div>
          </Link>
          <button onClick={onClose} className="lg:hidden p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500 transition-colors">
            <X size={20} />
          </button>
        </div>

        {/* User Info */}
        {profile && (
          <div className="p-4 border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
            <p className="text-sm font-medium text-gray-900 dark:text-white truncate">{profile.full_name || profile.email}</p>
            <span className="inline-flex items-center w-fit px-2 py-0.5 rounded mt-1.5 text-[10px] font-bold uppercase tracking-wider bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400">
              {role}
            </span>
          </div>
        )}

        {/* Navigation */}
        <nav className="p-3 space-y-5 overflow-y-auto flex-1 min-h-0">
          {navGroups.map((group) => {
            const visibleItems = filterItems(group.items);
            if (visibleItems.length === 0) return null;

            const isCollapsed = collapsedGroups[group.id];

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
                    {visibleItems.map((item) => {
                      const Icon = item.icon;
                      const isActive = pathname === item.href || (item.href === "/dashboard" && pathname === "/");

                      return (
                        <Link 
                          key={item.href} 
                          href={item.href} 
                          onClick={onClose} 
                          className={`flex items-center gap-3 px-3 py-2 rounded-lg text-[13px] font-medium transition-all duration-150 ${
                            isActive 
                              ? "bg-blue-600 text-white shadow-md shadow-blue-600/20" 
                              : "text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-white/5 dark:hover:bg-white/10 hover:text-gray-900 dark:hover:text-white"
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

        {/* Footer Sign Out */}
        <div className="p-3 border-t border-gray-200 dark:border-gray-700 flex-shrink-0 mt-auto">
          <button 
            onClick={handleSignOut} 
            className="flex items-center gap-3 w-full px-3 py-2.5 rounded-lg text-sm font-medium text-red-500 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors"
          >
            <LogOut size={18} /> Sign Out
          </button>
        </div>
      </aside>
    </>
  );
}
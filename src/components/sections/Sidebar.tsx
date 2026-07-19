"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import {
  LayoutDashboard,
  FolderKanban,
  ArrowDownCircle,
  ArrowUpCircle,
  FileText,
  BarChart3,
  Users,
  ShieldCheck,
  X,
  LogOut, 
  CreditCard,
  Wallet,
  BookOpen,
  ScrollText,
  CalendarDays,
  Building2,
  ChevronDown,
  ChevronRight,
} from "lucide-react";

interface SidebarProps {
  open: boolean;
  onClose: () => void;
}

const navGroups = [
  {
    id: "overview",
    label: "Overview",
    items: [
      { label: "Dashboard", href: "/dashboard", icon: LayoutDashboard, showFor: ["Admin", "HOD", "Program Manager", "Project Manager", "User"] },
      { label: "Transactions", href: "/dashboard/transactions", icon: FileText, showFor: ["Admin", "HOD", "Program Manager", "Project Manager", "User"] },
    ],
  },
  {
    id: "operations",
    label: "Operations",
    items: [
      { label: "Projects", href: "/dashboard/projects", icon: FolderKanban, showFor: ["Admin", "HOD", "Program Manager", "Project Manager", "User"] },
      { label: "Income", href: "/dashboard/income", icon: ArrowDownCircle, showFor: ["Admin", "HOD", "Program Manager", "Project Manager", "User"] },
      { label: "Expenses", href: "/dashboard/expenses", icon: ArrowUpCircle, showFor: ["Admin", "HOD", "Program Manager", "Project Manager", "User"] },
      { label: "Budgets", href: "/dashboard/budgets", icon: Wallet, showFor: ["Admin", "HOD", "Program Manager", "Project Manager", "User"] },
      { label: "Payments", href: "/dashboard/payments", icon: CreditCard, showFor: ["Admin", "HOD", "Program Manager", "Project Manager", "User"] },
      { label: "Invoices", href: "/dashboard/invoices", icon: FileText, showFor: ["Admin", "HOD", "Program Manager", "Project Manager", "User"] },
    ],
  },
  {
    id: "accounting",
    label: "Accounting",
    items: [
      // ✅ FIX: /accounting/ add kiya
      { label: "Chart of Accounts", href: "/dashboard/accounting/chart-of-accounts", icon: BookOpen, showFor: ["Admin", "HOD", "Program Manager", "Project Manager", "User"] },
      { label: "Journal Entries", href: "/dashboard/accounting/journal-entries", icon: ScrollText, showFor: ["Admin", "HOD", "Program Manager", "Project Manager", "User"] },
      { label: "Fiscal Calendar", href: "/dashboard/accounting/fiscal-calendar", icon: CalendarDays, showFor: ["Admin", "HOD", "Program Manager", "Project Manager", "User"] },
    ],
  },
  {
    id: "reports",
    label: "Reports",
    items: [
      { label: "Reports", href: "/dashboard/reports", icon: BarChart3, showFor: ["Admin", "HOD", "Program Manager", "Project Manager", "User"] },
    ],
  },
  {
    id: "admin",
    label: "Admin",
    items: [
      { label: "Admin Panel", href: "/dashboard/admin", icon: Users, showFor: ["Admin", "User"] },
      // ✅ FIX: /admin/ add kiya
      { label: "Audit Log", href: "/dashboard/admin/audit-log", icon: ShieldCheck, showFor: ["Admin", "User"] },
    ],
  },
  {
    id: "settings",
    label: "Settings",
    items: [
      // ✅ FIX: /settings/organization kiya
      { label: "Organization", href: "/dashboard/settings/organization", icon: Building2, showFor: ["Admin", "HOD"] },
    ],
  },
];

export default function Sidebar({ open, onClose }: SidebarProps) {
  const pathname = usePathname();
  const { role, profile, signOut } = useAuth(); 
  
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});

  const toggleGroup = (groupId: string) => {
    setCollapsedGroups((prev) => ({
      ...prev,
      [groupId]: !prev[groupId],
    }));
  };

  async function handleSignOut() {
    await signOut();
    onClose(); 
  }

  return (
    <>
      {open && (
        <div
          className="fixed inset-0 bg-black/50 z-40 lg:hidden backdrop-blur-sm"
          onClick={onClose}
        />
      )}

      <aside
        className={`fixed top-0 left-0 z-50 h-screen w-64 bg-white dark:bg-gray-800 border-r border-gray-200 dark:border-gray-700 transform transition-transform duration-300 lg:translate-x-0 lg:static lg:z-auto ${
          open ? "translate-x-0" : "-translate-x-full"
        } flex flex-col overflow-hidden`} 
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
          <div>
            <h1 className="text-lg font-bold text-gray-900 dark:text-white">Osystic</h1>
            <p className="text-xs text-gray-500 dark:text-gray-400">Finance Management</p>
          </div>
          <button
            onClick={onClose}
            className="lg:hidden p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500 dark:text-gray-400 transition-colors"
          >
            <X size={20} />
          </button>
        </div>

        {/* User Info */}
        {profile && (
          <div className="p-4 border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
            <p className="text-sm text-gray-900 dark:text-white font-medium truncate">
              {profile.full_name || profile.email}
            </p>
            <span
              className={`inline-block text-xs px-2 py-0.5 rounded mt-1 font-medium ${
                role === "Admin"
                  ? "bg-purple-100 text-purple-700 dark:bg-purple-500/20 dark:text-purple-400"
                  : role === "HOD"
                  ? "bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-400"
                  : role === "Program Manager"
                  ? "bg-green-100 text-green-700 dark:bg-green-500/20 dark:text-green-400"
                  : role === "Project Manager"
                  ? "bg-yellow-100 text-yellow-700 dark:bg-yellow-500/20 dark:text-yellow-400"
                  : "bg-gray-100 text-gray-700 dark:bg-gray-500/20 dark:text-gray-400"
              }`}
            >
              {role}
            </span>
          </div>
        )}

        {/* Navigation */}
        <nav className="p-3 space-y-4 overflow-y-auto flex-1 min-h-0">
          {navGroups.map((group) => {
            const visibleItems = group.items.filter((item) => {
              if (!role) return false;
              return item.showFor.includes(role);
            });

            if (visibleItems.length === 0) return null;

            const isCollapsed = collapsedGroups[group.id];

            return (
              <div key={group.id}>
                <button
                  onClick={() => toggleGroup(group.id)}
                  className="flex items-center justify-between w-full px-3 py-1.5 text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
                >
                  <span>{group.label}</span>
                  {isCollapsed ? (
                    <ChevronRight size={14} className="text-gray-400 dark:text-gray-500" />
                  ) : (
                    <ChevronDown size={14} className="text-gray-400 dark:text-gray-500" />
                  )}
                </button>

                {!isCollapsed && (
                  <div className="mt-1 space-y-1">
                    {visibleItems.map((item) => {
                      const Icon = item.icon;
                      const isActive = pathname === item.href || 
                        (item.href === "/dashboard" && pathname === "/");

                      return (
                        <Link
                          key={item.href}
                          href={item.href}
                          onClick={onClose}
                          className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                            isActive
                              ? "bg-blue-600 text-white"
                              : "text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 hover:text-gray-900 dark:hover:text-white"
                          }`}
                        >
                          <Icon 
                            size={18} 
                            className={isActive ? "text-white" : "text-gray-500 dark:text-gray-400"} 
                          />
                          {item.label}
                        </Link>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </nav>

        {/* Sign Out Section */}
        <div className="p-3 border-t border-gray-200 dark:border-gray-700 flex-shrink-0">
          <button
            onClick={handleSignOut}
            className="flex items-center gap-3 w-full px-3 py-2.5 rounded-lg text-sm font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10 hover:text-red-700 dark:hover:text-red-300 transition-colors"
          >
            <LogOut size={18} />
            Sign Out
          </button>
        </div>
      </aside>
    </>
  );
}
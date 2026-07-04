"use client";

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
  LogOut, // ✅ SIGN OUT ICON ADD KIYA
} from "lucide-react";

interface SidebarProps {
  open: boolean;
  onClose: () => void;
}

// ✅ MENU ITEMS WITH ROLE REQUIREMENTS
const menuItems = [
  {
    label: "Dashboard",
    href: "/dashboard",
    icon: LayoutDashboard,
    showFor: ["Admin", "HOD", "Program Manager", "Project Manager", "User"],
  },
  {
    label: "Income",
    href: "/dashboard/income",
    icon: ArrowDownCircle,
    showFor: ["Admin", "HOD", "Program Manager", "Project Manager", "User"],
  },
  {
    label: "Expenses",
    href: "/dashboard/expenses",
    icon: ArrowUpCircle,
    showFor: ["Admin", "HOD", "Program Manager", "Project Manager", "User"],
  },
  {
    label: "Transactions",
    href: "/dashboard/transactions",
    icon: FileText,
    showFor: ["Admin", "HOD", "Program Manager", "Project Manager", "User"],
  },
  {
    label: "Projects",
    href: "/dashboard/projects",
    icon: FolderKanban,
    showFor: ["Admin", "HOD", "Program Manager", "Project Manager", "User"],
  },
  {
    label: "Invoices",
    href: "/dashboard/invoices",
    icon: FileText,
    showFor: ["Admin", "HOD", "Program Manager", "Project Manager", "User"],
  },
  {
    label: "Reports",
    href: "/dashboard/reports",
    icon: BarChart3,
    showFor: ["Admin", "HOD", "Program Manager", "Project Manager", "User"],
  },
  {
    label: "Admin Panel",
    href: "/dashboard/admin",
    icon: Users,
    showFor: ["Admin", "User"],
  },
  {
    label: "Audit Log",
    href: "/dashboard/audit-log",
    icon: ShieldCheck,
    showFor: ["Admin", "User"],
  },
];

export default function Sidebar({ open, onClose }: SidebarProps) {
  const pathname = usePathname();
  const { role, profile, signOut } = useAuth(); // ✅ signOut ADD KIYA

  // ✅ FILTER MENU ITEMS BASED ON ROLE
  const visibleItems = menuItems.filter((item) => {
    if (!role) return false;
    return item.showFor.includes(role);
  });

  // ✅ SIGN OUT HANDLER
  async function handleSignOut() {
    await signOut();
    onClose(); // Mobile sidebar band karo
  }

  return (
    <>
      {/* Mobile Overlay */}
      {open && (
        <div
          className="fixed inset-0 bg-black/50 z-40 lg:hidden"
          onClick={onClose}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`fixed top-0 left-0 z-50 h-full w-64 bg-gray-800 border-r border-gray-700 transform transition-transform duration-300 lg:translate-x-0 lg:static lg:z-auto ${
          open ? "translate-x-0" : "-translate-x-full"
        } flex flex-col`} // ✅ flex flex-col add kiya taake footer neeche rahe
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-700">
          <div>
            <h1 className="text-lg font-bold text-white">Osystic</h1>
            <p className="text-xs text-gray-400">Finance Management</p>
          </div>
          <button
            onClick={onClose}
            className="lg:hidden p-1.5 rounded-lg hover:bg-gray-700 text-gray-400"
          >
            <X size={20} />
          </button>
        </div>

        {/* User Info */}
        {profile && (
          <div className="p-4 border-b border-gray-700">
            <p className="text-sm text-white font-medium truncate">
              {profile.full_name || profile.email}
            </p>
            <span
              className={`inline-block text-xs px-2 py-0.5 rounded mt-1 font-medium ${
                role === "Admin"
                  ? "bg-purple-500/20 text-purple-400"
                  : role === "HOD"
                  ? "bg-blue-500/20 text-blue-400"
                  : role === "Program Manager"
                  ? "bg-green-500/20 text-green-400"
                  : role === "Project Manager"
                  ? "bg-yellow-500/20 text-yellow-400"
                  : "bg-gray-500/20 text-gray-400"
              }`}
            >
              {role}
            </span>
          </div>
        )}

        {/* Navigation */}
        <nav className="p-3 space-y-1 overflow-y-auto flex-1">
          {visibleItems.map((item) => {
            const Icon = item.icon;
            const isActive = pathname === item.href;

            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={onClose}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                  isActive
                    ? "bg-blue-600 text-white"
                    : "text-gray-300 hover:bg-gray-700 hover:text-white"
                }`}
              >
                <Icon size={18} />
                {item.label}
              </Link>
            );
          })}
        </nav>

        {/* ✅ SIGN OUT BUTTON (BOTTOM MEIN FIXED) */}
        <div className="p-3 border-t border-gray-700 mt-auto">
          <button
            onClick={handleSignOut}
            className="flex items-center gap-3 w-full px-3 py-2.5 rounded-lg text-sm font-medium text-red-400 hover:bg-red-500/10 hover:text-red-300 transition-colors"
          >
            <LogOut size={18} />
            Sign Out
          </button>
        </div>
      </aside>
    </>
  );
}
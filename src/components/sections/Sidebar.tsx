"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, DollarSign, FolderOpen, CreditCard, LogOut, X } from "lucide-react";
import { useAuth } from "@/context/AuthContext";

interface SidebarProps {
  open: boolean;
  onClose: () => void;
}

export default function Sidebar({ open, onClose }: SidebarProps) {
  const pathname = usePathname();
  const { signOut } = useAuth();

  function handleLogout() {
    signOut();
    window.location.href = "/login";
  }

    const navItems = [
    { label: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
    { label: "Projects", href: "/dashboard/projects", icon: FolderOpen }, // <-- YEH NAYA
    { label: "Income", href: "/dashboard/income", icon: DollarSign },
    { label: "Expenses", href: "/dashboard/expenses", icon: CreditCard }, // <-- YEH NAYA (Abhi disable)
  ];

  return (
    <>
      {/* Mobile Overlay */}
      {open && <div className="fixed inset-0 bg-black/50 z-40 lg:hidden" onClick={onClose} />}

      {/* Sidebar Panel */}
      <aside className={`fixed top-0 left-0 z-50 h-full w-64 bg-gray-900 border-r border-gray-800 p-4 flex flex-col transition-transform duration-300 lg:translate-x-0 lg:static lg:z-auto ${open ? "translate-x-0" : "-translate-x-full"}`}>
        
        {/* Logo */}
        <div className="flex items-center justify-between mb-8">
          <Link href="/dashboard" className="text-xl font-bold text-blue-400">Osystic</Link>
          <button onClick={onClose} className="lg:hidden text-gray-400 hover:text-white"><X size={20} /></button>
        </div>

        {/* Navigation Links */}
        <nav className="flex-1 space-y-2">
          {navItems.map(item => {
            const isActive = pathname === item.href;
            const Icon = item.icon;
            return (
              <Link key={item.label} href={item.href} onClick={onClose} className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${isActive ? "bg-blue-600/20 text-blue-400" : "text-gray-400 hover:bg-gray-800 hover:text-white"}`}>
                <Icon size={18} />
                {item.label}
              </Link>
            );
          })}
        </nav>

        {/* Logout Button */}
        <button onClick={handleLogout} className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-gray-400 hover:bg-red-500/20 hover:text-red-400 transition-colors mt-4">
          <LogOut size={18} />
          Sign Out
        </button>
      </aside>
    </>
  );
}
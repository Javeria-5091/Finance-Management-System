"use client";
import { useState, useEffect, ReactNode } from "react";
import { useRouter, usePathname } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import { useTheme } from "@/context/ThemeContext"; // IMPORT KIYA
import Sidebar from "@/components/sections/Sidebar";
import TopNavbar from "@/components/sections/TopNavbar";
import { ShieldAlert } from "lucide-react";

const ADMIN_ONLY_ROUTES = [
  "/dashboard/admin",
  "/dashboard/audit-log",
];

export default function DashboardLayout({ children }: { children: ReactNode }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const { user, isAdmin } = useAuth();
  const { isDark, toggleTheme } = useTheme(); // THEME HOOK
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (!user) {
      router.push("/login");
    }
  }, [user, router]);

  if (!user) return null;

  const isAdminRoute = ADMIN_ONLY_ROUTES.some((route) => pathname.startsWith(route));

  if (isAdminRoute && !isAdmin) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900 px-4">
        <div className="max-w-md text-center">
          <div className="w-20 h-20 bg-red-100 dark:bg-red-500/20 rounded-full flex items-center justify-center mx-auto mb-6">
            <ShieldAlert className="w-10 h-10 text-red-600 dark:text-red-400" />
          </div>
          <h2 className="text-2xl font-bold text-gray-900 dark:text-white mb-3">Access Denied</h2>
          <p className="text-gray-600 dark:text-gray-400 mb-6 text-sm">You do not have Admin privileges.</p>
          <button onClick={() => router.push("/dashboard")} className="px-6 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium">Back to Dashboard</button>
        </div>
      </div>
    );
  }

  return (
    // BG COLOR DYNAMIC (Light/Dark dono ke liye)
    <div className="min-h-screen flex bg-gray-100 dark:bg-gray-900 transition-colors duration-300">
      <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      <div className="flex-1 flex flex-col">
        {/* THEME TOGGLE PASS KIYA TOPNAV KO */}
        <TopNavbar 
          onMenuClick={() => setSidebarOpen(true)} 
          title="Osystic Finance" 
          isDark={isDark}
          toggleTheme={toggleTheme}
        />
        <main className="flex-1 p-6 overflow-y-auto bg-gray-50 dark:bg-gray-900 transition-colors">
          {children}
        </main>
      </div>
    </div>
  );
}
"use client";
import { useState, ReactNode } from "react";
import { useRouter, usePathname } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import { useTheme } from "@/context/ThemeContext"; // IMPORT KIYA
import Sidebar from "@/components/sections/Sidebar";
import TopNavbar from "@/components/sections/TopNavbar";
import { ShieldAlert } from "lucide-react";
import { ErrorBoundary } from "@/components/ErrorBoundary"; // FIX 9.3: Error Boundary

const ADMIN_ONLY_ROUTES = [
  "/dashboard/admin",
  "/dashboard/audit-log",
];

export default function DashboardLayout({ children }: { children: ReactNode }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const { user, isAdmin, loading: authLoading } = useAuth();
  const { isDark, toggleTheme } = useTheme(); // THEME HOOK
  const router = useRouter();
  const pathname = usePathname();

  // FIX: Middleware already handles auth redirect to /login.
  // Removing this useEffect because it caused a race condition:
  // AuthContext takes time to sync session from cookies → user is temporarily null
   // → this useEffect fired router.push("/login") before AuthContext finished loading
   // → infinite redirect loop between login and dashboard.
  // The middleware (src/middleware.ts) is the single source of truth for auth.

  // Wait for auth + profile to fully load before checking access
  if (authLoading || !user) return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900">
      <div className="animate-spin w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full"></div>
    </div>
  );

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
          {/* FIX 9.3: Error Boundary wraps all dashboard content to prevent white-screen crashes */}
          <ErrorBoundary>
            {children}
          </ErrorBoundary>
        </main>
      </div>
    </div>
  );
}
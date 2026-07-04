"use client";
import { useState, useEffect, ReactNode } from "react";
import { useRouter, usePathname } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import Sidebar from "@/components/sections/Sidebar";
import TopNavbar from "@/components/sections/TopNavbar";
import { ShieldAlert } from "lucide-react";

// ✅ SIRF YE ROUTES ADMIN-ONLY HAIN
const ADMIN_ONLY_ROUTES = [
  "/dashboard/admin",
  "/dashboard/audit-log",
];

// ❌ PERMISSION_ROUTES WALI OBJECT PURA HATA DO (ISE DELETE KAR DO)

export default function DashboardLayout({ children }: { children: ReactNode }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const { user, role, loading, isAdmin } = useAuth(); // ✅ hasPermission bhi hata diya kyunki zaroorat nahi
  const router = useRouter();
  const pathname = usePathname();

  // Auth Protection
  useEffect(() => {
    if (!loading && !user) {
      router.push("/login");
    }
  }, [user, loading, router]);

  // Loading State
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-900">
        <div className="w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
      </div>
    );
  }

  if (!user) return null;

  // ✅ ADMIN-ONLY ROUTE CHECK
  const isAdminRoute = ADMIN_ONLY_ROUTES.some((route) => pathname.startsWith(route));

  if (isAdminRoute && !isAdmin) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-900 px-4">
        <div className="max-w-md text-center">
          <div className="w-20 h-20 bg-red-500/20 rounded-full flex items-center justify-center mx-auto mb-6">
            <ShieldAlert className="w-10 h-10 text-red-400" />
          </div>
          <h2 className="text-2xl font-bold text-white mb-3">Access Denied</h2>
          <p className="text-gray-400 mb-6 text-sm">
            You do not have Admin privileges to access this section.
          </p>
          <button
            onClick={() => router.push("/dashboard")}
            className="px-6 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium transition-colors"
          >
            Back to Dashboard
          </button>
        </div>
      </div>
    );
  }

  // ❌ PERMISSION-BASED ROUTE CHECK WALA FOR LOOP PURA HATA DO (ISE DELETE KAR DO)
  // Ab yahan se koi bhi page block nahi hoga, sirf Admin wale block honge

  return (
    <div className="min-h-screen flex bg-gray-900">
      <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      <div className="flex-1 flex flex-col">
        <TopNavbar onMenuClick={() => setSidebarOpen(true)} title="Osystic Finance" />
        <main className="flex-1 p-6 overflow-y-auto">
          {children}
        </main>
      </div>
    </div>
  );
}
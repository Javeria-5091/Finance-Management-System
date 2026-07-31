// src/app/dashboard/debug/page.tsx
"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/context/AuthContext";
import { usePermissions } from "@/context/PermissionContext";
import { supabase } from "@/lib/supabase";

interface DebugInfo {
  step: string;
  data: any;
  error: string | null;
}

export default function DebugPage() {
  const auth = useAuth();
  const perms = usePermissions();
  const [logs, setLogs] = useState<DebugInfo[]>([]);
  const [running, setRunning] = useState(false);

  const addLog = (step: string, data: any, error: string | null = null) => {
    setLogs(prev => [...prev, { step, data, error }]);
    console.log(`[DEBUG] ${step}:`, data, error || "");
  };

  const runDebug = async () => {
    setRunning(true);
    setLogs([]);

    // Step 1: Check Auth Context
    addLog("1. Auth Context Raw", {
      user: auth.user?.id || null,
      userEmail: auth.user?.email || null,
      profile: (auth as any).profile || null,
      role: (auth as any).role || null,
      isLoading: (auth as any).isLoading ?? (auth as any).loading ?? "NOT_FOUND",
      allKeys: Object.keys(auth),
    });

    // Step 2: Check Supabase Auth
    try {
      const { data: authData, error: authError } = await supabase.auth.getUser();
      addLog("2. Supabase Auth getUser", {
        userId: authData.user?.id,
        email: authData.user?.email,
      }, authError?.message);
    } catch (e: any) {
      addLog("2. Supabase Auth getUser", null, e.message);
    }

    // Step 3: Check profiles table
    try {
      const userId = auth.user?.id;
      if (userId) {
        const { data: profileData, error: profileError } = await supabase
          .from("profiles")
          .select("*")
          .eq("id", userId)
          .single();
        addLog("3. Profiles Table", profileData, profileError?.message);
      } else {
        addLog("3. Profiles Table", null, "No user ID available");
      }
    } catch (e: any) {
      addLog("3. Profiles Table", null, e.message);
    }

    // Step 4: Check user_roles table
    try {
      const userId = auth.user?.id;
      if (userId) {
        const { data: rolesData, error: rolesError } = await supabase
          .from("user_roles")
          .select("*")
          .eq("user_id", userId);
        addLog("4. User Roles Table (all)", rolesData, rolesError?.message);

        // Also try with active filter
        const { data: activeRoles, error: activeError } = await supabase
          .from("user_roles")
          .select("*")
          .eq("user_id", userId)
          .eq("is_active", true);
        addLog("4b. User Roles (active only)", activeRoles, activeError?.message);
      } else {
        addLog("4. User Roles Table", null, "No user ID available");
      }
    } catch (e: any) {
      addLog("4. User Roles Table", null, e.message);
    }

    // Step 5: Check Permission Context Result
    addLog("5. Permission Context Result", {
      role: perms.role,
      permissionsCount: perms.permissions.size,
      permissions: Array.from(perms.permissions).slice(0, 10),
      hasAdminAudit: perms.hasPermission("ADMIN_AUDIT"),
      hasAdminUsers: perms.hasPermission("ADMIN_USERS"),
      canInincomeRead: perms.can("INCOME_READ"),
      isLoading: perms.isLoading,
      error: perms.error,
    });

    // Step 6: Check if tables exist
    try {
      const { data: table1, error: err1 } = await supabase
        .from("profiles")
        .select("id")
        .limit(1);
      addLog("6a. profiles table exists", table1 ? "YES" : "NO", err1?.message);
    } catch (e: any) {
      addLog("6a. profiles table exists", null, e.message);
    }

    try {
      const { data: table2, error: err2 } = await supabase
        .from("user_roles")
        .select("id")
        .limit(1);
      addLog("6b. user_roles table exists", table2 ? "YES" : "NO", err2?.message);
    } catch (e: any) {
      addLog("6b. user_roles table exists", null, e.message);
    }

    // Step 7: Check all CEO users
    try {
      const { data: ceoData, error: ceoError } = await supabase
        .from("user_roles")
        .select("*, profiles(full_name, email)")
        .eq("role", "CEO");
      addLog("7. All CEO users in user_roles", ceoData, ceoError?.message);
    } catch (e: any) {
      addLog("7. All CEO users", null, e.message);
    }

    // Step 8: Try direct role check from profiles
    try {
      const userId = auth.user?.id;
      if (userId) {
        const { data: directRole, error: directError } = await supabase
          .from("profiles")
          .select("role")
          .eq("id", userId)
          .single();
        addLog("8. Direct role from profiles", directRole, directError?.message);
      }
    } catch (e: any) {
      addLog("8. Direct role from profiles", null, e.message);
    }

    setRunning(false);
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Permission Debug</h1>
          <p className="text-sm text-gray-500 mt-1">
            Yeh page check karega ke aapka role kyun VIEWER aa raha hai
          </p>
        </div>
        <button
          onClick={runDebug}
          disabled={running}
          className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
        >
          {running ? "Running..." : "Run Debug"}
        </button>
      </div>

      {/* Quick Summary */}
      <div className="grid grid-cols-2 gap-4">
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4">
          <p className="text-xs font-bold text-red-600 dark:text-red-400 uppercase">Current Role</p>
          <p className="text-2xl font-bold text-red-700 dark:text-red-300 mt-1">{perms.role}</p>
        </div>
        <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg p-4">
          <p className="text-xs font-bold text-yellow-600 dark:text-yellow-400 uppercase">ADMIN_AUDIT Permission</p>
          <p className="text-2xl font-bold text-yellow-700 dark:text-yellow-300 mt-1">
            {perms.hasPermission("ADMIN_AUDIT") ? "✅ YES" : "❌ NO"}
          </p>
        </div>
      </div>

      {/* Debug Logs */}
      <div className="bg-gray-900 rounded-xl p-4 overflow-auto max-h-[600px]">
        {logs.length === 0 ? (
          <p className="text-gray-500 text-sm">Click &quot;Run Debug&quot; to start...</p>
        ) : (
          <pre className="text-sm text-green-400 whitespace-pre-wrap">
            {logs.map((log, i) => (
              <div key={i} className="mb-4">
                <div className="text-yellow-400 font-bold">
                  ═══ {log.step} ═══
                </div>
                {log.error ? (
                  <div className="text-red-400 mt-1">
                    ❌ ERROR: {log.error}
                  </div>
                ) : (
                  <div className="text-green-300 mt-1">
                    {JSON.stringify(log.data, null, 2)}
                  </div>
                )}
              </div>
            ))}
          </pre>
        )}
      </div>

      {/* Instructions */}
      <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4">
        <h3 className="font-bold text-blue-800 dark:text-blue-300 mb-2">Debug Results Interpretation:</h3>
        <ul className="text-sm text-blue-700 dark:text-blue-400 space-y-1">
          <li>• Agar <strong>Step 3</strong> me error aaye → profiles table me role column nahi hai</li>
          <li>• Agar <strong>Step 4</strong> me error aaye → user_roles table ka RLS block kar raha hai</li>
          <li>• Agar <strong>Step 4</strong> me data empty → aapka user_id user_roles me nahi hai</li>
          <li>• Agar <strong>Step 7</strong> me koi data nahi → kisi ko bhi CEO role nahi mila</li>
          <li>• Agar <strong>Step 8</strong> me role null → profiles me role set nahi hai</li>
        </ul>
      </div>
    </div>
  );
}
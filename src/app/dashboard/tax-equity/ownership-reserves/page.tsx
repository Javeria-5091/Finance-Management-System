"use client";
import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/context/AuthContext";
import { usePermissions } from "@/context/PermissionContext";
import { PiggyBank, Pencil, Plus, Users, TrendingUp, X, Loader2, AlertTriangle } from "lucide-react";

/* ═══════════════════════════════════════════════════════
   OWNERSHIP & RESERVES — CEO Spec v1.3 Sections 5.8, 10.2
   P0: Organization-configurable, effective-dated,
   permission-controlled, ledger-linked.
   NOT hardcoded — all rules are setup data.
   ═══════════════════════════════════════════════════════ */

interface Owner {
  id: string;
  name: string;
  role: string | null;        // e.g. "Founder", "Shareholder", "Investor"
  ownership_pct: number;      // Must total 100% for overlapping periods
  effective_from: string;
  effective_to: string | null;
  is_active: boolean;
  notes: string | null;
  created_at: string;
}

interface ReservePolicy {
  id: string;
  reserve_name: string;
  reserve_type: string;       // "fixed_percentage", "target_balance", "custom"
  percentage: number | null;  // If type = fixed_percentage
  target_amount: number | null;
  ledger_account_id: string | null;
  effective_from: string;
  effective_to: string | null;
  is_active: boolean;
  description: string | null;
  created_at: string;
}

export default function OwnershipReservesPage() {
  const { user } = useAuth();
  const { hasPermission } = usePermissions();
  const canEdit = hasPermission("EQUITY_CREATE");

  const [owners, setOwners] = useState<Owner[]>([]);
  const [reserves, setReserves] = useState<ReservePolicy[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<"ownership" | "reserves">("ownership");

  const fetchData = useCallback(async () => {
    setLoading(true);
    const [ownerRes, reserveRes] = await Promise.all([
      supabase.from("owners").select("*").order("name").eq("is_active", true),
      supabase.from("reserve_policies").select("*").order("reserve_name").eq("is_active", true),
    ]);
    if (!ownerRes.error && ownerRes.data) setOwners(ownerRes.data as Owner[]);
    if (!reserveRes.error && reserveRes.data) setReserves(reserveRes.data as ReservePolicy[]);
    setLoading(false);
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const totalOwnership = owners.reduce((s, o) => s + o.ownership_pct, 0);
  const ownershipValid = Math.abs(totalOwnership - 100) < 0.01;

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <PiggyBank className="w-6 h-6 text-blue-600 dark:text-blue-400" />
          <div>
            <h2 className="text-2xl font-bold text-gray-900 dark:text-white">Ownership & Reserves</h2>
            <p className="text-gray-500 dark:text-gray-400 text-sm">
              Shareholder ownership & reserve policies — configurable, effective-dated (CEO Spec v1.3)
            </p>
          </div>
        </div>
      </div>

      {/* CEO Spec Warning */}
      <div className="mb-4 bg-blue-50 dark:bg-blue-900/10 border border-blue-200 dark:border-blue-800/30 rounded-xl p-4">
        <div className="flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-blue-600 dark:text-blue-400 mt-0.5 flex-shrink-0" />
          <div>
            <p className="text-sm font-medium text-blue-800 dark:text-blue-300">Configurable, Not Hardcoded</p>
            <p className="text-xs text-blue-700 dark:text-blue-400 mt-1">
              Per CEO Spec v1.3 Revision 1.1: OSYSTIC ownership and reserve logic must be generalized with configurable rules. These are setup data, not compiled source-code constants.
            </p>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-4 bg-gray-100 dark:bg-gray-800 rounded-lg p-1 w-fit">
        <button
          onClick={() => setActiveTab("ownership")}
          className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors ${activeTab === "ownership" ? "bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow-sm" : "text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"}`}
        >
          <Users size={14} /> Ownership
        </button>
        <button
          onClick={() => setActiveTab("reserves")}
          className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors ${activeTab === "reserves" ? "bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow-sm" : "text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"}`}
        >
          <PiggyBank size={14} /> Reserve Policies
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-48"><Loader2 className="w-8 h-8 animate-spin text-blue-500" /></div>
      ) : activeTab === "ownership" ? (
        <div>
          {/* Ownership Total Bar */}
          <div className={`mb-4 rounded-xl p-4 border ${ownershipValid ? "bg-green-50 dark:bg-green-900/10 border-green-200 dark:border-green-800/30" : "bg-red-50 dark:bg-red-900/10 border-red-200 dark:border-red-800/30"}`}>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs font-bold text-gray-500 uppercase">Total Ownership</p>
                <p className={`text-2xl font-bold ${ownershipValid ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}>
                  {totalOwnership.toFixed(2)}%
                </p>
              </div>
              {ownershipValid ? (
                <span className="text-xs font-bold text-green-600 bg-green-100 dark:bg-green-900/30 px-3 py-1 rounded-full">Valid — Totals 100%</span>
              ) : (
                <span className="text-xs font-bold text-red-600 bg-red-100 dark:bg-red-900/30 px-3 py-1 rounded-full">Invalid — Must Total 100%</span>
              )}
            </div>
          </div>

          {/* Owners Table */}
          <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden shadow-sm">
            <table className="w-full text-left text-sm">
              <thead className="bg-gray-50 dark:bg-gray-900/70 text-xs text-gray-600 dark:text-gray-400 uppercase tracking-wider">
                <tr>
                  <th className="px-4 py-3 font-semibold">Owner</th>
                  <th className="px-4 py-3 font-semibold hidden md:table-cell">Role</th>
                  <th className="px-4 py-3 font-semibold text-right">Ownership %</th>
                  <th className="px-4 py-3 font-semibold hidden lg:table-cell">Effective From</th>
                  <th className="px-4 py-3 font-semibold hidden lg:table-cell">Effective To</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                {owners.length === 0 ? (
                  <tr><td colSpan={5} className="px-4 py-12 text-center text-gray-400">No owners configured.</td></tr>
                ) : (
                  owners.map((o) => (
                    <tr key={o.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/30">
                      <td className="px-4 py-3 font-medium text-gray-900 dark:text-white">{o.name}</td>
                      <td className="px-4 py-3 text-gray-600 dark:text-gray-400 hidden md:table-cell">{o.role || "—"}</td>
                      <td className="px-4 py-3 text-right font-bold text-blue-600 dark:text-blue-400">{o.ownership_pct}%</td>
                      <td className="px-4 py-3 text-gray-500 text-xs hidden lg:table-cell">{o.effective_from}</td>
                      <td className="px-4 py-3 text-gray-500 text-xs hidden lg:table-cell">{o.effective_to || "Open-ended"}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div>
          {/* Reserves Table */}
          <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden shadow-sm">
            <table className="w-full text-left text-sm">
              <thead className="bg-gray-50 dark:bg-gray-900/70 text-xs text-gray-600 dark:text-gray-400 uppercase tracking-wider">
                <tr>
                  <th className="px-4 py-3 font-semibold">Reserve</th>
                  <th className="px-4 py-3 font-semibold hidden md:table-cell">Type</th>
                  <th className="px-4 py-3 font-semibold text-right hidden md:table-cell">Percentage / Target</th>
                  <th className="px-4 py-3 font-semibold hidden lg:table-cell">Effective From</th>
                  <th className="px-4 py-3 font-semibold hidden lg:table-cell">Description</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                {reserves.length === 0 ? (
                  <tr><td colSpan={5} className="px-4 py-12 text-center text-gray-400">No reserve policies configured.</td></tr>
                ) : (
                  reserves.map((r) => (
                    <tr key={r.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/30">
                      <td className="px-4 py-3 font-medium text-gray-900 dark:text-white">{r.reserve_name}</td>
                      <td className="px-4 py-3 hidden md:table-cell">
                        <span className="px-2 py-0.5 text-[10px] font-bold uppercase rounded bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-400">
                          {r.reserve_type?.replace(/_/g, " ")}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right font-medium text-gray-900 dark:text-white hidden md:table-cell">
                        {r.percentage !== null ? `${r.percentage}%` : r.target_amount ? `PKR ${r.target_amount.toLocaleString()}` : "—"}
                      </td>
                      <td className="px-4 py-3 text-gray-500 text-xs hidden lg:table-cell">{r.effective_from}</td>
                      <td className="px-4 py-3 text-gray-500 text-xs hidden lg:table-cell max-w-[200px] truncate">{r.description || "—"}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
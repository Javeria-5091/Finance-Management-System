"use client";
import { useState } from "react";
import { useAuth } from "@/context/AuthContext";
import { usePermissions } from "@/context/PermissionContext";
import { useTheme } from "@/context/ThemeContext";
import {
  useFixedAssets,
  useAssetKPIs,
  useCapitalizeAsset,
  useDisposeAsset,
} from "@/hooks/useFixedAssets";
import { Plus, Search, Building2, TrendingDown, CheckCircle2, Clock, AlertTriangle, Trash2, Eye } from "lucide-react";
import { logAction, logAudit } from "@/lib/logAction";
import toast from "react-hot-toast";
import type { AssetStatus, FixedAsset } from "@/types/fixed-assets.types";
import AssetForm from "@/components/sections/AssetForm";
import { useRouter } from "next/navigation";

const STATUS_STYLES: Record<AssetStatus, { label: string; classes: string }> = {
  pending_capitalization: { label: "Pending Cap.", classes: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400" },
  active: { label: "Active", classes: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400" },
  fully_depreciated: { label: "Fully Depr.", classes: "bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300" },
  under_repair: { label: "Under Repair", classes: "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-400" },
  disposed: { label: "Disposed", classes: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400" },
  sold: { label: "Sold", classes: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400" },
};

function formatPKR(amount: number): string {
  return new Intl.NumberFormat('en-PK', { style: 'currency', currency: 'PKR', minimumFractionDigits: 0 }).format(amount);
}

export default function FixedAssetsPage() {
  const { user } = useAuth();
  const { hasPermission } = usePermissions();
  const { isDark } = useTheme();
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [showDetail, setShowDetail] = useState<string | null>(null);
  const [showAssetForm, setShowAssetForm] = useState(false);
  const [editAsset, setEditAsset] = useState<FixedAsset | null>(null);
  const { data: assets = [], isLoading } = useFixedAssets({
    status: statusFilter !== "all" ? (statusFilter as AssetStatus) : undefined,
    search: search || undefined,
  });
  const { data: kpis } = useAssetKPIs();
  const capitalizeMut = useCapitalizeAsset();
  const disposeMut = useDisposeAsset();

 const handleCapitalize = (id: string) => {
    if (!user?.id) return;
    capitalizeMut.mutate({ id, userId: user.id }, {
      onSuccess: () => {
        toast.success("Asset capitalized successfully");
        logAudit.update("fixed_assets", id, "Asset capitalized");
      },
      onError: (e: Error) => toast.error(e.message),
    });
  };

  return (
    <div className={`p-6 min-h-screen ${isDark ? "bg-gray-900 text-gray-100" : "bg-gray-50 text-gray-900"}`}>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Fixed Assets</h1>
          <p className={`text-sm mt-1 ${isDark ? "text-gray-400" : "text-gray-500"}`}>Asset register, depreciation, and verification management</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => router.push("/dashboard/assets/verifications")} className={`px-3 py-2 text-sm rounded-lg border ${isDark ? "border-gray-700 hover:bg-gray-800 text-gray-300" : "border-gray-300 hover:bg-gray-100 text-gray-700"}`}>
            <CheckCircle2 className="h-4 w-4 inline mr-1" /> Verifications
          </button>
          <button onClick={() => router.push("/dashboard/assets/depreciation")} className={`px-3 py-2 text-sm rounded-lg border ${isDark ? "border-gray-700 hover:bg-gray-800 text-gray-300" : "border-gray-300 hover:bg-gray-100 text-gray-700"}`}>
            <TrendingDown className="h-4 w-4 inline mr-1" /> Depreciation
          </button>
          {hasPermission("FIXED_ASSET_CREATE") && (
            <button onClick={() => setShowAssetForm(true)} className="px-3 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white">
              <Plus className="h-4 w-4 inline mr-1" /> Add Asset
            </button>
          )}
        </div>
      </div>

      {/* KPI Cards */}
      {kpis && (
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3 mb-6">
          {[
            { label: "Total Assets", value: kpis.total_assets.toString() },
            { label: "Total Cost", value: formatPKR(kpis.total_cost) },
            { label: "NBV", value: formatPKR(kpis.total_net_book_value), highlight: true },
            { label: "Accum. Depr.", value: formatPKR(kpis.total_accumulated_depreciation) },
            { label: "Active", value: kpis.active_count.toString() },
            { label: "Fully Depr.", value: kpis.fully_depreciated_count.toString() },
            { label: "Pending Cap.", value: kpis.pending_capitalization_count.toString() },
          ].map((kpi) => (
            <div key={kpi.label} className={`p-3 rounded-lg border ${kpi.highlight ? (isDark ? "border-emerald-700 bg-emerald-900/20" : "border-emerald-300 bg-emerald-50") : (isDark ? "border-gray-700 bg-gray-800/50" : "border-gray-200 bg-white")}`}>
              <div className={`text-xs ${isDark ? "text-gray-400" : "text-gray-500"}`}>{kpi.label}</div>
              <div className={`text-lg font-bold mt-1 ${kpi.highlight ? "text-emerald-500" : ""}`}>{kpi.value}</div>
            </div>
          ))}
        </div>
      )}

      {/* Filters */}
      <div className="flex items-center gap-3 mb-4">
        <div className="relative flex-1 max-w-sm">
          <Search className={`absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 ${isDark ? "text-gray-500" : "text-gray-400"}`} />
          <input
            type="text"
            placeholder="Search by code, name, or serial..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className={`w-full pl-9 pr-3 py-2 rounded-lg border text-sm ${isDark ? "bg-gray-800 border-gray-700 text-gray-100 placeholder-gray-500" : "bg-white border-gray-300 text-gray-900 placeholder-gray-400"}`}
          />
        </div>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className={`px-3 py-2 rounded-lg border text-sm ${isDark ? "bg-gray-800 border-gray-700 text-gray-100" : "bg-white border-gray-300 text-gray-900"}`}
        >
          <option value="all">All Statuses</option>
          <option value="pending_capitalization">Pending Capitalization</option>
          <option value="active">Active</option>
          <option value="fully_depreciated">Fully Depreciated</option>
          <option value="under_repair">Under Repair</option>
          <option value="disposed">Disposed</option>
          <option value="sold">Sold</option>
        </select>
      </div>

      {/* Table */}
      <div className={`border rounded-lg overflow-hidden ${isDark ? "border-gray-700" : "border-gray-200"}`}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className={isDark ? "bg-gray-800/80 border-b border-gray-700" : "bg-gray-50 border-b border-gray-200"}>
                <th className={`text-left px-4 py-3 font-medium ${isDark ? "text-gray-400" : "text-gray-500"}`}>Code</th>
                <th className={`text-left px-4 py-3 font-medium ${isDark ? "text-gray-400" : "text-gray-500"}`}>Asset Name</th>
                <th className={`text-left px-4 py-3 font-medium ${isDark ? "text-gray-400" : "text-gray-500"}`}>Category</th>
                <th className={`text-right px-4 py-3 font-medium ${isDark ? "text-gray-400" : "text-gray-500"}`}>Cost (PKR)</th>
                <th className={`text-right px-4 py-3 font-medium ${isDark ? "text-gray-400" : "text-gray-500"}`}>Accum. Depr.</th>
                <th className={`text-right px-4 py-3 font-medium ${isDark ? "text-gray-400" : "text-gray-500"}`}>NBV</th>
                <th className={`text-left px-4 py-3 font-medium ${isDark ? "text-gray-400" : "text-gray-500"}`}>Status</th>
                <th className={`text-left px-4 py-3 font-medium ${isDark ? "text-gray-400" : "text-gray-500"}`}>Location</th>
                <th className={`text-center px-4 py-3 font-medium ${isDark ? "text-gray-400" : "text-gray-500"}`}>Actions</th>
              </tr>
            </thead>
            <tbody className={`divide-y ${isDark ? "divide-gray-800" : "divide-gray-100"}`}>
              {isLoading ? (
                <tr><td colSpan={9} className="px-4 py-12 text-center text-gray-500">Loading assets...</td></tr>
              ) : assets.length === 0 ? (
                <tr><td colSpan={9} className="px-4 py-12 text-center text-gray-500">No assets found. Add your first fixed asset.</td></tr>
              ) : (
                assets.map((asset) => {
                  const style = STATUS_STYLES[asset.status];
                  return (
                    <tr key={asset.id} className={`transition-colors cursor-pointer ${isDark ? "hover:bg-gray-800/30" : "hover:bg-gray-50"}`}
                      onClick={() => setShowDetail(showDetail === asset.id ? null : asset.id)}>
                      <td className="px-4 py-3 font-mono text-xs">{asset.code}</td>
                      <td className="px-4 py-3 font-medium">{asset.name}</td>
                      <td className={`px-4 py-3 ${isDark ? "text-gray-400" : "text-gray-500"}`}>{asset.category_name}</td>
                      <td className="px-4 py-3 text-right font-mono">{formatPKR(asset.base_cost)}</td>
                      <td className="px-4 py-3 text-right font-mono text-red-500">{formatPKR(asset.accumulated_depreciation)}</td>
                      <td className="px-4 py-3 text-right font-mono text-emerald-500 font-medium">{formatPKR(asset.net_book_value)}</td>
                      <td className="px-4 py-3">
                        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${style.classes}`}>{style.label}</span>
                      </td>
                      <td className={`px-4 py-3 text-xs ${isDark ? "text-gray-400" : "text-gray-500"}`}>{asset.location || "—"}</td>
                      <td className="px-4 py-3 text-center" onClick={(e) => e.stopPropagation()}>
                        {asset.status === "pending_capitalization" && hasPermission("FIXED_ASSET_CREATE") && (
                          <button onClick={() => handleCapitalize(asset.id)} className="text-xs text-blue-500 hover:text-blue-400 mr-2">Capitalize</button>
                        )}
                        <button className={`text-xs ${isDark ? "text-gray-400 hover:text-gray-200" : "text-gray-500 hover:text-gray-700"}`}>
                          <Eye className="h-3.5 w-3.5 inline" />
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Detail Panel */}
      {showDetail && (() => {
        const asset = assets.find(a => a.id === showDetail);
        if (!asset) return null;
        return (
          <div className={`mt-4 p-4 rounded-lg border ${isDark ? "bg-gray-800 border-gray-700" : "bg-white border-gray-200"}`}>
            <div className="flex justify-between items-start mb-3">
              <h3 className="text-lg font-bold">{asset.name} <span className="text-sm font-mono text-gray-500">{asset.code}</span></h3>
              <button onClick={() => setShowDetail(null)} className="text-gray-400 hover:text-gray-600">&times;</button>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
              <div><span className="text-gray-500 block text-xs">Category</span>{asset.category_name}</div>
              <div><span className="text-gray-500 block text-xs">Purchase Date</span>{asset.purchase_date}</div>
              <div><span className="text-gray-500 block text-xs">Cost</span>{formatPKR(asset.purchase_cost)} {asset.currency_code}</div>
              <div><span className="text-gray-500 block text-xs">Base Cost (PKR)</span>{formatPKR(asset.base_cost)}</div>
              <div><span className="text-gray-500 block text-xs">Accum. Depreciation</span><span className="text-red-500">{formatPKR(asset.accumulated_depreciation)}</span></div>
              <div><span className="text-gray-500 block text-xs">Net Book Value</span><span className="text-emerald-500 font-medium">{formatPKR(asset.net_book_value)}</span></div>
              <div><span className="text-gray-500 block text-xs">Location</span>{asset.location || "—"}</div>
              <div><span className="text-gray-500 block text-xs">Serial No.</span>{asset.serial_number || "—"}</div>
            </div>
          </div>
        );
      })()}
      {showAssetForm && (
        <AssetForm
          onClose={() => { setShowAssetForm(false); setEditAsset(null); }}
          onSuccess={() => {}}
        />
      )}
    </div>
  );
}
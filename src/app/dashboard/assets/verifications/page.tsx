"use client";

import { useState } from "react";
import { useAuth } from "@/context/AuthContext";
import { usePermissions } from "@/context/PermissionContext";
import { useTheme } from "@/context/ThemeContext";
import {
  useAssetVerifications,
  useAssetVerificationById,
  useCreateVerification,
  useUpdateVerificationLine,
  useCompleteVerification,
} from "@/hooks/useFixedAssets";
import { logAudit } from "@/lib/logAction";
import toast from "react-hot-toast";
import { Plus, ArrowLeft, CheckCircle2, ClipboardCheck, Save, AlertTriangle } from "lucide-react";
import type { AssetVerificationLine } from "@/types/fixed-assets.types";

// =============================================================================
// Asset Verifications Page
// Convention: P0 style — raw HTML + Tailwind, no shadcn
// File: src/app/dashboard/assets/verifications/page.tsx
// =============================================================================

// ─── ConfirmDialog Component (inline modal popup) ──────────────────────────

function ConfirmDialog({
  open,
  onConfirm,
  onCancel,
  title,
  message,
  confirmLabel,
  cancelLabel,
  loading,
  variant,
}: {
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  loading?: boolean;
  variant?: "danger" | "warning" | "info";
}) {
  if (!open) return null;

  const btnVariant = variant === "danger"
    ? "bg-red-600 hover:bg-red-700"
    : variant === "warning"
    ? "bg-yellow-600 hover:bg-yellow-700"
    : "bg-blue-600 hover:bg-blue-700";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onCancel} />

      {/* Dialog Box */}
      <div className="relative bg-white dark:bg-gray-800 rounded-xl shadow-2xl border border-gray-200 dark:border-gray-700 p-6 w-full max-w-md mx-4 z-10">
        {/* Icon */}
        <div className={`flex items-center gap-3 mb-4 ${
          variant === "danger"
            ? "text-red-500"
            : variant === "warning"
            ? "text-yellow-500"
            : "text-blue-500"
        }`}>
          <AlertTriangle className="h-6 w-6 flex-shrink-0" />
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{title}</h3>
        </div>

        {/* Message */}
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-6 leading-relaxed">{message}</p>

        {/* Actions */}
        <div className="flex items-center justify-end gap-3">
          <button
            onClick={onCancel}
            disabled={loading}
            className="px-4 py-2 rounded-lg text-sm font-medium border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors disabled:opacity-50"
          >
            {cancelLabel || "Cancel"}
          </button>
          <button
            onClick={onConfirm}
            disabled={loading}
            className={`px-4 py-2 rounded-lg text-sm font-medium text-white transition-colors disabled:opacity-50 ${btnVariant}`}
          >
            {loading ? "Processing..." : (confirmLabel || "Confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}

const STATUS_BADGE: Record<string, { label: string; classes: string }> = {
  in_progress: { label: "In Progress", classes: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400" },
  completed: { label: "Completed", classes: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400" },
  discrepancy_found: { label: "Discrepancy", classes: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400" },
};

export default function VerificationsPage() {
  const { user } = useAuth();
  const { hasPermission } = usePermissions();
  const { isDark } = useTheme();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [completionNotes, setCompletionNotes] = useState("");
  const [localLines, setLocalLines] = useState<Map<string, Partial<AssetVerificationLine>>>(new Map());

  // ─── Confirm dialog states ──────────────────────────────────────────
  const [showCompleteConfirm, setShowCompleteConfirm] = useState(false);

  const { data: verifications = [], isLoading } = useAssetVerifications();
  const { data: verification, isLoading: detailLoading } = useAssetVerificationById(selectedId);

  const createMut = useCreateVerification();
  const updateLineMut = useUpdateVerificationLine();
  const completeMut = useCompleteVerification();

  // ─── Create Handler ────────────────────────────────────────────────
  const handleCreate = () => {
    if (!user?.id) return;
    const today = new Date().toISOString().split("T")[0];
    createMut.mutate(
      { date: today, userId: user.id },
      {
        onSuccess: (v) => {
          toast.success("Verification created successfully");
          logAudit.create("asset_verifications", v.id, `New verification ${v.verification_code}`);
          setSelectedId(v.id);
        },
        onError: (err: Error) => toast.error(err.message),
      }
    );
  };

  // ─── Line Change Handler ────────────────────────────────────────────
  const handleLineChange = (lineId: string, field: string, value: string | boolean) => {
    setLocalLines((prev) => {
      const next = new Map(prev);
      next.set(lineId, { ...next.get(lineId), [field]: value });
      return next;
    });
  };

  // ─── Save Line Handler ──────────────────────────────────────────────
  const handleSaveLine = (lineId: string) => {
    const updates = localLines.get(lineId);
    if (!updates) return;
    updateLineMut.mutate(
      { lineId, updates: updates as { is_verified?: boolean; physical_location?: string; physical_condition?: string; discrepancy_notes?: string } },
      {
        onSuccess: () => {
          setLocalLines((prev) => {
            const next = new Map(prev);
            next.delete(lineId);
            return next;
          });
          toast.success("Line updated");
        },
        onError: (err: Error) => toast.error(err.message),
      }
    );
  };

  // ─── Complete Handler (opens confirm dialog) ─────────────────────────
  const handleCompleteClick = () => {
    if (!selectedId) return;
    setShowCompleteConfirm(true);
  };

  const confirmComplete = () => {
    setShowCompleteConfirm(false);
    completeMut.mutate(
      { verificationId: selectedId!, notes: completionNotes },
      {
        onSuccess: () => {
          toast.success("Verification completed");
          logAudit.update("asset_verifications", selectedId!, "Verification completed");
          setSelectedId(null);
          setCompletionNotes("");
          setLocalLines(new Map());
        },
        onError: (err: Error) => toast.error(err.message),
      }
    );
  };

  const inputCls = `px-3 py-2 rounded-lg border text-sm ${
    isDark
      ? "bg-gray-800 border-gray-700 text-gray-100 placeholder-gray-500 focus:border-blue-500"
      : "bg-white border-gray-300 text-gray-900 placeholder-gray-400 focus:border-blue-500"
  } focus:outline-none focus:ring-1 focus:ring-blue-500`;

  const smallInputCls = `${inputCls} py-1 text-xs`;

  // =========================================================================
  // DETAIL VIEW — single verification with its asset lines
  // =========================================================================
  if (selectedId && verification) {
    const lines = verification.lines || [];
    const verifiedCount = lines.filter((l) => l.is_verified).length;
    const discrepancyCount = lines.filter((l) => !!l.discrepancy_notes).length;
    const hasUnsavedChanges = localLines.size > 0;
    // FIXED: permission code now matches DB seed "FIXED_ASSET_VERIFY_UPDATE"
    const canEdit = verification.status === "in_progress" && hasPermission("FIXED_ASSET_VERIFY_UPDATE");

    return (
      <div className={`p-6 min-h-screen ${isDark ? "bg-gray-900 text-gray-100" : "bg-gray-50 text-gray-900"}`}>
        {/* Complete Confirmation Dialog */}
        <ConfirmDialog
          open={showCompleteConfirm}
          title="Complete Verification"
          message={`Are you sure you want to complete verification ${verification.verification_code}? This will finalize all verification results and cannot be undone.${hasUnsavedChanges ? " You have unsaved changes that will NOT be included." : ""}`}
          confirmLabel="Complete Verification"
          cancelLabel="Cancel"
          onConfirm={confirmComplete}
          onCancel={() => setShowCompleteConfirm(false)}
          loading={completeMut.isPending}
          variant="warning"
        />

        {/* Header with back button */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <button
              onClick={() => { setSelectedId(null); setLocalLines(new Map()); setCompletionNotes(""); }}
              className={`p-2 rounded-lg transition-colors ${isDark ? "hover:bg-gray-800" : "hover:bg-gray-100"}`}
            >
              <ArrowLeft className="h-5 w-5" />
            </button>
            <div>
              <h1 className="text-xl font-bold">{verification.verification_code}</h1>
              <p className={`text-sm ${isDark ? "text-gray-400" : "text-gray-500"}`}>
                {verification.verification_date} &middot; {verifiedCount}/{lines.length} verified
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {hasUnsavedChanges && (
              <span className="text-xs text-orange-500 font-medium">Unsaved changes ({localLines.size})</span>
            )}
            {/* FIXED: permission code now matches DB seed "FIXED_ASSET_VERIFY_UPDATE" */}
            {verification.status === "in_progress" && hasPermission("FIXED_ASSET_VERIFY_UPDATE") && (
              <button
                onClick={handleCompleteClick}
                disabled={hasUnsavedChanges}
                className="px-4 py-2 rounded-lg bg-green-600 hover:bg-green-700 text-white text-sm font-medium disabled:opacity-50 flex items-center gap-1 transition-colors"
              >
                <CheckCircle2 className="h-4 w-4" />
                Complete Verification
              </button>
            )}
          </div>
        </div>

        {/* Stats Row */}
        <div className="grid grid-cols-3 gap-3 mb-6">
          <div className={`p-3 rounded-lg border ${isDark ? "border-gray-700 bg-gray-800/50" : "border-gray-200 bg-white"}`}>
            <div className="text-xs text-gray-500">Total Assets</div>
            <div className="text-xl font-bold mt-1">{lines.length}</div>
          </div>
          <div className={`p-3 rounded-lg border ${isDark ? "border-green-700 bg-green-900/20" : "border-green-200 bg-green-50"}`}>
            <div className="text-xs text-green-600">Verified</div>
            <div className="text-xl font-bold mt-1 text-green-500">{verifiedCount}</div>
          </div>
          <div className={`p-3 rounded-lg border ${discrepancyCount > 0 ? (isDark ? "border-red-700 bg-red-900/20" : "border-red-200 bg-red-50") : (isDark ? "border-gray-700 bg-gray-800/50" : "border-gray-200 bg-white")}`}>
            <div className="text-xs text-red-600">Discrepancies</div>
            <div className="text-xl font-bold mt-1 text-red-500">{discrepancyCount}</div>
          </div>
        </div>

        {/* Completion Notes */}
        <div className="mb-4">
          <label className={`block text-sm font-medium mb-1 ${isDark ? "text-gray-300" : "text-gray-700"}`}>
            Completion Notes
          </label>
          <textarea
            value={completionNotes}
            onChange={(e) => setCompletionNotes(e.target.value)}
            className={inputCls}
            rows={2}
            placeholder="Any observations or notes about this verification..."
            disabled={!canEdit}
          />
        </div>

        {/* Asset Lines Table */}
        <div className={`border rounded-lg overflow-hidden ${isDark ? "border-gray-700" : "border-gray-200"}`}>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className={isDark ? "bg-gray-800/80 border-b border-gray-700" : "bg-gray-50 border-b border-gray-200"}>
                  <th className={`text-left px-4 py-3 font-medium ${isDark ? "text-gray-400" : "text-gray-500"}`}>Code</th>
                  <th className={`text-left px-4 py-3 font-medium ${isDark ? "text-gray-400" : "text-gray-500"}`}>Asset Name</th>
                  <th className={`text-left px-4 py-3 font-medium ${isDark ? "text-gray-400" : "text-gray-500"}`}>System Loc.</th>
                  <th className={`text-left px-4 py-3 font-medium ${isDark ? "text-gray-400" : "text-gray-500"}`}>Physical Loc.</th>
                  <th className={`text-left px-4 py-3 font-medium ${isDark ? "text-gray-400" : "text-gray-500"}`}>Condition</th>
                  <th className={`text-center px-4 py-3 font-medium ${isDark ? "text-gray-400" : "text-gray-500"}`}>Verified</th>
                  <th className={`text-left px-4 py-3 font-medium ${isDark ? "text-gray-400" : "text-gray-500"}`}>Discrepancy Notes</th>
                  <th className={`text-center px-4 py-3 font-medium ${isDark ? "text-gray-400" : "text-gray-500"}`}>Action</th>
                </tr>
              </thead>
              <tbody className={`divide-y ${isDark ? "divide-gray-800" : "divide-gray-100"}`}>
                {detailLoading ? (
                  <tr><td colSpan={8} className="px-4 py-12 text-center text-gray-500">Loading...</td></tr>
                ) : lines.length === 0 ? (
                  <tr><td colSpan={8} className="px-4 py-12 text-center text-gray-500">No assets in this verification.</td></tr>
                ) : (
                  lines.map((line) => {
                    const local = localLines.get(line.id) || {};
                    const displayVerified = local.is_verified !== undefined ? local.is_verified : line.is_verified;
                    const hasChanges = localLines.has(line.id);

                    return (
                      <tr key={line.id} className={`transition-colors ${isDark ? "hover:bg-gray-800/30" : "hover:bg-gray-50"} ${hasChanges ? (isDark ? "bg-blue-900/10" : "bg-blue-50/50") : ""}`}>
                        <td className="px-4 py-2 font-mono text-xs">{line.asset_code}</td>
                        <td className="px-4 py-2 font-medium">{line.asset_name}</td>
                        <td className={`px-4 py-2 text-xs ${isDark ? "text-gray-400" : "text-gray-500"}`}>{line.asset_location || "—"}</td>
                        <td className="px-4 py-2">
                          {canEdit ? (
                            <input
                              type="text"
                              value={local.physical_location !== undefined ? local.physical_location : (line.physical_location || "")}
                              onChange={(e) => handleLineChange(line.id, "physical_location", e.target.value)}
                              className={`${smallInputCls} w-32`}
                              placeholder="Physical loc."
                            />
                          ) : (
                            <span className="text-xs">{line.physical_location || "—"}</span>
                          )}
                        </td>
                        <td className="px-4 py-2">
                          {canEdit ? (
                            <input
                              type="text"
                              value={local.physical_condition !== undefined ? local.physical_condition : (line.physical_condition || "")}
                              onChange={(e) => handleLineChange(line.id, "physical_condition", e.target.value)}
                              className={`${smallInputCls} w-24`}
                              placeholder="Condition"
                            />
                          ) : (
                            <span className="text-xs">{line.physical_condition || "—"}</span>
                          )}
                        </td>
                        <td className="px-4 py-2 text-center">
                          {canEdit ? (
                            <input
                              type="checkbox"
                              checked={!!displayVerified}
                              onChange={(e) => handleLineChange(line.id, "is_verified", e.target.checked)}
                              className="h-4 w-4 rounded"
                            />
                          ) : (
                            <CheckCircle2 className={`h-4 w-4 inline ${displayVerified ? "text-green-500" : "text-gray-400"}`} />
                          )}
                        </td>
                        <td className="px-4 py-2">
                          {canEdit ? (
                            <input
                              type="text"
                              value={local.discrepancy_notes !== undefined ? local.discrepancy_notes : (line.discrepancy_notes || "")}
                              onChange={(e) => handleLineChange(line.id, "discrepancy_notes", e.target.value)}
                              className={`${smallInputCls} w-36`}
                              placeholder="Notes..."
                            />
                          ) : (
                            <span className={`text-xs ${line.discrepancy_notes ? "text-red-500 font-medium" : ""}`}>
                              {line.discrepancy_notes || "—"}
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-2 text-center">
                          {hasChanges && (
                            <button
                              onClick={() => handleSaveLine(line.id)}
                              disabled={updateLineMut.isPending}
                              className="text-xs text-blue-500 hover:text-blue-400 disabled:opacity-50 transition-colors"
                            >
                              <Save className="h-3.5 w-3.5 inline mr-1" />
                              Save
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    );
  }

  // =========================================================================
  // LIST VIEW — all verifications
  // =========================================================================
  return (
    <div className={`p-6 min-h-screen ${isDark ? "bg-gray-900 text-gray-100" : "bg-gray-50 text-gray-900"}`}>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Asset Verifications</h1>
          <p className={`text-sm mt-1 ${isDark ? "text-gray-400" : "text-gray-500"}`}>
            Physical verification and reconciliation of fixed assets
          </p>
        </div>
        {/* FIXED: permission code now matches DB seed "FIXED_ASSET_VERIFY_CREATE" */}
        {hasPermission("FIXED_ASSET_VERIFY_CREATE") && (
          <button
            onClick={handleCreate}
            disabled={createMut.isPending}
            className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium disabled:opacity-50 flex items-center gap-1 transition-colors"
          >
            <Plus className="h-4 w-4" />
            {createMut.isPending ? "Creating..." : "New Verification"}
          </button>
        )}
      </div>

      {/* Verifications Table */}
      <div className={`border rounded-lg overflow-hidden ${isDark ? "border-gray-700" : "border-gray-200"}`}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className={isDark ? "bg-gray-800/80 border-b border-gray-700" : "bg-gray-50 border-b border-gray-200"}>
                <th className={`text-left px-4 py-3 font-medium ${isDark ? "text-gray-400" : "text-gray-500"}`}>Verification Code</th>
                <th className={`text-left px-4 py-3 font-medium ${isDark ? "text-gray-400" : "text-gray-500"}`}>Date</th>
                <th className={`text-left px-4 py-3 font-medium ${isDark ? "text-gray-400" : "text-gray-500"}`}>Status</th>
                <th className={`text-right px-4 py-3 font-medium ${isDark ? "text-gray-400" : "text-gray-500"}`}>Total Assets</th>
                <th className={`text-right px-4 py-3 font-medium ${isDark ? "text-gray-400" : "text-gray-500"}`}>Verified</th>
                <th className={`text-right px-4 py-3 font-medium ${isDark ? "text-gray-400" : "text-gray-500"}`}>Discrepancies</th>
                <th className={`text-center px-4 py-3 font-medium ${isDark ? "text-gray-400" : "text-gray-500"}`}>Action</th>
              </tr>
            </thead>
            <tbody className={`divide-y ${isDark ? "divide-gray-800" : "divide-gray-100"}`}>
              {isLoading ? (
                <tr><td colSpan={7} className="px-4 py-12 text-center text-gray-500">Loading verifications...</td></tr>
              ) : verifications.length === 0 ? (
                <tr><td colSpan={7} className="px-4 py-12 text-center text-gray-500">
                  No verifications found. Click &quot;New Verification&quot; to start.
                </td></tr>
              ) : (
                verifications.map((v) => {
                  const badge = STATUS_BADGE[v.status] || STATUS_BADGE.in_progress;
                  return (
                    <tr
                      key={v.id}
                      className={`cursor-pointer transition-colors ${isDark ? "hover:bg-gray-800/30" : "hover:bg-gray-50"}`}
                      onClick={() => setSelectedId(v.id)}
                    >
                      <td className="px-4 py-3 font-mono text-sm font-medium">{v.verification_code}</td>
                      <td className="px-4 py-3">{v.verification_date}</td>
                      <td className="px-4 py-3">
                        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${badge.classes}`}>{badge.label}</span>
                      </td>
                      <td className="px-4 py-3 text-right font-medium">{v.total_assets || 0}</td>
                      <td className="px-4 py-3 text-right text-green-500">{v.verified_count || 0}</td>
                      <td className="px-4 py-3 text-right">
                        <span className={(v.discrepancy_count || 0) > 0 ? "text-red-500 font-medium" : ""}>
                          {v.discrepancy_count || 0}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-center">
                        <ClipboardCheck className={`h-4 w-4 inline ${isDark ? "text-gray-400" : "text-gray-500"}`} />
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
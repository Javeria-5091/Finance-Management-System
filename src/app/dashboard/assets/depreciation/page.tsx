"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/context/AuthContext";
import { usePermissions } from "@/context/PermissionContext";
import { useTheme } from "@/context/ThemeContext";
import {
  useDepreciationSchedule,
  useGenerateDepreciation,
  usePostDepreciation,
  useAccountingPeriods,
  useAssetKPIs,
} from "@/hooks/useFixedAssets";
import { logAudit } from "@/lib/logAction";
import toast from "react-hot-toast";
import {
  Calculator,
  CheckCircle2,
  AlertTriangle,
  TrendingDown,
  ShieldX,
  Loader2,
} from "lucide-react";

// =============================================================================
// Depreciation Management Page
// File: src/app/dashboard/assets/depreciation/page.tsx
// =============================================================================

function formatPKR(amount: number): string {
  return new Intl.NumberFormat("en-PK", {
    style: "currency",
    currency: "PKR",
    minimumFractionDigits: 0,
  }).format(amount);
}

const STATUS_BADGE: Record<string, { label: string; classes: string }> = {
  calculated: {
    label: "Calculated",
    classes:
      "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
  },
  posted: {
    label: "Posted",
    classes:
      "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400",
  },
  reversed: {
    label: "Reversed",
    classes: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400",
  },
  skipped: {
    label: "Skipped",
    classes:
      "bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400",
  },
};

export default function DepreciationPage() {
  const { user } = useAuth();
  const { hasPermission } = usePermissions();
  const { isDark } = useTheme();
  const queryClient = useQueryClient();

  const [selectedPeriodId, setSelectedPeriodId] = useState<string>("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [generationResult, setGenerationResult] = useState<{
    generated: number;
    total_amount: number;
    details: {
      asset_id: string;
      asset_code: string;
      asset_name: string;
      depreciation_amount: number;
      status: string;
    }[];
  } | null>(null);

  const { data: periods = [], isLoading: periodsLoading } =
    useAccountingPeriods();
  const { data: kpis } = useAssetKPIs();
  const { data: schedule = [], isLoading: scheduleLoading } =
    useDepreciationSchedule({
      period_id: selectedPeriodId || undefined,
      status: statusFilter !== "all" ? statusFilter : undefined,
    });

  const generateMut = useGenerateDepreciation();
  const postMut = usePostDepreciation();

  // ── Derived values ────────────────────────────────────────────────────
  const totalCalculated = schedule
    .filter((s) => s.status === "calculated")
    .reduce((sum, s) => sum + s.depreciation_amount, 0);

  const totalPosted = schedule
    .filter((s) => s.status === "posted")
    .reduce((sum, s) => sum + s.depreciation_amount, 0);

  // ── Permission checks ─────────────────────────────────────────────────
  const hasGeneratePerm = hasPermission("FIXED_ASSET_DEPR_GENERATE");
  const hasPostPerm = hasPermission("FIXED_ASSET_DEPR_POST");

  // ── Button logic ──────────────────────────────────────────────────────
  // Generate: period selected + permission
  const canGenerate = !!selectedPeriodId && hasGeneratePerm;

  // Post: EITHER schedule has "calculated" entries loaded
  //       OR we just generated (generationResult exists with generated > 0)
  //       AND permission exists
  const hasUnpostedEntries =
    totalCalculated > 0 ||
    (generationResult !== null && generationResult.generated > 0);
  const canPost = hasPostPerm && hasUnpostedEntries && !!selectedPeriodId;

  // ── Handlers ──────────────────────────────────────────────────────────
  const handleGenerate = () => {
    if (!selectedPeriodId || !user?.id) return;
    generateMut.mutate(
      { periodId: selectedPeriodId, userId: user.id },
      {
        onSuccess: (result) => {
          setGenerationResult(result);
          // ★ Refetch schedule so table shows new entries
          queryClient.invalidateQueries({ queryKey: ["depreciation-schedule"] });
          queryClient.invalidateQueries({ queryKey: ["asset-kpis"] });
          toast.success(
            `Depreciation generated for ${result.generated} assets — ${formatPKR(result.total_amount)}`
          );
          logAudit.create(
            "depreciation_schedule",
            selectedPeriodId,
            "Generated depreciation for period"
          );
        },
        onError: (err: Error) => toast.error(err.message),
      }
    );
  };

  const handlePost = () => {
    if (!selectedPeriodId) return;
    if (
      !confirm(
        "Post all calculated depreciation for this period? This will update asset book values and cannot be undone."
      )
    )
      return;

    postMut.mutate(selectedPeriodId, {
      onSuccess: (result) => {
        // ★ Clear generation result since it's now posted
        setGenerationResult(null);
        // ★ Refetch everything
        queryClient.invalidateQueries({ queryKey: ["depreciation-schedule"] });
        queryClient.invalidateQueries({ queryKey: ["asset-kpis"] });
        toast.success(
          `Posted depreciation for ${result.posted} assets — ${formatPKR(result.total_amount)}`
        );
        logAudit.update(
          "depreciation_schedule",
          selectedPeriodId,
          "Depreciation posted"
        );
      },
      onError: (err: Error) => toast.error(err.message),
    });
  };

  // ── Disabled reasons for title/tooltip ────────────────────────────────
  const whyGenerateDisabled = (): string => {
    if (!selectedPeriodId) return "Select an accounting period first";
    if (!hasGeneratePerm)
      return 'Missing permission: FIXED_ASSET_DEPR_GENERATE';
    return "";
  };

  const whyPostDisabled = (): string => {
    if (!selectedPeriodId) return "Select an accounting period first";
    if (!hasUnpostedEntries)
      return "No calculated depreciation entries to post. Generate first.";
    if (!hasPostPerm)
      return 'Missing permission: FIXED_ASSET_DEPR_POST';
    return "";
  };

  // ── Style helpers ─────────────────────────────────────────────────────
  const inputCls = `px-3 py-2 rounded-lg border text-sm w-full ${
    isDark
      ? "bg-gray-800 border-gray-700 text-gray-100 focus:border-blue-500"
      : "bg-white border-gray-300 text-gray-900 focus:border-blue-500"
  } focus:outline-none focus:ring-1 focus:ring-blue-500`;

  const cardCls = `p-3 rounded-lg border ${
    isDark ? "border-gray-700 bg-gray-800/50" : "border-gray-200 bg-white"
  }`;

  const btnCls = (active: boolean) =>
    `px-4 py-2 rounded-lg text-sm font-medium flex items-center gap-1.5 transition-colors ${
      active
        ? "text-white"
        : "bg-gray-200 dark:bg-gray-700 text-gray-400 dark:text-gray-500 cursor-not-allowed"
    }`;

  return (
    <div
      className={`p-6 min-h-screen ${
        isDark ? "bg-gray-900 text-gray-100" : "bg-gray-50 text-gray-900"
      }`}
    >
      {/* ── Header ─────────────────────────────────────────────────── */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Depreciation Management</h1>
        <p
          className={`text-sm mt-1 ${
            isDark ? "text-gray-400" : "text-gray-500"
          }`}
        >
          Generate, review, and post depreciation for accounting periods
        </p>
      </div>

      {/* ── KPI Cards ──────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <div className={cardCls}>
          <div className="flex items-center gap-2 mb-1">
            <Calculator className="h-4 w-4 text-blue-500" />
            <span
              className={`text-xs ${
                isDark ? "text-gray-400" : "text-gray-500"
              }`}
            >
              Calculated (Unposted)
            </span>
          </div>
          <div className="text-lg font-bold">{formatPKR(totalCalculated)}</div>
        </div>
        <div className={cardCls}>
          <div className="flex items-center gap-2 mb-1">
            <CheckCircle2 className="h-4 w-4 text-green-500" />
            <span
              className={`text-xs ${
                isDark ? "text-gray-400" : "text-gray-500"
              }`}
            >
              Posted This Period
            </span>
          </div>
          <div className="text-lg font-bold">{formatPKR(totalPosted)}</div>
        </div>
        <div className={cardCls}>
          <div className="flex items-center gap-2 mb-1">
            <TrendingDown className="h-4 w-4 text-purple-500" />
            <span
              className={`text-xs ${
                isDark ? "text-gray-400" : "text-gray-500"
              }`}
            >
              Total Entries
            </span>
          </div>
          <div className="text-lg font-bold">{schedule.length}</div>
        </div>
        <div className={cardCls}>
          <div className="flex items-center gap-2 mb-1">
            <AlertTriangle className="h-4 w-4 text-orange-500" />
            <span
              className={`text-xs ${
                isDark ? "text-gray-400" : "text-gray-500"
              }`}
            >
              Period Depreciation
            </span>
          </div>
          <div className="text-lg font-bold">
            {formatPKR(kpis?.this_period_depreciation || 0)}
          </div>
        </div>
      </div>

      {/* ── Controls Bar ───────────────────────────────────────────── */}
      <div
        className={`p-4 rounded-lg border mb-4 ${
          isDark ? "border-gray-700 bg-gray-800/50" : "border-gray-200 bg-white"
        }`}
      >
        <div className="flex flex-wrap items-end gap-3">
          {/* Period Select */}
          <div className="flex-1 min-w-[220px]">
            <label
              className={`block text-sm font-medium mb-1 ${
                isDark ? "text-gray-300" : "text-gray-700"
              }`}
            >
              Accounting Period
            </label>
            <select
              value={selectedPeriodId}
              onChange={(e) => {
                setSelectedPeriodId(e.target.value);
                setGenerationResult(null);
              }}
              className={inputCls}
              disabled={periodsLoading}
            >
              <option value="">
                {periodsLoading ? "Loading..." : "-- Select Period --"}
              </option>
              {periods.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.start_date} to {p.end_date})
                </option>
              ))}
            </select>
          </div>

          {/* Status Filter */}
          <div className="min-w-[160px]">
            <label
              className={`block text-sm font-medium mb-1 ${
                isDark ? "text-gray-300" : "text-gray-700"
              }`}
            >
              Status
            </label>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className={inputCls}
            >
              <option value="all">All Statuses</option>
              <option value="calculated">Calculated</option>
              <option value="posted">Posted</option>
              <option value="reversed">Reversed</option>
              <option value="skipped">Skipped</option>
            </select>
          </div>

          {/* Generate Button — ALWAYS visible */}
          <button
            onClick={handleGenerate}
            disabled={!canGenerate || generateMut.isPending}
            title={whyGenerateDisabled()}
            className={`${btnCls(canGenerate)} ${
              canGenerate ? "bg-blue-600 hover:bg-blue-700" : ""
            }`}
          >
            {generateMut.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Calculator className="h-4 w-4" />
            )}
            {generateMut.isPending ? "Generating..." : "Generate Depreciation"}
          </button>

          {/* Post Button — ALWAYS visible, enables after generate */}
          <button
            onClick={handlePost}
            disabled={!canPost || postMut.isPending}
            title={whyPostDisabled()}
            className={`${btnCls(canPost)} ${
              canPost ? "bg-green-600 hover:bg-green-700" : ""
            }`}
          >
            {postMut.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <CheckCircle2 className="h-4 w-4" />
            )}
            {postMut.isPending ? "Posting..." : "Post Depreciation"}
          </button>
        </div>

        {/* Hints below buttons */}
        <div className="mt-3 space-y-1">
          {!canGenerate && (
            <p
              className={`flex items-start gap-1.5 text-xs ${
                isDark ? "text-yellow-400/80" : "text-yellow-700"
              }`}
            >
              <ShieldX className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              {whyGenerateDisabled()}
            </p>
          )}
          {selectedPeriodId && !canPost && (
            <p
              className={`flex items-start gap-1.5 text-xs ${
                isDark ? "text-yellow-400/80" : "text-yellow-700"
              }`}
            >
              <ShieldX className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              {whyPostDisabled()}
            </p>
          )}
        </div>
      </div>

      {/* ── Generation Result Panel ────────────────────────────────── */}
      {generationResult && (
        <div
          className={`p-4 rounded-lg border mb-4 ${
            isDark
              ? "border-blue-700 bg-blue-900/20"
              : "border-blue-200 bg-blue-50"
          }`}
        >
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-medium flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-blue-500" />
              Generation Result
            </h3>
            <button
              onClick={() => setGenerationResult(null)}
              className={`text-xs px-2 py-1 rounded ${
                isDark
                  ? "text-gray-400 hover:text-gray-200 hover:bg-gray-700"
                  : "text-gray-500 hover:text-gray-700 hover:bg-gray-200"
              } transition-colors`}
            >
              Dismiss
            </button>
          </div>
          <div className="flex flex-wrap gap-4 mb-3 text-sm">
            <div>
              <span
                className={isDark ? "text-gray-400" : "text-gray-500"}
              >
                Assets Generated:
              </span>{" "}
              <span className="font-bold">{generationResult.generated}</span>
            </div>
            <div>
              <span
                className={isDark ? "text-gray-400" : "text-gray-500"}
              >
                Total Amount:
              </span>{" "}
              <span className="font-bold">
                {formatPKR(generationResult.total_amount)}
              </span>
            </div>
          </div>
          {generationResult.details.length > 0 && (
            <div className="overflow-x-auto max-h-48">
              <table className="w-full text-sm">
                <thead>
                  <tr
                    className={isDark ? "text-gray-400" : "text-gray-500"}
                  >
                    <th className="text-left py-1 pr-4">Asset Code</th>
                    <th className="text-left py-1 pr-4">Asset Name</th>
                    <th className="text-right py-1 pr-4">Amount</th>
                    <th className="text-left py-1">Status</th>
                  </tr>
                </thead>
                <tbody
                  className={`divide-y ${
                    isDark ? "divide-gray-700" : "divide-gray-200"
                  }`}
                >
                  {generationResult.details.map((d, i) => (
                    <tr key={i}>
                      <td className="py-1.5 pr-4 font-mono text-xs">
                        {d.asset_code}
                      </td>
                      <td className="py-1.5 pr-4">{d.asset_name}</td>
                      <td className="py-1.5 pr-4 text-right font-mono">
                        {formatPKR(d.depreciation_amount)}
                      </td>
                      <td className="py-1.5">
                        <span
                          className={`px-2 py-0.5 rounded text-xs font-medium ${
                            d.status === "created"
                              ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
                              : "bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400"
                          }`}
                        >
                          {d.status === "created" ? "Created" : "Skipped"}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── Depreciation Schedule Table ────────────────────────────── */}
      <div
        className={`border rounded-lg overflow-hidden ${
          isDark ? "border-gray-700" : "border-gray-200"
        }`}
      >
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr
                className={`${
                  isDark
                    ? "bg-gray-800/80 border-b border-gray-700"
                    : "bg-gray-50 border-b border-gray-200"
                }`}
              >
                <th
                  className={`text-left px-4 py-3 font-medium ${
                    isDark ? "text-gray-400" : "text-gray-500"
                  }`}
                >
                  Asset
                </th>
                <th
                  className={`text-left px-4 py-3 font-medium ${
                    isDark ? "text-gray-400" : "text-gray-500"
                  }`}
                >
                  Period
                </th>
                <th
                  className={`text-right px-4 py-3 font-medium ${
                    isDark ? "text-gray-400" : "text-gray-500"
                  }`}
                >
                  Opening NBV
                </th>
                <th
                  className={`text-right px-4 py-3 font-medium ${
                    isDark ? "text-gray-400" : "text-gray-500"
                  }`}
                >
                  Depreciation
                </th>
                <th
                  className={`text-right px-4 py-3 font-medium ${
                    isDark ? "text-gray-400" : "text-gray-500"
                  }`}
                >
                  Closing NBV
                </th>
                <th
                  className={`text-left px-4 py-3 font-medium ${
                    isDark ? "text-gray-400" : "text-gray-500"
                  }`}
                >
                  Method
                </th>
                <th
                  className={`text-left px-4 py-3 font-medium ${
                    isDark ? "text-gray-400" : "text-gray-500"
                  }`}
                >
                  Status
                </th>
              </tr>
            </thead>
            <tbody
              className={`divide-y ${
                isDark ? "divide-gray-800" : "divide-gray-100"
              }`}
            >
              {scheduleLoading ? (
                <tr>
                  <td
                    colSpan={7}
                    className="px-4 py-12 text-center text-gray-500"
                  >
                    <Loader2 className="h-5 w-5 animate-spin mx-auto mb-2" />
                    Loading depreciation schedule...
                  </td>
                </tr>
              ) : schedule.length === 0 ? (
                <tr>
                  <td
                    colSpan={7}
                    className="px-4 py-16 text-center text-gray-500"
                  >
                    <Calculator
                      className={`h-10 w-10 mx-auto mb-3 ${
                        isDark ? "text-gray-600" : "text-gray-300"
                      }`}
                    />
                    <p className="font-medium mb-1">
                      {selectedPeriodId
                        ? "No depreciation entries for this period"
                        : "Select a period to get started"}
                    </p>
                    <p className="text-xs">
                      {selectedPeriodId
                        ? 'Click "Generate Depreciation" to calculate entries for all active assets.'
                        : "Choose an accounting period from the dropdown above."}
                    </p>
                  </td>
                </tr>
              ) : (
                schedule.map((entry) => {
                  const badge =
                    STATUS_BADGE[entry.status] || STATUS_BADGE.calculated;
                  return (
                    <tr
                      key={entry.id}
                      className={`transition-colors ${
                        isDark
                          ? "hover:bg-gray-800/30"
                          : "hover:bg-gray-50"
                      }`}
                    >
                      <td className="px-4 py-3">
                        <div className="font-medium">
                          {entry.asset_name || "—"}
                        </div>
                        <div className="text-xs font-mono text-gray-500">
                          {entry.asset_code}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-sm">
                        {entry.period_name || "—"}
                      </td>
                      <td className="px-4 py-3 text-right font-mono">
                        {formatPKR(entry.opening_nbv)}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-red-500">
                        {formatPKR(entry.depreciation_amount)}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-emerald-500">
                        {formatPKR(entry.closing_nbv)}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`px-2 py-0.5 rounded text-xs ${
                            isDark
                              ? "bg-gray-700 text-gray-300"
                              : "bg-gray-100 text-gray-600"
                          }`}
                        >
                          {entry.method.replace(/_/g, " ")}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`px-2 py-0.5 rounded-full text-xs font-medium ${badge.classes}`}
                        >
                          {badge.label}
                        </span>
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
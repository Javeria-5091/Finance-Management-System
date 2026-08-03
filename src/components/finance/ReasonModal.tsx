"use client";

import { useState, useEffect } from "react";
import { X, AlertTriangle, ShieldAlert } from "lucide-react";

interface ReasonModalProps {
  open: boolean;
  title?: string;
  description?: string;
  actionType?: "REJECT" | "REVERSE" | "REOPEN" | "RETURN_TO_DRAFT";
  moduleName?: string;
  reference?: string;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}

const ACTION_CONFIG = {
  REJECT: {
    color: "red",
    icon: AlertTriangle,
    label: "Rejection",
    warning: "This action requires a mandatory reason. It will be permanently recorded in the audit trail.",
    btnClass: "bg-red-600 hover:bg-red-700 focus:ring-red-500",
  },
  REVERSE: {
    color: "orange",
    icon: ShieldAlert,
    label: "Reversal",
    warning: "Reversing a posted entry creates a new offsetting journal. This cannot be undone without a new reversal.",
    btnClass: "bg-orange-600 hover:bg-orange-700 focus:ring-orange-500",
  },
  REOPEN: {
    color: "amber",
    icon: AlertTriangle,
    label: "Reopening",
    warning: "Reopening will reset the workflow to Draft. Previous approvals will be voided.",
    btnClass: "bg-amber-600 hover:bg-amber-700 focus:ring-amber-500",
  },
  RETURN_TO_DRAFT: {
    color: "amber",
    icon: AlertTriangle,
    label: "Return to Draft",
    warning: "This will send the record back to Draft status. All current approvals will be reset.",
    btnClass: "bg-amber-600 hover:bg-amber-700 focus:ring-amber-500",
  },
};

export default function ReasonModal({
  open,
  title,
  description = "",           // ✅ FIXED: was `string` (no quotes)
  actionType = "REJECT",
  moduleName = "Record",
  reference,
  onConfirm,
  onCancel,
}: ReasonModalProps) {
  const [reason, setReason] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Reset reason when modal opens/closes or action changes
  useEffect(() => {
    if (open) {
      setReason("");
      setIsSubmitting(false);
    }
  }, [open, actionType]);

  if (!open) return null;

  const config = ACTION_CONFIG[actionType] || ACTION_CONFIG.REJECT;
  const Icon = config.icon;

  function handleSubmit() {
    if (!reason.trim()) return;
    setIsSubmitting(true);
    onConfirm(reason.trim());
  }

  // Keyboard shortcut: Ctrl+Enter to confirm
  function handleKeyDown(e: React.KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && reason.trim()) {
      handleSubmit();
    }
    if (e.key === "Escape") {
      onCancel();
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
      onClick={onCancel}
      onKeyDown={handleKeyDown}
    >
      <div
        className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl w-full max-w-md shadow-2xl"
        onClick={e => e.stopPropagation()}
      >

        {/* ====== HEADER ====== */}
        <div className="flex items-center justify-between p-5 border-b border-gray-200 dark:border-gray-700">
          <div className="flex items-center gap-3">
            <div className={`p-2.5 rounded-xl ${
              config.color === "red" ? "bg-red-50 dark:bg-red-900/20" :
              config.color === "orange" ? "bg-orange-50 dark:bg-orange-900/20" :
              "bg-amber-50 dark:bg-amber-900/20"
            }`}>
              <Icon className={`w-5 h-5 ${
                config.color === "red" ? "text-red-600 dark:text-red-400" :
                config.color === "orange" ? "text-orange-600 dark:text-orange-400" :
                "text-amber-600 dark:text-amber-400"
              }`} />
            </div>
            <div>
              <h3 className="text-lg font-bold text-gray-900 dark:text-white">{title || `Confirm ${config.label}`}</h3>
              {reference && (
                <p className="text-xs text-gray-500 dark:text-gray-400 font-mono">{reference}</p>
              )}
            </div>
          </div>
          <button
            onClick={onCancel}
            className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
          >
            <X size={18} className="text-gray-500" />
          </button>
        </div>

        {/* ====== BODY ====== */}
        <div className="p-5 space-y-4">

          {/* Module context */}
          <p className="text-sm text-gray-600 dark:text-gray-400">
            You are about to <span className="font-semibold text-gray-900 dark:text-white">{config.label.toLowerCase()}</span> this {moduleName.toLowerCase()}.
          </p>

          {/* Custom description */}
          {description && (
            <p className="text-sm text-gray-600 dark:text-gray-400 bg-gray-50 dark:bg-gray-900/50 rounded-lg p-3">
              {description}
            </p>
          )}

          {/* Warning box — Document: every action reason must be auditable */}
          <div className={`flex gap-3 p-3 rounded-lg border ${
            config.color === "red" 
              ? "bg-red-50 dark:bg-red-900/10 border-red-200 dark:border-red-800/30" 
              : config.color === "orange"
                ? "bg-orange-50 dark:bg-orange-900/10 border-orange-200 dark:border-orange-800/30"
                : "bg-amber-50 dark:bg-amber-900/10 border-amber-200 dark:border-amber-800/30"
          }`}>
            <Icon className={`w-4 h-4 flex-shrink-0 mt-0.5 ${
              config.color === "red" ? "text-red-500" :
              config.color === "orange" ? "text-orange-500" :
              "text-amber-500"
            }`} />
            <p className="text-xs text-gray-700 dark:text-gray-300">{config.warning}</p>
          </div>

          {/* Reason textarea — MANDATORY per document spec */}
          <div>
            <label className="flex items-center gap-1.5 text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
              Reason <span className="text-red-500">*</span>
              <span className="text-[10px] text-gray-400 font-normal">(Mandatory — recorded in audit trail)</span>
            </label>
            <textarea
              value={reason}
              onChange={e => setReason(e.target.value)}
              rows={3}
              className="w-full px-3 py-2.5 bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-lg text-sm text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 resize-none transition-colors"
              placeholder={`e.g., Incorrect amount — client confirmed revision...`}
              autoFocus
            />
            <div className="flex items-center justify-between mt-1.5">
              <p className={`text-xs ${reason.trim().length > 0 ? "text-gray-400" : "text-red-400"}`}>
                {reason.trim().length === 0 ? "Reason is required to proceed" : `${reason.trim().length} characters`}
              </p>
              <p className="text-[10px] text-gray-400">Ctrl+Enter to confirm</p>
            </div>
          </div>
        </div>

        {/* ====== FOOTER ====== */}
        <div className="flex gap-3 p-5 border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/30 rounded-b-xl">
          <button
            onClick={onCancel}
            className="flex-1 px-4 py-2.5 text-sm font-medium bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-300 border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-600 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!reason.trim() || isSubmitting}
            className={`flex-1 px-4 py-2.5 text-sm font-medium text-white rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 ${config.btnClass}`}
          >
            {isSubmitting ? (
              <span className="flex items-center justify-center gap-2">
                <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Processing...
              </span>
            ) : (
              `Confirm ${config.label}`
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
"use client";

import { BarChart3, FileText } from "lucide-react";

export interface EmptyReportStateProps {
  icon?: "chart" | "document";
  title?: string;
  message: string;
  hint?: string;
}

export default function EmptyReportState({
  icon = "chart",
  title = "No Data",
  message,
  hint,
}: EmptyReportStateProps) {
  const Icon = icon === "chart" ? BarChart3 : FileText;

  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-16 text-center">
      <div className="w-16 h-16 bg-gray-100 dark:bg-gray-700 rounded-2xl flex items-center justify-center mx-auto mb-4">
        <Icon className="w-8 h-8 text-gray-300 dark:text-gray-500" />
      </div>
      <h3 className="text-base font-semibold text-gray-900 dark:text-white mb-1">
        {title}
      </h3>
      <p className="text-sm text-gray-500 dark:text-gray-400 max-w-md mx-auto">
        {message}
      </p>
      {hint && (
        <p className="text-xs text-gray-400 dark:text-gray-500 mt-2 max-w-sm mx-auto">
          {hint}
        </p>
      )}
    </div>
  );
}
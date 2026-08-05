"use client";

import { useState } from "react";
import { Download, FileSpreadsheet, FileText, Lock, ChevronDown } from "lucide-react";
import { logAction } from "@/lib/logAction";

export interface ExportManagerProps {
  /** Report identifier for audit logging */
  reportId: string;
  /** Human-readable report name for the filename */
  reportName: string;
  /** CSV generation function — returns CSV string */
  getCsvData?: () => string;
  /** PDF generation function — returns Blob */
  getPdfData?: () => Promise<Blob>;
  /** Current active filters to log with export */
  activeFilters?: Record<string, string>;
  /** Whether user has export permission */
  hasPermission?: boolean;
}

export default function ExportManager({
  reportId,
  reportName,
  getCsvData,
  getPdfData,
  activeFilters = {},
  hasPermission = true,
}: ExportManagerProps) {
  const [open, setOpen] = useState(false);
  const [exporting, setExporting] = useState(false);

  const handleExportCsv = async () => {
    if (!getCsvData || !hasPermission) return;
    setExporting(true);
    try {
      const csv = getCsvData();
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
      downloadBlob(blob, `${reportName.replace(/\s+/g, "_")}_${dateStamp()}.csv`);
      await logExport("CSV");
    } catch (e) {
      console.error("CSV export failed:", e);
    } finally {
      setExporting(false);
      setOpen(false);
    }
  };

  const handleExportPdf = async () => {
    if (!getPdfData || !hasPermission) return;
    setExporting(true);
    try {
      const blob = await getPdfData();
      downloadBlob(blob, `${reportName.replace(/\s+/g, "_")}_${dateStamp()}.pdf`);
      await logExport("PDF");
    } catch (e) {
      console.error("PDF export failed:", e);
    } finally {
      setExporting(false);
      setOpen(false);
    }
  };

  const logExport = async (fileType: string) => {
    try {
      await logAction({
        action: "EXPORT_REPORT",
        entityType: "report",
        description: `Exported ${reportName} as ${fileType}`,
        newValues: {
          report_id: reportId,
          report_name: reportName,
          file_type: fileType,
          filters: activeFilters,
        },
      });
    } catch {
      /* audit log best-effort */
    }
  };

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        disabled={!hasPermission}
        className="flex items-center gap-2 px-4 py-2 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <Download className="w-4 h-4" />
        Export
        <ChevronDown className="w-3.5 h-3.5" />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-1 z-50 w-52 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl shadow-lg py-1.5 animate-in fade-in slide-in-from-top-2">
            {getCsvData && (
              <button
                onClick={handleExportCsv}
                disabled={exporting}
                className="flex items-center gap-3 w-full px-4 py-2.5 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors disabled:opacity-50"
              >
                <FileSpreadsheet className="w-4 h-4 text-green-600" />
                Download CSV
              </button>
            )}
            {getPdfData && (
              <button
                onClick={handleExportPdf}
                disabled={exporting}
                className="flex items-center gap-3 w-full px-4 py-2.5 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors disabled:opacity-50"
              >
                <FileText className="w-4 h-4 text-red-600" />
                Download PDF
              </button>
            )}
            {!hasPermission && (
              <div className="flex items-center gap-3 px-4 py-2.5 text-xs text-gray-400">
                <Lock className="w-3.5 h-3.5" />
                Export permission required
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function dateStamp() {
  return new Date().toISOString().slice(0, 10);
}
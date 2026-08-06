// ================================================================
// OSYSTIC Finance Management System — Utility / Helper Functions
// ================================================================
// P0/P1 Convention compatible
// ================================================================

/**
 * Format amount as PKR currency string
 * e.g. formatPKR(150000) → "PKR 150,000"
 */
export function formatPKR(amount: number | null | undefined): string {
  if (amount == null) return "PKR 0";
  return new Intl.NumberFormat("en-PK", {
    style: "currency",
    currency: "PKR",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
}

/**
 * Format a date string to locale date
 * e.g. formatDate("2025-01-15") → "15/01/2025"
 */
export function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return "—";
  try {
    return new Date(dateStr).toLocaleDateString("en-GB", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });
  } catch {
    return "—";
  }
}

/**
 * Format a payroll period string
 * e.g. formatPeriod("2025-01") → "January 2025"
 */
export function formatPeriod(period: string | null | undefined): string {
  if (!period) return "—";
  try {
    const [year, month] = period.split("-");
    const date = new Date(parseInt(year), parseInt(month) - 1, 1);
    return date.toLocaleString("en-PK", {
      month: "long",
      year: "numeric",
    });
  } catch {
    return period;
  }
}

/**
 * Relative time ago from now
 * e.g. timeAgo("2025-01-15T10:30:00Z") → "2 hours ago"
 */
export function timeAgo(dateStr: string | null | undefined): string {
  if (!dateStr) return "";
  try {
    const now = Date.now();
    const then = new Date(dateStr).getTime();
    const diffMs = now - then;
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHr = Math.floor(diffMin / 60);
    const diffDay = Math.floor(diffHr / 24);
    const diffMonth = Math.floor(diffDay / 30);

    if (diffSec < 60) return "just now";
    if (diffMin < 60) return `${diffMin}m ago`;
    if (diffHr < 24) return `${diffHr}h ago`;
    if (diffDay < 30) return `${diffDay}d ago`;
    if (diffMonth < 12) return `${diffMonth}mo ago`;
    return `${Math.floor(diffMonth / 12)}y ago`;
  } catch {
    return "";
  }
}

/**
 * Generate payroll period string from month and year
 * e.g. getPayrollPeriod(1, 2025) → "2025-01"
 */
export function getPayrollPeriod(month: number, year: number): string {
  return `${year}-${String(month).padStart(2, "0")}`;
}

/**
 * Get last day of a month
 */
export function getLastDayOfMonth(month: number, year: number): number {
  return new Date(year, month, 0).getDate();
}

/**
 * Employment type badge color class
 */
export function getEmploymentTypeBadge(type: string): string {
  const map: Record<string, string> = {
    FULL_TIME: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
    PART_TIME: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
    CONTRACTOR: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400",
    INTERN: "bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400",
    CONSULTANT: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400",
  };
  return map[type] || "bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300";
}
// =============================================================================
// OSYSTIC Finance Management System — Shared Utility Helpers
// File: src/lib/helpers.ts
// ★★★ NEW FILE: Required by payroll page (was missing, causing build errors) ★★★
// =============================================================================

// ─── Currency Formatting ─────────────────────────────────────────────────────

export function formatPKR(amount: number): string {
  return new Intl.NumberFormat('en-PK', {
    style: 'currency',
    currency: 'PKR',
    minimumFractionDigits: 0,
  }).format(amount);
}

// ─── Date Formatting ─────────────────────────────────────────────────────────

export function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return '—';
  const date = new Date(dateStr);
  return date.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

export function formatPeriod(periodStr: string | null | undefined): string {
  if (!periodStr) return '—';
  // periodStr format: '2025-01' or '2025-06'
  const [year, month] = periodStr.split('-');
  const monthNames = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];
  const monthIndex = parseInt(month, 10) - 1;
  if (monthIndex < 0 || monthIndex > 11) return periodStr;
  return `${monthNames[monthIndex]} ${year}`;
}

export function timeAgo(dateStr: string | null | undefined): string {
  if (!dateStr) return '';
  const now = new Date();
  const date = new Date(dateStr);
  const diffMs = now.getTime() - date.getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSecs < 60) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;
  return formatDate(dateStr);
}

// ─── Employment Type Badge ─────────────────────────────────────────────────

const EMPLOYMENT_TYPE_STYLES: Record<string, string> = {
  FULL_TIME: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  PART_TIME: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400',
  CONTRACTOR: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400',
  INTERN: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  CONSULTANT: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400',
};

export function getEmploymentTypeBadge(type: string): string {
  return EMPLOYMENT_TYPE_STYLES[type] || EMPLOYMENT_TYPE_STYLES.FULL_TIME;
}

// ─── Date Helpers ───────────────────────────────────────────────────────────

export function getLastDayOfMonth(month: number, year: number): number {
  return new Date(year, month, 0).getDate();
}

export function getFirstDayOfMonth(month: number, year: number): number {
  return 1;
}

// ─── Number Formatting ──────────────────────────────────────────────────────

export function formatNumber(num: number): string {
  return new Intl.NumberFormat('en-US').format(num);
}

export function formatPercentage(value: number, decimals: number = 2): string {
  return `${(value * 100).toFixed(decimals)}%`;
}

'use client';
// DEF-01/02: HOD previously fell through to ViewerDashboard, which has no
// approvals entry point. This dashboard shows the HOD's approvals queue
// (own department) and keeps the personal expense view below it.

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ClipboardCheck } from 'lucide-react';
import { reportingDB } from '@/lib/supabase';
import { EmployeeDashboard } from '@/components/dashboards/employee/EmployeeDashboard';

export function HODDashboard() {
  const [pending, setPending] = useState<number | null>(null);
  const [actionable, setActionable] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error } = await reportingDB.rpc('my_pending_approvals');
      if (cancelled) return;
      if (error) { setPending(0); return; }
      const rows = (data as { can_approve: boolean }[]) || [];
      setPending(rows.length);
      setActionable(rows.filter((r) => r.can_approve).length);
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="space-y-6">
      <Link
        href="/dashboard/approvals"
        className="flex items-center justify-between rounded-lg border border-orange-200 bg-orange-50 p-4 hover:bg-orange-100 dark:border-orange-500/30 dark:bg-orange-500/10"
      >
        <div className="flex items-center gap-3">
          <ClipboardCheck className="w-6 h-6 text-orange-600" />
          <div>
            <div className="font-semibold text-gray-900 dark:text-white">Pending Approvals (my department)</div>
            <div className="text-sm text-gray-600 dark:text-gray-300">
              {pending === null ? 'Loading…' : `${pending} waiting, ${actionable} you can act on now`}
            </div>
          </div>
        </div>
        <span className="text-sm font-medium text-orange-700 dark:text-orange-300">Open →</span>
      </Link>

      <EmployeeDashboard />
    </div>
  );
}

'use client';
import { useUserRole } from '@/hooks/useUserRole';
import { CEODashboard } from '@/components/dashboards/ceo/CEODashboard';
import { CFODashboard } from '@/components/dashboards/cfo/CFODashboard';
import { AccountantDashboard } from '@/components/dashboards/accountant/AccountantDashboard';
import { PMDashboard } from '@/components/dashboards/pm/PMDashboard';
import { ViewerDashboard } from '@/components/dashboards/viewer/ViewerDashboard';
import { Loader2 } from 'lucide-react';

export default function DashboardPage() {
  const { role, loading } = useUserRole();

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-gray-50 dark:bg-gray-950">
        <Loader2 className="w-10 h-10 animate-spin text-blue-600" />
      </div>
    );
  }

  switch (role) {
    case 'CEO': return <CEODashboard />;
    case 'FINANCE_HEAD': return <CFODashboard />;
    case 'ACCOUNTANT': return <AccountantDashboard />;
    case 'PROJECT_MANAGER': return <PMDashboard />;
    case 'VIEWER': return <ViewerDashboard />;
    default: return <ViewerDashboard />; // EMPLOYEE bhi yehi dekhega
  }
}
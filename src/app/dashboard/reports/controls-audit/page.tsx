'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { getApprovalAging, getAuditLog } from '@/services/report.service';
import ReportHeader from '@/components/reports/ReportHeader';
import ReportFilterBar from '@/components/reports/ReportFilterBar';
import ExportManager from '@/components/reports/ExportManager';
import KPICard from '@/components/reports/KPICard';
import EmptyReportState from '@/components/reports/EmptyReportState';
import ReportTable from '@/components/reports/ReportTable';
import { ShieldCheck, AlertTriangle, Clock, FileText } from 'lucide-react';
import type { ApprovalAgingRow, AuditLogRow, ReportFilters } from '@/types/reports.types';

export default function ControlsAuditPage() {
  const [tab, setTab] = useState<'approvals' | 'audit'>('approvals');
  const [filters, setFilters] = useState<ReportFilters>({});
  const [dataAsOf] = useState(new Date().toISOString());

  const approvals = useQuery<ApprovalAgingRow[], Error>({
  queryKey: ['approval-aging'],
  queryFn: () => getApprovalAging(),
  enabled: tab === 'approvals',
});
  const auditLog = useQuery({ queryKey: ['audit-log', filters], queryFn: () => getAuditLog({
    startDate: filters.startDate,
    endDate: filters.endDate,
    action: filters.entity,
    page: 1,
    pageSize: 100,
  }), enabled: tab === 'audit' });

  const isLoading = tab === 'approvals' ? approvals.isLoading : auditLog.isLoading;
  const approvalRows = (approvals.data || []) as ApprovalAgingRow[];
  const auditRows = ((auditLog.data as any)?.rows || []) as AuditLogRow[];

  const pendingCount = approvalRows.filter(r => r.status === 'pending').length;
  const overdueCount = approvalRows.filter(r => r.overdue).length;
  const totalPendingAmount = approvalRows.filter(r => r.status === 'pending').reduce((s, r) => s + r.amount, 0);

  const agingBuckets = [
    { name: '0-1 Days', value: approvalRows.filter(r => r.days_pending <= 1).length, fill: '#22c55e' },
    { name: '2-3 Days', value: approvalRows.filter(r => r.days_pending > 1 && r.days_pending <= 3).length, fill: '#f59e0b' },
    { name: '4-7 Days', value: approvalRows.filter(r => r.days_pending > 3 && r.days_pending <= 7).length, fill: '#f97316' },
    { name: '7+ Days', value: approvalRows.filter(r => r.days_pending > 7).length, fill: '#ef4444' },
  ];

  const approvalColumns = [
    { key: 'type', header: 'Type', align: 'left' as const, sortValue: (r: ApprovalAgingRow) => r.type },
    { key: 'requester', header: 'Requester', align: 'left' as const, sortValue: (r: ApprovalAgingRow) => r.requester },
    { key: 'approver', header: 'Approver', align: 'left' as const, sortValue: (r: ApprovalAgingRow) => r.approver },
    { key: 'submitted_at', header: 'Submitted', align: 'left' as const, sortValue: (r: ApprovalAgingRow) => r.submitted_at, render: (r: ApprovalAgingRow) => <span className='text-xs text-gray-500'>{new Date(r.submitted_at).toLocaleDateString('en-PK')}</span> },
    { key: 'amount', header: 'Amount', align: 'right' as const, sortValue: (r: ApprovalAgingRow) => r.amount, render: (r: ApprovalAgingRow) => <span className='font-mono text-sm'>{new Intl.NumberFormat('en-PK', { style: 'currency', currency: 'PKR', minimumFractionDigits: 0 }).format(r.amount || 0)}</span> },
    { key: 'days_pending', header: 'Days Pending', align: 'right' as const, sortValue: (r: ApprovalAgingRow) => r.days_pending, render: (r: ApprovalAgingRow) => <span className={`font-mono font-bold ${r.days_pending > r.sla_days ? 'text-red-600' : 'text-gray-700 dark:text-gray-300'}`}>{r.days_pending}d</span> },
    { key: 'status', header: 'Status', align: 'center' as const, render: (r: ApprovalAgingRow) => <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${r.status === 'pending' ? (r.overdue ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700') : 'bg-green-100 text-green-700'}`}>{r.status}{r.overdue ? ' (SLA!)' : ''}</span> },
  ];

  const auditColumns = [
    { key: 'timestamp', header: 'Time', align: 'left' as const, sortValue: (r: AuditLogRow) => r.timestamp, render: (r: AuditLogRow) => <span className='text-xs text-gray-500'>{new Date(r.timestamp).toLocaleString('en-PK')}</span> },
    { key: 'user_email', header: 'User', align: 'left' as const, sortValue: (r: AuditLogRow) => r.user_email, render: (r: AuditLogRow) => <span className='text-xs'>{r.user_email}</span> },
    { key: 'action', header: 'Action', align: 'left' as const, sortValue: (r: AuditLogRow) => r.action, render: (r: AuditLogRow) => <span className='text-xs font-mono font-medium'>{r.action}</span> },
    { key: 'resource', header: 'Resource', align: 'left' as const, sortValue: (r: AuditLogRow) => r.resource },
    { key: 'resource_id', header: 'ID', align: 'left' as const, sortValue: (r: AuditLogRow) => r.resource_id, render: (r: AuditLogRow) => <span className='text-xs font-mono text-gray-400'>{r.resource_id?.slice(0, 12)}...</span> },
  ];

  const getCsv = () => {
    if (tab === 'approvals') {
      let csv = 'Type,Requester,Approver,Submitted,Amount,Days,Status,Overdue\n';
      approvalRows.forEach(r => csv += `${r.type},${r.requester},${r.approver},${r.submitted_at},${r.amount},${r.days_pending},${r.status},${r.overdue}\n`);
      return csv;
    }
    let csv = 'Time,User,Action,Resource,Resource ID\n';
    auditRows.forEach(r => csv += `${r.timestamp},${r.user_email},${r.action},${r.resource},${r.resource_id}\n`);
    return csv;
  };

  return (
    <div className='p-6 max-w-[1600px] mx-auto space-y-5'>
      <ReportHeader
        title='Controls & Audit'
        subtitle='Approval aging, policy exceptions, audit trail, access review '
        dataAsOf={dataAsOf}
        reconciled={true}
        actions={<ExportManager reportId={`controls-${tab}`} reportName={`Controls_${tab}`} getCsvData={getCsv} activeFilters={filters as Record<string, string>} />}
      />

      {tab === 'audit' && <ReportFilterBar showDateRange onApply={(f) => setFilters(f)} isLoading={isLoading} />}

      <div className='flex gap-1 bg-gray-100 dark:bg-gray-800 p-1 rounded-xl w-fit'>
        {[{ id: 'approvals' as const, label: 'Approval Aging' }, { id: 'audit' as const, label: 'Audit Trail' }].map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`px-4 py-2.5 rounded-lg text-sm font-medium transition-all ${tab === t.id ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow-sm' : 'text-gray-500'}`}>
            {t.label}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className='flex justify-center py-20'><div className='w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin' /></div>
      ) : tab === 'approvals' && approvalRows.length > 0 ? (
        <div className='space-y-5'>
          <div className='grid grid-cols-2 md:grid-cols-4 gap-3'>
            <KPICard label='Pending Approvals' value={pendingCount.toString()} color='amber' icon={<Clock className='w-4 h-4 text-amber-600' />} />
            <KPICard label='Overdue (SLA)' value={overdueCount.toString()} color={overdueCount > 0 ? 'red' : 'green'} icon={<AlertTriangle className='w-4 h-4' />} />
            <KPICard label='Pending Amount' value={new Intl.NumberFormat('en-PK', { style: 'currency', currency: 'PKR', minimumFractionDigits: 0 }).format(totalPendingAmount)} color='blue' />
            <KPICard label='Total Items' value={approvalRows.length.toString()} color='gray' icon={<ShieldCheck className='w-4 h-4 text-gray-600' />} />
          </div>

          {overdueCount > 0 && (
            <div className='bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/30 rounded-xl p-4 flex items-center gap-3 text-sm text-red-700 dark:text-red-400'>
              <AlertTriangle className='w-5 h-5 flex-shrink-0' />
              <span><strong>{overdueCount}</strong> approvals exceed their SLA — escalate per policy</span>
            </div>
          )}

          <div className='grid grid-cols-1 lg:grid-cols-4 gap-5'>
            <div className='bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-5'>
              <h4 className='text-xs font-bold uppercase text-gray-500 mb-4'>Approval Aging Distribution</h4>
              <ResponsiveContainer width='100%' height={200}>
                <BarChart data={agingBuckets}>
                  <CartesianGrid strokeDasharray='3 3' stroke='#e5e7eb' />
                  <XAxis dataKey='name' fontSize={10} />
                  <YAxis fontSize={10} allowDecimals={false} />
                  <Tooltip />
                  <Bar dataKey='value' radius={[6, 6, 0, 0]}>
                    {agingBuckets.map((e, i) => <Cell key={i} fill={e.fill} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className='lg:col-span-3'>
              <ReportTable
                columns={approvalColumns}
                data={approvalRows}
                keyExtractor={(r: any) => r.id}
                pageSize={25}
              />
            </div>
          </div>
        </div>
      ) : tab === 'audit' && auditRows.length > 0 ? (
        <ReportTable
          columns={auditColumns}
          data={auditRows}
          keyExtractor={(r: any) => r.id}
          pageSize={50}
        />
      ) : (
        <EmptyReportState icon={tab === 'approvals' ? 'chart' : 'document'} title={`No ${tab === 'approvals' ? 'Approval' : 'Audit'} Data`} message={`No ${tab} records found for the selected period`} hint={tab === 'approvals' ? 'Create approvals for expenses, invoices, or journal entries' : 'Perform actions in the system to generate audit logs'} />
      )}
    </div>
  );
}
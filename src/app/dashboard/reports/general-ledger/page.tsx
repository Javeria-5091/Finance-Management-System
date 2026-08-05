'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getGeneralLedger } from '@/services/report.service';
import ReportHeader from '@/components/reports/ReportHeader';
import ReportFilterBar from '@/components/reports/ReportFilterBar';
import ReportTable from '@/components/reports/ReportTable';
import ExportManager from '@/components/reports/ExportManager';
import EmptyReportState from '@/components/reports/EmptyReportState';
import { BookOpen } from 'lucide-react';
import type { GLEntry, ReportFilters } from '@/types/reports.types';

const f = (n: number) => new Intl.NumberFormat('en-PK', { style: 'currency', currency: 'PKR', minimumFractionDigits: 0 }).format(n || 0);

export default function GeneralLedgerPage() {
  const [filters, setFilters] = useState<ReportFilters>({});
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [dataAsOf] = useState(new Date().toISOString());

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['gl', filters, page, search],
    queryFn: () => getGeneralLedger({
      accountId: filters.entity,
      startDate: filters.startDate,
      endDate: filters.endDate,
      page,
      pageSize: 50,
      search: search || undefined,
    }),
  });

  const rows = (data as any)?.rows || [];
  const totalCount = (data as any)?.total_count || 0;

  const periodLabel = filters.startDate && filters.endDate
    ? `${filters.startDate} to ${filters.endDate}`
    : 'All Periods';

  const getCsv = () => {
    let csv = 'Date,Ref,Description,Debit,Credit,Balance,Account\n';
    rows.forEach((r: GLEntry) => {
      csv += `${r.date},${r.ref},"${r.description}",${r.debit},${r.credit},${r.running_balance},${r.account_name}\n`;
    });
    return csv;
  };

  const columns = [
    { key: 'date', header: 'Date', align: 'left' as const, sortValue: (r: GLEntry) => r.date, render: (r: GLEntry) => <span className="text-gray-500 text-xs">{r.date ? new Date(r.date).toLocaleDateString('en-PK') : '-'}</span> },
    { key: 'ref', header: 'Reference', align: 'left' as const, render: (r: GLEntry) => <span className="font-mono text-xs text-gray-500">{r.journal_number || r.ref}</span> },
    { key: 'description', header: 'Description', align: 'left' as const, sortValue: (r: GLEntry) => r.description, render: (r: GLEntry) => <span className="font-medium text-gray-900 dark:text-white">{r.description}</span> },
    { key: 'debit', header: 'Debit', align: 'right' as const, sortValue: (r: GLEntry) => r.debit, render: (r: GLEntry) => <span className={`font-mono text-sm ${r.debit > 0 ? 'text-gray-900 dark:text-white font-medium' : 'text-gray-300'}`}>{r.debit > 0 ? f(r.debit) : '-'}</span> },
    { key: 'credit', header: 'Credit', align: 'right' as const, sortValue: (r: GLEntry) => r.credit, render: (r: GLEntry) => <span className={`font-mono text-sm ${r.credit > 0 ? 'text-gray-900 dark:text-white font-medium' : 'text-gray-300'}`}>{r.credit > 0 ? f(r.credit) : '-'}</span> },
    { key: 'running_balance', header: 'Balance', align: 'right' as const, sortValue: (r: GLEntry) => r.running_balance, render: (r: GLEntry) => <span className={`font-mono text-sm font-medium ${r.running_balance >= 0 ? 'text-gray-900 dark:text-white' : 'text-red-600'}`}>{f(r.running_balance)}</span> },
  ];

  return (
    <div className="p-6 max-w-[1600px] mx-auto space-y-5">
      <ReportHeader
        title="General Ledger"
        subtitle="Detailed transaction history per account — Source of Truth"
        period={periodLabel}
        dataAsOf={dataAsOf}
        filters={[
          ...(filters.startDate ? [{ label: 'From', value: filters.startDate }] : []),
          ...(filters.endDate ? [{ label: 'To', value: filters.endDate }] : []),
          ...(search ? [{ label: 'Search', value: search }] : []),
        ]}
        reconciled={true}
        actions={<ExportManager reportId="general-ledger" reportName="General_Ledger" getCsvData={getCsv} activeFilters={filters as Record<string, string>} />}
      />

      <ReportFilterBar
        showDateRange
        onApply={(f) => { setFilters(f); setPage(1); refetch(); }}
        isLoading={isLoading}
      />

      {/* Search */}
      <div className="flex gap-3">
        <input
          type="text"
          placeholder="Search by description, reference..."
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          onKeyDown={(e) => e.key === 'Enter' && refetch()}
          className="flex-1 max-w-md px-4 py-2.5 text-sm border border-gray-300 dark:border-gray-600 rounded-lg dark:bg-gray-800 dark:text-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all"
        />
        <span className="text-xs text-gray-400 self-center">{totalCount} entries</span>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-20"><div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin" /></div>
      ) : rows.length > 0 ? (
        <ReportTable
          columns={columns}
          data={rows}
          keyExtractor={(r: any) => r.id}
          pageSize={50}
          emptyMessage="No ledger entries found"
        />
      ) : (
        <EmptyReportState icon="document" title="No Ledger Entries" message="No transactions found for the selected filters" hint="Adjust date range or account filter to see entries" />
      )}
    </div>
  );
}

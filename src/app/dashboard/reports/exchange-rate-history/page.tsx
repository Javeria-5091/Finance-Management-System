'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getExchangeRateHistory } from '@/services/report.service';
import ReportHeader from '@/components/reports/ReportHeader';
import ReportFilterBar from '@/components/reports/ReportFilterBar';
import ReportTable from '@/components/reports/ReportTable';
import ExportManager from '@/components/reports/ExportManager';
import EmptyReportState from '@/components/reports/EmptyReportState';
import type { ExchangeRateHistoryRow, ReportFilters } from '@/types/reports.types';

const CURRENCY_OPTIONS = [
  { value: 'USD', label: 'USD' },
  { value: 'EUR', label: 'EUR' },
  { value: 'GBP', label: 'GBP' },
  { value: 'AED', label: 'AED' },
  { value: 'SAR', label: 'SAR' },
  { value: 'AUD', label: 'AUD' },
  { value: 'CAD', label: 'CAD' },
];

const RATE_TYPE_STYLE: Record<string, string> = {
  PLATFORM: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  BANK: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
  PAYMENT_CHANNEL: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400',
  MANUAL: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
};

const APPROVAL_STYLE: Record<string, string> = {
  APPROVED: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
  PENDING_APPROVAL: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  'N/A': 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400',
};

export default function ExchangeRateHistoryPage() {
  const [filters, setFilters] = useState<ReportFilters>({});
  const [page, setPage] = useState(1);
  const [dataAsOf] = useState(new Date().toISOString());

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['exchange-rate-history', filters, page],
    queryFn: () => getExchangeRateHistory({
      fromCurrency: filters.currency,
      startDate: filters.startDate,
      endDate: filters.endDate,
      page,
      pageSize: 50,
    }),
  });

  const rows = (data as any)?.rows || [];
  const totalCount = (data as any)?.total_count || 0;

  const periodLabel = filters.startDate && filters.endDate
    ? `${filters.startDate} to ${filters.endDate}`
    : 'All Periods';

  const getCsv = () => {
    let csv = 'Rate Date,From,To,Rate,Rate Type,Source,Evidence Reference,Entered By,Approved By,Approval Status,Locked\n';
    rows.forEach((r: ExchangeRateHistoryRow) => {
      csv += `${r.rate_date},${r.from_currency},${r.to_currency},${r.rate},${r.rate_type},${r.source_platform || ''},"${(r.evidence_reference || '').replace(/"/g, '""')}",${r.entered_by_name || r.entered_by_email || r.entered_by},${r.approved_by_name || r.approved_by_email || r.approved_by || ''},${r.approval_status},${r.is_locked ? 'Yes' : 'No'}\n`;
    });
    return csv;
  };

  const columns = [
    { key: 'rate_date', header: 'Rate Date', align: 'left' as const, sortValue: (r: ExchangeRateHistoryRow) => r.rate_date, render: (r: ExchangeRateHistoryRow) => <span className="text-gray-500 text-xs">{new Date(r.rate_date).toLocaleDateString('en-PK')}{r.rate_time ? ` ${r.rate_time}` : ''}</span> },
    { key: 'pair', header: 'Pair', align: 'left' as const, render: (r: ExchangeRateHistoryRow) => <span className="font-mono text-sm font-medium text-gray-900 dark:text-white">{r.from_currency} → {r.to_currency}</span> },
    { key: 'rate', header: 'Rate', align: 'right' as const, sortValue: (r: ExchangeRateHistoryRow) => r.rate, render: (r: ExchangeRateHistoryRow) => <span className="font-mono text-sm">{Number(r.rate).toFixed(4)}</span> },
    { key: 'rate_type', header: 'Type', align: 'center' as const, render: (r: ExchangeRateHistoryRow) => <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold ${RATE_TYPE_STYLE[r.rate_type] || 'bg-gray-100 text-gray-600'}`}>{r.rate_type}{r.source_platform ? ` · ${r.source_platform}` : ''}</span> },
    { key: 'evidence_reference', header: 'Evidence', align: 'left' as const, render: (r: ExchangeRateHistoryRow) => <span className="text-xs text-gray-500 max-w-xs truncate block" title={r.evidence_reference}>{r.evidence_reference}</span> },
    { key: 'entered_by', header: 'Entered By', align: 'left' as const, render: (r: ExchangeRateHistoryRow) => <span className="text-xs text-gray-700 dark:text-gray-300">{r.entered_by_name || r.entered_by_email || '—'}</span> },
    { key: 'approved_by', header: 'Approved By', align: 'left' as const, render: (r: ExchangeRateHistoryRow) => <span className="text-xs text-gray-700 dark:text-gray-300">{r.approved_by_name || r.approved_by_email || '—'}</span> },
    { key: 'approval_status', header: 'Status', align: 'center' as const, render: (r: ExchangeRateHistoryRow) => <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold ${APPROVAL_STYLE[r.approval_status] || ''}`}>{r.approval_status.replace('_', ' ')}</span> },
    { key: 'is_locked', header: 'Locked', align: 'center' as const, render: (r: ExchangeRateHistoryRow) => r.is_locked ? <span className="text-xs text-gray-500">🔒</span> : <span className="text-xs text-gray-300">—</span> },
  ];

  return (
    <div className="p-6 max-w-[1600px] mx-auto space-y-5">
      <ReportHeader
        title="Manual-Rate History"
        subtitle="Full audit history of every exchange rate entered — who entered it, who approved it, and its evidence reference"
        period={periodLabel}
        dataAsOf={dataAsOf}
        filters={[
          ...(filters.currency ? [{ label: 'From Currency', value: filters.currency }] : []),
          ...(filters.startDate ? [{ label: 'From', value: filters.startDate }] : []),
          ...(filters.endDate ? [{ label: 'To', value: filters.endDate }] : []),
        ]}
        actions={<ExportManager reportId="exchange-rate-history" reportName="Exchange_Rate_History" getCsvData={getCsv} activeFilters={filters as Record<string, string>} />}
      />

      <ReportFilterBar
        showDateRange
        showCurrency
        currencyOptions={CURRENCY_OPTIONS}
        onApply={(f) => { setFilters(f); setPage(1); refetch(); }}
        isLoading={isLoading}
      />

      <div className="flex justify-end">
        <span className="text-xs text-gray-400 self-center">{totalCount} rate entries</span>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-20"><div className="w-8 h-8 border-4 border-amber-600 border-t-transparent rounded-full animate-spin" /></div>
      ) : rows.length > 0 ? (
        <ReportTable
          columns={columns}
          data={rows}
          keyExtractor={(r: any) => r.id}
          pageSize={50}
          emptyMessage="No exchange rate history found"
        />
      ) : (
        <EmptyReportState icon="document" title="No Rate History" message="No exchange rates found for the selected filters" hint="Adjust date range or currency filter, or confirm rates have been entered under Settings → Exchange Rates" />
      )}
    </div>
  );
}

'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getPkrConversionReport } from '@/services/report.service';
import ReportHeader from '@/components/reports/ReportHeader';
import ReportFilterBar from '@/components/reports/ReportFilterBar';
import ReportTable from '@/components/reports/ReportTable';
import ExportManager from '@/components/reports/ExportManager';
import EmptyReportState from '@/components/reports/EmptyReportState';
import type { PkrConversionRow, ReportFilters, RateMethod } from '@/types/reports.types';

const fmt = (n: number, ccy: string) =>
  new Intl.NumberFormat('en-PK', { style: 'currency', currency: ccy || 'PKR', minimumFractionDigits: 2 }).format(n || 0);

const CURRENCY_OPTIONS = [
  { value: 'USD', label: 'USD' },
  { value: 'EUR', label: 'EUR' },
  { value: 'GBP', label: 'GBP' },
  { value: 'AED', label: 'AED' },
  { value: 'SAR', label: 'SAR' },
  { value: 'AUD', label: 'AUD' },
  { value: 'CAD', label: 'CAD' },
];

const RATE_METHOD_LABEL: Record<RateMethod, string> = {
  BASE_CURRENCY: 'Base Currency',
  ACTUAL_PLATFORM_BANK_RATE: 'Actual Platform/Bank Rate',
  APPROVED_ACCOUNTING_RATE: 'Approved Accounting Rate',
  PENDING_APPROVAL: 'Pending Approval',
  PENDING_CONVERSION: 'Pending Conversion',
};

const RATE_METHOD_STYLE: Record<RateMethod, string> = {
  BASE_CURRENCY: 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400',
  ACTUAL_PLATFORM_BANK_RATE: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
  APPROVED_ACCOUNTING_RATE: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  PENDING_APPROVAL: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  PENDING_CONVERSION: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
};

const RATE_METHOD_FILTER_OPTIONS = [
  { value: 'ACTUAL_PLATFORM_BANK_RATE', label: 'Actual Platform/Bank Rate' },
  { value: 'APPROVED_ACCOUNTING_RATE', label: 'Approved Accounting Rate' },
  { value: 'PENDING_APPROVAL', label: 'Pending Approval' },
  { value: 'PENDING_CONVERSION', label: 'Pending Conversion' },
];

export default function PkrConversionPage() {
  const [filters, setFilters] = useState<ReportFilters>({});
  const [rateMethod, setRateMethod] = useState('');
  const [page, setPage] = useState(1);
  const [dataAsOf] = useState(new Date().toISOString());

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['pkr-conversion', filters, rateMethod, page],
    queryFn: () => getPkrConversionReport({
      currency: filters.currency,
      rateMethod: rateMethod || undefined,
      startDate: filters.startDate,
      endDate: filters.endDate,
      page,
      pageSize: 50,
    }),
  });

  const rows = (data as any)?.rows || [];
  const totalCount = (data as any)?.total_count || 0;
  const pendingCount = rows.filter((r: PkrConversionRow) => r.rate_method === 'PENDING_CONVERSION' || r.rate_method === 'PENDING_APPROVAL').length;

  const periodLabel = filters.startDate && filters.endDate
    ? `${filters.startDate} to ${filters.endDate}`
    : 'All Periods';

  const getCsv = () => {
    let csv = 'Transaction Date,Ref,Account,Original Currency,Original Debit,Original Credit,Applied Rate,PKR Debit,PKR Credit,Rate Method\n';
    rows.forEach((r: PkrConversionRow) => {
      csv += `${r.transaction_date},${r.journal_reference},${r.account_name},${r.original_currency},${r.original_debit},${r.original_credit},${r.applied_rate},${r.pkr_debit},${r.pkr_credit},${RATE_METHOD_LABEL[r.rate_method]}\n`;
    });
    return csv;
  };

  const columns = [
    { key: 'transaction_date', header: 'Date', align: 'left' as const, sortValue: (r: PkrConversionRow) => r.transaction_date, render: (r: PkrConversionRow) => <span className="text-gray-500 text-xs">{new Date(r.transaction_date).toLocaleDateString('en-PK')}</span> },
    { key: 'journal_reference', header: 'Reference', align: 'left' as const, render: (r: PkrConversionRow) => (
      <div>
        <span className="font-mono text-xs text-gray-500">{r.journal_reference}</span>
        <div className="text-xs text-gray-400">{r.account_code} · {r.account_name}</div>
      </div>
    ) },
    { key: 'original_currency', header: 'Currency', align: 'center' as const, render: (r: PkrConversionRow) => <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400">{r.original_currency}</span> },
    { key: 'original_amount', header: 'Original Amount', align: 'right' as const, render: (r: PkrConversionRow) => <span className="font-mono text-sm">{r.original_debit > 0 ? fmt(r.original_debit, r.original_currency) : r.original_credit > 0 ? `(${fmt(r.original_credit, r.original_currency)})` : '-'}</span> },
    { key: 'applied_rate', header: 'Applied Rate', align: 'right' as const, sortValue: (r: PkrConversionRow) => r.applied_rate, render: (r: PkrConversionRow) => <span className="font-mono text-xs text-gray-500">{Number(r.applied_rate).toFixed(4)}</span> },
    { key: 'rate_date', header: 'Rate Date/Period', align: 'left' as const, render: (r: PkrConversionRow) => <span className="text-xs text-gray-500">{new Date(r.rate_date).toLocaleDateString('en-PK')}</span> },
    { key: 'pkr_amount', header: 'PKR Amount', align: 'right' as const, render: (r: PkrConversionRow) => <span className="font-mono text-sm font-medium text-gray-900 dark:text-white">{r.pkr_debit > 0 ? fmt(r.pkr_debit, 'PKR') : r.pkr_credit > 0 ? `(${fmt(r.pkr_credit, 'PKR')})` : '-'}</span> },
    { key: 'rate_method', header: 'Rate Method', align: 'center' as const, render: (r: PkrConversionRow) => <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold ${RATE_METHOD_STYLE[r.rate_method]}`}>{RATE_METHOD_LABEL[r.rate_method]}</span> },
  ];

  return (
    <div className="p-6 max-w-[1600px] mx-auto space-y-5">
      <ReportHeader
        title="PKR Conversion Report"
        subtitle="Every foreign-currency journal line converted to PKR, labeled by the applied rate method and rate date/period used"
        period={periodLabel}
        dataAsOf={dataAsOf}
        filters={[
          ...(filters.currency ? [{ label: 'Currency', value: filters.currency }] : []),
          ...(rateMethod ? [{ label: 'Rate Method', value: RATE_METHOD_LABEL[rateMethod as RateMethod] }] : []),
          ...(filters.startDate ? [{ label: 'From', value: filters.startDate }] : []),
          ...(filters.endDate ? [{ label: 'To', value: filters.endDate }] : []),
        ]}
        reconciled={true}
        actions={<ExportManager reportId="pkr-conversion" reportName="PKR_Conversion_Report" getCsvData={getCsv} activeFilters={filters as Record<string, string>} />}
      />

      <ReportFilterBar
        showDateRange
        showCurrency
        currencyOptions={CURRENCY_OPTIONS}
        onApply={(f) => { setFilters(f); setPage(1); refetch(); }}
        isLoading={isLoading}
      />

      <div className="flex flex-wrap gap-2 items-center">
        <span className="text-xs text-gray-500 mr-1">Rate Method:</span>
        <button
          onClick={() => { setRateMethod(''); setPage(1); }}
          className={`px-3 py-1 text-xs rounded-full border ${!rateMethod ? 'bg-gray-900 text-white border-gray-900 dark:bg-white dark:text-gray-900' : 'border-gray-300 text-gray-600 dark:border-gray-600 dark:text-gray-300'}`}
        >
          All
        </button>
        {RATE_METHOD_FILTER_OPTIONS.map((o) => (
          <button
            key={o.value}
            onClick={() => { setRateMethod(o.value); setPage(1); }}
            className={`px-3 py-1 text-xs rounded-full border ${rateMethod === o.value ? 'bg-gray-900 text-white border-gray-900 dark:bg-white dark:text-gray-900' : 'border-gray-300 text-gray-600 dark:border-gray-600 dark:text-gray-300'}`}
          >
            {o.label}
          </button>
        ))}
        <span className="text-xs text-gray-400 ml-auto">{totalCount} lines{pendingCount > 0 ? ` · ${pendingCount} pending` : ''}</span>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-20"><div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin" /></div>
      ) : rows.length > 0 ? (
        <ReportTable
          columns={columns}
          data={rows}
          keyExtractor={(r: any) => r.line_id}
          pageSize={50}
          emptyMessage="No PKR conversion entries found"
        />
      ) : (
        <EmptyReportState icon="document" title="No Conversion Entries" message="No foreign-currency journal lines found for the selected filters" hint="Adjust date range, currency, or rate-method filter" />
      )}
    </div>
  );
}

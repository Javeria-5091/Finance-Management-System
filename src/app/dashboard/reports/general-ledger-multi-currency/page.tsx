'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getGeneralLedgerMultiCurrency } from '@/services/report.service';
import ReportHeader from '@/components/reports/ReportHeader';
import ReportFilterBar from '@/components/reports/ReportFilterBar';
import ReportTable from '@/components/reports/ReportTable';
import ExportManager from '@/components/reports/ExportManager';
import EmptyReportState from '@/components/reports/EmptyReportState';
import type { GLMultiCurrencyEntry, ReportFilters } from '@/types/reports.types';

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

export default function GeneralLedgerMultiCurrencyPage() {
  const [filters, setFilters] = useState<ReportFilters>({});
  const [page, setPage] = useState(1);
  const [dataAsOf] = useState(new Date().toISOString());

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['gl-multi-currency', filters, page],
    queryFn: () => getGeneralLedgerMultiCurrency({
      currency: filters.currency,
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
    let csv = 'Date,Ref,Description,Account,Original Currency,Original Debit,Original Credit,Applied Rate,PKR Debit,PKR Credit,Running Balance (PKR)\n';
    rows.forEach((r: GLMultiCurrencyEntry) => {
      csv += `${r.date},${r.ref},"${r.description}",${r.account_name},${r.original_currency},${r.original_debit},${r.original_credit},${r.applied_exchange_rate},${r.base_debit},${r.base_credit},${r.running_balance_base}\n`;
    });
    return csv;
  };

  const columns = [
    { key: 'date', header: 'Date', align: 'left' as const, sortValue: (r: GLMultiCurrencyEntry) => r.date, render: (r: GLMultiCurrencyEntry) => <span className="text-gray-500 text-xs">{r.date ? new Date(r.date).toLocaleDateString('en-PK') : '-'}</span> },
    { key: 'ref', header: 'Reference', align: 'left' as const, render: (r: GLMultiCurrencyEntry) => <span className="font-mono text-xs text-gray-500">{r.ref}</span> },
    { key: 'description', header: 'Description', align: 'left' as const, sortValue: (r: GLMultiCurrencyEntry) => r.description, render: (r: GLMultiCurrencyEntry) => (
      <div>
        <span className="font-medium text-gray-900 dark:text-white">{r.description}</span>
        <div className="text-xs text-gray-400">{r.account_code} · {r.account_name}</div>
      </div>
    ) },
    { key: 'original_currency', header: 'Currency', align: 'center' as const, render: (r: GLMultiCurrencyEntry) => <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400">{r.original_currency}</span> },
    { key: 'original_debit', header: 'Original Debit', align: 'right' as const, sortValue: (r: GLMultiCurrencyEntry) => r.original_debit, render: (r: GLMultiCurrencyEntry) => <span className="font-mono text-sm">{r.original_debit > 0 ? fmt(r.original_debit, r.original_currency) : '-'}</span> },
    { key: 'original_credit', header: 'Original Credit', align: 'right' as const, sortValue: (r: GLMultiCurrencyEntry) => r.original_credit, render: (r: GLMultiCurrencyEntry) => <span className="font-mono text-sm">{r.original_credit > 0 ? fmt(r.original_credit, r.original_currency) : '-'}</span> },
    { key: 'applied_exchange_rate', header: 'Rate', align: 'right' as const, render: (r: GLMultiCurrencyEntry) => <span className="font-mono text-xs text-gray-500">{Number(r.applied_exchange_rate).toFixed(4)}</span> },
    { key: 'base_debit', header: 'PKR Debit', align: 'right' as const, sortValue: (r: GLMultiCurrencyEntry) => r.base_debit, render: (r: GLMultiCurrencyEntry) => <span className="font-mono text-sm text-gray-900 dark:text-white">{r.base_debit > 0 ? fmt(r.base_debit, 'PKR') : '-'}</span> },
    { key: 'base_credit', header: 'PKR Credit', align: 'right' as const, sortValue: (r: GLMultiCurrencyEntry) => r.base_credit, render: (r: GLMultiCurrencyEntry) => <span className="font-mono text-sm text-gray-900 dark:text-white">{r.base_credit > 0 ? fmt(r.base_credit, 'PKR') : '-'}</span> },
    { key: 'running_balance_base', header: 'Balance (PKR)', align: 'right' as const, sortValue: (r: GLMultiCurrencyEntry) => r.running_balance_base, render: (r: GLMultiCurrencyEntry) => <span className={`font-mono text-sm font-medium ${r.running_balance_base >= 0 ? 'text-gray-900 dark:text-white' : 'text-red-600'}`}>{fmt(r.running_balance_base, 'PKR')}</span> },
  ];

  return (
    <div className="p-6 max-w-[1600px] mx-auto space-y-5">
      <ReportHeader
        title="Original-Currency Ledgers"
        subtitle="Foreign-currency transactions shown in their original currency alongside the PKR-converted amounts and applied rate"
        period={periodLabel}
        dataAsOf={dataAsOf}
        filters={[
          ...(filters.currency ? [{ label: 'Currency', value: filters.currency }] : []),
          ...(filters.startDate ? [{ label: 'From', value: filters.startDate }] : []),
          ...(filters.endDate ? [{ label: 'To', value: filters.endDate }] : []),
        ]}
        reconciled={true}
        actions={<ExportManager reportId="general-ledger-multi-currency" reportName="Original_Currency_Ledgers" getCsvData={getCsv} activeFilters={filters as Record<string, string>} />}
      />

      <ReportFilterBar
        showDateRange
        showCurrency
        currencyOptions={CURRENCY_OPTIONS}
        onApply={(f) => { setFilters(f); setPage(1); refetch(); }}
        isLoading={isLoading}
      />

      <div className="flex justify-end">
        <span className="text-xs text-gray-400 self-center">{totalCount} entries</span>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-20"><div className="w-8 h-8 border-4 border-violet-600 border-t-transparent rounded-full animate-spin" /></div>
      ) : rows.length > 0 ? (
        <ReportTable
          columns={columns}
          data={rows}
          keyExtractor={(r: any) => r.id}
          pageSize={50}
          emptyMessage="No foreign-currency ledger entries found"
        />
      ) : (
        <EmptyReportState icon="document" title="No Foreign-Currency Entries" message="No transactions found in a non-base currency for the selected filters" hint="Adjust date range or currency filter, or confirm foreign-currency journals have been posted" />
      )}
    </div>
  );
}

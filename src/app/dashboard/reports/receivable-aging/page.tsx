"use client";
import { useState, useEffect } from "react";
import { AlertTriangle, TrendingUp } from "lucide-react";
import { supabase } from "@/lib/supabase";

export default function ReceivableAgingPage() {
  const [agingData, setAgingData] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchAging = async () => {
      setLoading(true);
      const { data, error } = await supabase.from("receivable_aging").select("*");
      if (!error && data) {
        // Filter out fully paid invoices for cleaner aging view
        setAgingData(data.filter(d => d.outstanding_base_amount > 0));
      }
      setLoading(false);
    };
    fetchAging();
  }, []);

  // Calculate Totals
  const totals = agingData.reduce((acc, row) => ({
    current: acc.current + parseFloat(row.current_amount || 0),
    d1_30: acc.d1_30 + parseFloat(row.overdue_1_30_days || 0),
    d31_60: acc.d31_60 + parseFloat(row.overdue_31_60_days || 0),
    d61_90: acc.d61_90 + parseFloat(row.overdue_61_90_days || 0),
    d90_plus: acc.d90_plus + parseFloat(row.overdue_over_90_days || 0),
    total: acc.total + parseFloat(row.outstanding_base_amount || 0),
  }), { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0, total: 0 });

  const formatCurrency = (amount: number) => new Intl.NumberFormat("en-PK", { style: "currency", currency: "PKR" }).format(amount);

  return (
    <div className="p-6">
      <div className="flex items-center gap-3 mb-6">
        <TrendingUp className="w-6 h-6 text-orange-500" />
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Receivable Aging Report</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">Outstanding invoices grouped by how late they are</p>
        </div>
      </div>

      <div className="bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-xl overflow-hidden shadow-sm">
        <table className="w-full text-sm text-left">
          <thead className="bg-gray-50 dark:bg-gray-900/50 border-b dark:border-gray-700 text-xs text-gray-500 uppercase">
            <tr>
              <th className="p-3">Client / Invoice</th>
              <th className="p-3 text-right">Total Outstanding</th>
              <th className="p-3 text-right bg-green-50 dark:bg-green-900/10">Current</th>
              <th className="p-3 text-right bg-yellow-50 dark:bg-yellow-900/10">1-30 Days</th>
              <th className="p-3 text-right bg-orange-50 dark:bg-orange-900/10">31-60 Days</th>
              <th className="p-3 text-right bg-red-50 dark:bg-red-900/10">61-90 Days</th>
              <th className="p-3 text-right bg-red-100 dark:bg-red-900/20">90+ Days</th>
            </tr>
          </thead>
          <tbody className="divide-y dark:divide-gray-700">
            {loading ? (
              <tr><td colSpan={7} className="text-center py-10 text-gray-400">Calculating aging...</td></tr>
            ) : agingData.length === 0 ? (
              <tr><td colSpan={7} className="text-center py-10 text-gray-400">No outstanding receivables! 🎉</td></tr>
            ) : (
              agingData.map(row => (
                <tr key={row.invoice_id} className="hover:bg-gray-50 dark:hover:bg-gray-700/30">
                  <td className="p-3">
                    <div className="font-medium text-gray-900 dark:text-white">{row.client_name}</div>
                    <div className="text-xs text-gray-500">{row.invoice_number || 'N/A'}</div>
                  </td>
                  <td className="p-3 text-right font-semibold text-gray-900 dark:text-white">{formatCurrency(row.outstanding_base_amount)}</td>
                  <td className="p-3 text-right text-green-600 dark:text-green-400">{row.current_amount > 0 ? formatCurrency(row.current_amount) : '-'}</td>
                  <td className="p-3 text-right text-yellow-600 dark:text-yellow-400">{row.overdue_1_30_days > 0 ? formatCurrency(row.overdue_1_30_days) : '-'}</td>
                  <td className="p-3 text-right text-orange-600 dark:text-orange-400">{row.overdue_31_60_days > 0 ? formatCurrency(row.overdue_31_60_days) : '-'}</td>
                  <td className="p-3 text-right text-red-600 dark:text-red-400">{row.overdue_61_90_days > 0 ? formatCurrency(row.overdue_61_90_days) : '-'}</td>
                  <td className="p-3 text-right text-red-800 dark:text-red-300 font-bold">{row.overdue_over_90_days > 0 ? formatCurrency(row.overdue_over_90_days) : '-'}</td>
                </tr>
              ))
            )}
            
            {/* Totals Row */}
            {!loading && agingData.length > 0 && (
              <tr className="bg-gray-100 dark:bg-gray-900/50 font-bold border-t-2 dark:border-gray-600">
                <td className="p-3 text-gray-900 dark:text-white">TOTALS</td>
                <td className="p-3 text-right">{formatCurrency(totals.total)}</td>
                <td className="p-3 text-right">{formatCurrency(totals.current)}</td>
                <td className="p-3 text-right">{formatCurrency(totals.d1_30)}</td>
                <td className="p-3 text-right">{formatCurrency(totals.d31_60)}</td>
                <td className="p-3 text-right">{formatCurrency(totals.d61_90)}</td>
                <td className="p-3 text-right">{formatCurrency(totals.d90_plus)}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
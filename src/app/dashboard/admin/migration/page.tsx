'use client';
import { useState, useEffect } from 'react';
import { Database, ArrowRightLeft, AlertTriangle, CheckCircle2, ListChecks } from 'lucide-react';
import { supabase } from '@/lib/supabase';

interface OldCat { category: string; type: 'income' | 'expense'; count: number; total: number; }

export default function DataMigrationPage() {
  const [categories, setCategories] = useState<OldCat[]>([]);
  const [accounts, setAccounts] = useState<any[]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ migrated: number; failed: number } | null>(null);

  const incomeCats = categories.filter(c => c.type === 'income');
  const expenseCats = categories.filter(c => c.type === 'expense');
  const mappedCount = Object.keys(mapping).filter(k => mapping[k] !== '').length;
  const progress = categories.length > 0 ? (mappedCount / categories.length) * 100 : 0;

  useEffect(() => {
    const init = async () => {
      const { data: inc } = await supabase.from('incomes').select('category, amount').is('journal_entry_id', null);
      const { data: exp } = await supabase.from('expenses').select('category, amount').is('journal_entry_id', null);
      
      const group = (arr: any[] | null, type: 'income' | 'expense') => {
        if (!arr) return [];
        const map: Record<string, OldCat> = {};
        arr.forEach(r => {
          const key = r.category || 'Uncategorized';
          if (!map[key]) map[key] = { category: key, type, count: 0, total: 0 };
          map[key].count++; map[key].total += r.amount;
        });
        return Object.values(map);
      };

      setCategories([...group(inc, 'income'), ...group(exp, 'expense')]);
      const { data: acc } = await supabase.schema('finance').from('chart_of_accounts').select('id, code, name, account_type').eq('is_active', true).eq('posting_allowed', true).order('code');
      setAccounts(acc || []);
    };
    init();
  }, []);

  const handleMigrate = async () => {
    if (!confirm('⚠️ WARNING: This will permanently post historical data to the General Ledger. Ensure you have a database backup.')) return;
    setLoading(true); setResult(null);
    const cashAccId = accounts.find(a => a.code === '1110')?.id;

    const payload = categories.map(c => ({
      category: c.category, type: c.type,
      target_account_id: mapping[`${c.type}-${c.category}`] || '',
      default_cash_account_id: cashAccId || ''
    }));

    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/migrate-historical-data`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${(await supabase.auth.getSession()).data.session?.access_token}` },
        body: JSON.stringify({ mapping: payload })
      });
      setResult(await res.json());
    } catch { alert('Migration failed due to a network error.'); }
    finally { setLoading(false); }
  };

  const renderTable = (cats: OldCat[], type: 'income' | 'expense') => (
    <div className="mb-6">
      <h3 className="text-sm font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-3 border-b dark:border-slate-700 pb-2">
        {type === 'income' ? 'Revenue / Income Categories' : 'Expense / Cost Categories'}
      </h3>
      <div className="space-y-2">
        {cats.map(cat => {
          const key = `${cat.type}-${cat.category}`;
          const isMapped = mapping[key] !== '';
          return (
            <div key={key} className={`flex items-center gap-4 p-3 rounded-lg border transition-all ${isMapped ? 'bg-slate-50 dark:bg-slate-800/50 border-slate-200 dark:border-slate-700' : 'bg-white dark:bg-slate-900 border-amber-300 dark:border-amber-600 shadow-sm'}`}>
              <div className="flex-1 grid grid-cols-3 gap-4 items-center">
                <span className="font-medium text-slate-900 dark:text-white truncate">{cat.category}</span>
                <span className="text-sm text-slate-500 text-right">{cat.count} transactions</span>
                <span className="text-sm font-mono font-semibold text-slate-700 dark:text-slate-300 text-right">
                  PKR {cat.total.toLocaleString()}
                </span>
              </div>
              <div className="flex items-center gap-2 min-w-[300px]">
                <ArrowRightLeft className={`w-4 h-4 ${isMapped ? 'text-emerald-500' : 'text-slate-400'}`} />
                <select
                  className={`w-full p-2 text-sm border rounded-md focus:ring-2 focus:ring-blue-500 outline-none dark:bg-slate-800 dark:border-slate-600 ${!isMapped ? 'border-amber-400 dark:border-amber-500 bg-amber-50 dark:bg-amber-900/20' : ''}`}
                  value={mapping[key] || ''}
                  onChange={e => setMapping({ ...mapping, [key]: e.target.value })}
                >
                  <option value="">-- Select COA Account --</option>
                  {accounts.filter(a => type === 'income' ? a.account_type === 'REVENUE' : ['EXPENSE', 'COST_OF_SALES'].includes(a.account_type)).map(a => (
                    <option key={a.id} value={a.id}>{a.code} - {a.name}</option>
                  ))}
                </select>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );

  return (
    <div className="p-8 max-w-6xl mx-auto space-y-8">
      {/* Header */}
      <div className="flex justify-between items-end border-b dark:border-slate-700 pb-6">
        <div>
          <h1 className="text-3xl font-bold text-slate-900 dark:text-white flex items-center gap-3">
            <Database className="w-8 h-8 text-blue-600" /> Historical Data Migration
          </h1>
          <p className="text-slate-500 mt-1">Map your legacy categories to the new Chart of Accounts to finalize the General Ledger.</p>
        </div>
        <div className="text-right">
          <p className="text-sm text-slate-500">Mapping Progress</p>
          <p className="text-2xl font-bold text-slate-900 dark:text-white">{mappedCount} / {categories.length}</p>
        </div>
      </div>

      {/* Progress Bar */}
      <div className="w-full bg-slate-200 dark:bg-slate-700 rounded-full h-2.5">
        <div className="bg-blue-600 h-2.5 rounded-full transition-all duration-300" style={{ width: `${progress}%` }}></div>
      </div>

      {/* Alerts */}
      {mappedCount < categories.length && (
        <div className="bg-amber-50 border-l-4 border-amber-400 text-amber-800 p-4 rounded-r-lg flex gap-3 text-sm">
          <AlertTriangle className="w-5 h-5 flex-shrink-0 mt-0.5" />
          <div>
            <p className="font-semibold">Incomplete Mapping</p>
            <p>{categories.length - mappedCount} categories are still unmapped. The migration button will remain disabled until all are mapped.</p>
          </div>
        </div>
      )}

      {result && (
        <div className="bg-emerald-50 border-l-4 border-emerald-400 text-emerald-800 p-4 rounded-r-lg flex gap-3 text-sm">
          <CheckCircle2 className="w-5 h-5 flex-shrink-0 mt-0.5" />
          <div>
            <p className="font-semibold">Migration Successful</p>
            <p>Posted <strong>{result.migrated}</strong> entries to the GL. Failed: <strong>{result.failed}</strong>.</p>
          </div>
        </div>
      )}

      {/* Tables */}
      <div className="bg-white dark:bg-slate-800 border dark:border-slate-700 rounded-xl p-6 shadow-sm">
        {renderTable(incomeCats, 'income')}
        {renderTable(expenseCats, 'expense')}
      </div>

      {/* Action Button */}
      <button
        onClick={handleMigrate}
        disabled={loading || mappedCount !== categories.length}
        className="w-full py-4 bg-slate-900 dark:bg-blue-600 text-white rounded-xl font-semibold text-lg hover:bg-slate-800 dark:hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-3 shadow-lg"
      >
        {loading ? (
          <>
            <ListChecks className="w-5 h-5 animate-spin" /> Processing Migration...
          </>
        ) : (
          <>Execute Data Migration</>
        )}
      </button>
    </div>
  );
}
'use client';

import { useState, useEffect } from 'react';
import { Plus, Search, ChevronDown, ChevronRight, X, FileText, AlertCircle } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import type { JournalEntry, JournalLine, AccountingPeriod } from '@/types/accounting.types';

const STATUS_COLORS: Record<string, string> = {
  DRAFT: 'bg-gray-100 text-gray-700 dark:bg-gray-600/30 dark:text-gray-300',
  SUBMITTED: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
  VERIFIED: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300',
  APPROVED: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300',
  POSTED: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300',
  REVERSED: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
  REJECTED: 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300',
  CANCELLED: 'bg-gray-200 text-gray-500 dark:bg-gray-700 dark:text-gray-400'
};

export default function JournalEntriesPage() {
  const [journals, setJournals] = useState<(JournalEntry & { lines?: JournalLine[] })[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  
  // Proper Form State
  const [description, setDescription] = useState('');
  const [transactionDate, setTransactionDate] = useState(new Date().toISOString().split('T')[0]);
  const [selectedPeriod, setSelectedPeriod] = useState('');
  const [periods, setPeriods] = useState<AccountingPeriod[]>([]);
  
  // Journal Lines State
  const [lines, setLines] = useState([{ account_id: '', debit: 0, credit: 0, description: '' }]);

  // Load Journals
  const loadJournals = async () => {
    let query = supabase
      .from('journal_entries')
      .select('*')
      .order('transaction_date', { ascending: false })
      .limit(50);

    if (searchQuery) {
      query = query.or(`reference.ilike.%${searchQuery}%,description.ilike.%${searchQuery}%`);
    }

    const { data } = await query;
    if (data) setJournals(data);
  };

  // Load Open Periods for Modal
  const loadPeriods = async () => {
    const { data } = await supabase
      .from('accounting_periods')
      .select('*, fiscal_years!inner(status)')
      .eq('fiscal_years.status', 'OPEN')
      .order('start_date', { ascending: false });
    
    if (data) setPeriods(data);
  };

  useEffect(() => { loadJournals(); }, [searchQuery]);
  
  const openCreateModal = () => {
    loadPeriods();
    setDescription('');
    setTransactionDate(new Date().toISOString().split('T')[0]);
    setSelectedPeriod('');
    setLines([{ account_id: '', debit: 0, credit: 0, description: '' }]);
    setShowModal(true);
  };

  const loadLines = async (jeId: string) => {
    if (expandedId === jeId) { setExpandedId(null); return; }
    const { data } = await supabase
      .from('journal_lines')
      .select('*, chart_of_accounts(code, name)')
      .eq('journal_entry_id', jeId)
      .order('line_number');
      
    setJournals(prev => prev.map(j => j.id === jeId ? { ...j, lines: data || [] } : j));
    setExpandedId(jeId);
  };

  // Line Management
  const addLine = () => setLines([...lines, { account_id: '', debit: 0, credit: 0, description: '' }]);
  
  const removeLine = (index: number) => {
    if (lines.length <= 2) return alert("Journal must have at least 2 lines");
    setLines(lines.filter((_, i) => i !== index));
  };

  const updateLine = (i: number, field: string, value: any) => {
    const newLines = [...lines];
    if (field === 'debit' || field === 'credit') {
      const numVal = parseFloat(value) || 0;
      if (numVal > 0) {
        newLines[i] = { ...newLines[i], [field]: numVal, [field === 'debit' ? 'credit' : 'debit']: 0 };
      } else {
        newLines[i] = { ...newLines[i], [field]: 0 };
      }
    } else {
      newLines[i] = { ...newLines[i], [field]: value };
    }
    setLines(newLines);
  };

  const totalDr = lines.reduce((sum, l) => sum + Number(l.debit), 0);
  const totalCr = lines.reduce((sum, l) => sum + Number(l.credit), 0);
  const isBalanced = Math.abs(totalDr - totalCr) < 0.01 && (totalDr > 0 || totalCr > 0);

  const handleSaveDraft = async () => {
    if (!isBalanced) return alert("Journal must be balanced and greater than 0!");
    if (!description.trim()) return alert("Description is required");
    if (!selectedPeriod) return alert("Please select an accounting period");

    const user = (await supabase.auth.getUser()).data.user;
    if (!user) return;

    const period = periods.find(p => p.id === selectedPeriod);
    
    const ref = await supabase.rpc('get_next_number', { p_type: 'JOURNAL_ENTRY' });
    
    const { data: je, error } = await supabase.from('journal_entries').insert({
      reference: ref.data, 
      description: description, 
      status: 'DRAFT',
      transaction_date: transactionDate, 
      period_id: selectedPeriod, 
      fiscal_year_id: period?.fiscal_year_id,
      total_debit: totalDr, 
      total_credit: totalCr, 
      created_by: user.id
    }).select().single();

    if (!error && je) {
      const linesToInsert = lines.map((l, i) => ({
        journal_entry_id: je.id, 
        line_number: i + 1, 
        account_id: l.account_id,
        description: l.description,
        debit_amount: l.debit, 
        credit_amount: l.credit,
        created_by: user.id
      })).filter(l => l.account_id); // Don't insert empty account lines

      if (linesToInsert.length >= 2) {
        await supabase.from('journal_lines').insert(linesToInsert);
        setShowModal(false); 
        loadJournals();
      } else {
        alert("Please select valid accounts for at least 2 lines.");
        // Cleanup orphan header
        await supabase.from('journal_entries').delete().eq('id', je.id);
      }
    } else { 
      console.error(error); 
      alert("Error saving journal: " + error?.message);
    }
  };

  return (
    <div className="p-4 md:p-6 space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Journal Entries</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">Record double-entry financial transactions</p>
        </div>
        <button 
          onClick={openCreateModal} 
          className="flex items-center gap-2 px-4 py-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors text-sm font-medium shadow-sm"
        >
          <Plus className="w-4 h-4" /> New Journal
        </button>
      </div>

      {/* Search Bar */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 dark:text-gray-500" />
        <input
          type="text"
          placeholder="Search by Reference or Description..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full pl-10 pr-4 py-2.5 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg text-sm text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-colors"
        />
      </div>

      {/* Table */}
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-gray-900/50 text-left text-gray-500 dark:text-gray-400 uppercase text-xs">
              <tr>
                <th className="p-4 font-medium w-8"></th>
                <th className="p-4 font-medium">Ref</th>
                <th className="p-4 font-medium">Date</th>
                <th className="p-4 font-medium">Description</th>
                <th className="p-4 font-medium text-right">Debit</th>
                <th className="p-4 font-medium text-right">Credit</th>
                <th className="p-4 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-700/50">
              {journals.length === 0 ? (
                <tr>
                  <td colSpan={7} className="p-8 text-center text-gray-400 dark:text-gray-500">
                    No journal entries found.
                  </td>
                </tr>
              ) : (
                journals.map(j => (
                  <>
                    <tr 
                      key={j.id} 
                      className="hover:bg-gray-50 dark:hover:bg-gray-700/30 cursor-pointer transition-colors" 
                      onClick={() => loadLines(j.id)}
                    >
                      <td className="p-4">
                        {expandedId === j.id ? 
                          <ChevronDown className="w-4 h-4 text-gray-400" /> : 
                          <ChevronRight className="w-4 h-4 text-gray-400" />
                        }
                      </td>
                      <td className="p-4 font-mono text-xs text-blue-600 dark:text-blue-400">{j.reference}</td>
                      <td className="p-4 text-gray-600 dark:text-gray-300">{j.transaction_date}</td>
                      <td className="p-4 text-gray-900 dark:text-white font-medium truncate max-w-xs">{j.description}</td>
                      <td className="p-4 text-right text-gray-700 dark:text-gray-300">{j.total_debit.toLocaleString()}</td>
                      <td className="p-4 text-right text-gray-700 dark:text-gray-300">{j.total_credit.toLocaleString()}</td>
                      <td className="p-4">
                        <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${STATUS_COLORS[j.status]}`}>
                          {j.status}
                        </span>
                      </td>
                    </tr>
                    
                    {/* Expanded Lines */}
                    {expandedId === j.id && j.lines && (
                      <tr key={`${j.id}-lines`} className="bg-gray-50/50 dark:bg-gray-900/20">
                        <td colSpan={7} className="p-6">
                          <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-lg overflow-hidden">
                            <table className="w-full text-xs">
                              <thead className="bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-300 uppercase">
                                <tr>
                                  <th className="p-2 text-left">#</th>
                                  <th className="p-2 text-left">Account</th>
                                  <th className="p-2 text-left">Description</th>
                                  <th className="p-2 text-right">Debit</th>
                                  <th className="p-2 text-right">Credit</th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                                {j.lines?.map(l => (
                                  <tr key={l.id}>
                                    <td className="p-2 text-gray-500">{l.line_number}</td>
                                    <td className="p-2 font-mono text-gray-900 dark:text-white">
                                      {l.account_code} - {l.account_name}
                                    </td>
                                    <td className="p-2 text-gray-600 dark:text-gray-300">{l.description || '-'}</td>
                                    <td className="p-2 text-right text-gray-900 dark:text-white font-medium">
                                      {l.debit_amount > 0 ? l.debit_amount.toLocaleString() : '-'}
                                    </td>
                                    <td className="p-2 text-right text-gray-900 dark:text-white font-medium">
                                      {l.credit_amount > 0 ? l.credit_amount.toLocaleString() : '-'}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ==========================================
          CREATE JOURNAL MODAL (Proper UI)
          ========================================== */}
      {showModal && (
        <div className="fixed inset-0 bg-black/60 dark:bg-black/70 z-50 flex items-center justify-center p-4 backdrop-blur-sm">
          <div className="bg-white dark:bg-gray-800 rounded-xl w-full max-w-4xl max-h-[90vh] overflow-y-auto shadow-2xl border border-gray-200 dark:border-gray-700">
            {/* Modal Header */}
            <div className="flex items-center justify-between p-5 border-b border-gray-200 dark:border-gray-700 sticky top-0 bg-white dark:bg-gray-800 z-10">
              <h2 className="text-lg font-bold text-gray-900 dark:text-white">Create Journal Entry</h2>
              <button onClick={() => setShowModal(false)} className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500 dark:text-gray-400">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-5 space-y-6">
              {/* Header Fields */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="md:col-span-2">
                  <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Description *</label>
                  <input 
                    type="text" 
                    value={description}
                    onChange={e => setDescription(e.target.value)}
                    className="w-full px-3 py-2.5 bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded-lg text-sm text-gray-900 dark:text-white outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="e.g., Monthly salary expense"
                  />
                </div>
                
                <div>
                  <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Transaction Date *</label>
                  <input 
                    type="date" 
                    value={transactionDate}
                    onChange={e => setTransactionDate(e.target.value)}
                    className="w-full px-3 py-2.5 bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded-lg text-sm text-gray-900 dark:text-white outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Accounting Period *</label>
                  <select
                    value={selectedPeriod}
                    onChange={e => setSelectedPeriod(e.target.value)}
                    className="w-full px-3 py-2.5 bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded-lg text-sm text-gray-900 dark:text-white outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="">Select Period...</option>
                    {periods.map(p => (
                      <option key={p.id} value={p.id} disabled={p.status !== 'OPEN'}>
                        {p.name} {p.status !== 'OPEN' ? '(Closed)' : ''}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Lines Section */}
              <div>
                <div className="flex items-center justify-between mb-3">
                  <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Journal Lines</label>
                  <button onClick={addLine} className="text-xs text-blue-600 dark:text-blue-400 hover:underline font-medium">
                    + Add Line
                  </button>
                </div>

                <div className="space-y-2">
                  {/* Table Header for Lines */}
                  <div className="grid grid-cols-12 gap-2 px-2 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                    <div className="col-span-5">Account ID</div>
                    <div className="col-span-3">Description</div>
                    <div className="col-span-2 text-right">Debit</div>
                    <div className="col-span-1 text-right">Credit</div>
                    <div className="col-span-1"></div>
                  </div>

                  {lines.map((l, i) => (
                    <div key={i} className="grid grid-cols-12 gap-2 items-center bg-gray-50 dark:bg-gray-900/50 p-2 rounded-lg border border-gray-100 dark:border-gray-700">
                      <input 
                        type="text" 
                        placeholder="UUID from COA" 
                        value={l.account_id} 
                        onChange={e => updateLine(i, 'account_id', e.target.value)} 
                        className="col-span-5 px-2 py-2 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded text-xs text-gray-900 dark:text-white outline-none focus:ring-1 focus:ring-blue-500 font-mono"
                      />
                      <input 
                        type="text" 
                        placeholder="Line detail" 
                        value={l.description} 
                        onChange={e => updateLine(i, 'description', e.target.value)} 
                        className="col-span-3 px-2 py-2 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded text-xs text-gray-900 dark:text-white outline-none focus:ring-1 focus:ring-blue-500"
                      />
                      <input 
                        type="number" 
                        placeholder="0.00" 
                        value={l.debit || ''} 
                        onChange={e => updateLine(i, 'debit', parseFloat(e.target.value)||0)} 
                        className="col-span-2 px-2 py-2 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded text-xs text-right text-gray-900 dark:text-white outline-none focus:ring-1 focus:ring-blue-500"
                      />
                      <input 
                        type="number" 
                        placeholder="0.00" 
                        value={l.credit || ''} 
                        onChange={e => updateLine(i, 'credit', parseFloat(e.target.value)||0)} 
                        className="col-span-1 px-2 py-2 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded text-xs text-right text-gray-900 dark:text-white outline-none focus:ring-1 focus:ring-blue-500"
                      />
                      <button 
                        onClick={() => removeLine(i)} 
                        className="col-span-1 flex justify-center p-1.5 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded transition-colors"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>

                {/* Total Bar */}
                <div className={`mt-4 flex items-center justify-between p-3 rounded-lg border ${
                  isBalanced 
                    ? 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800 text-green-700 dark:text-green-400' 
                    : 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800 text-red-700 dark:text-red-400'
                }`}>
                  <div className="flex items-center gap-4 text-sm font-medium">
                    <span>Total Debit: {totalDr.toFixed(2)}</span>
                    <span>Total Credit: {totalCr.toFixed(2)}</span>
                  </div>
                  <div className="flex items-center gap-2 font-bold text-sm">
                    {isBalanced ? (
                      <>✓ Balanced</>
                    ) : (
                      <>
                        <AlertCircle className="w-4 h-4" /> ⚠ Unbalanced (Diff: {Math.abs(totalDr - totalCr).toFixed(2)})
                      </>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* Modal Footer */}
            <div className="flex items-center justify-end gap-3 p-5 border-t border-gray-200 dark:border-gray-700 sticky bottom-0 bg-white dark:bg-gray-800">
              <button 
                onClick={() => setShowModal(false)} 
                className="px-4 py-2.5 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button 
                onClick={handleSaveDraft} 
                disabled={!isBalanced || !description || !selectedPeriod}
                className="px-5 py-2.5 text-sm font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                Save as Draft
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
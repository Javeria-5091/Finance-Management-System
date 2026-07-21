"use client";
import { useState, useEffect } from "react";
import { Plus, ChevronDown, ChevronRight, X, Search } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useAccounts } from "@/hooks/useAccounts"; 
import { useFiscalPeriod } from "@/hooks/useFiscalPeriod"; 
import { usePermissions } from "@/hooks/usePermissions"; 

export default function JournalEntriesPage() {
  
  const { accounts } = useAccounts();
  const { currentPeriod } = useFiscalPeriod();
  const { hasPermission } = usePermissions();
  
  const canCreate = hasPermission("JOURNAL_CREATE");

  const [journals, setJournals] = useState<any[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [lines, setLines] = useState([{ account_id: "", debit: 0, credit: 0 }]);
  const [description, setDescription] = useState("");
  const [search, setSearch] = useState("");

  useEffect(() => {
    supabase.from("journal_entries").select("*").order("transaction_date", { ascending: false }).limit(50)
      .then(({ data }) => data && setJournals(data));
  }, []);

  const loadLines = async (jeId: string) => {
    if (expandedId === jeId) { setExpandedId(null); return; }
    const { data } = await supabase.from("journal_lines").select("*, chart_of_accounts(code, name)").eq("journal_entry_id", jeId).order("line_number");
    setJournals(prev => prev.map(j => j.id === jeId ? { ...j, lines: data || [] } : j));
    setExpandedId(jeId);
  };

  const addLine = () => setLines([...lines, { account_id: "", debit: 0, credit: 0 }]);
  
  const updateLine = (i: number, field: string, value: any) => {
    const newLines = [...lines];
    if (field === 'debit' || field === 'credit') {
      if (value > 0) newLines[i] = { ...newLines[i], [field]: value, [field === 'debit' ? 'credit' : 'debit']: 0 };
      else newLines[i] = { ...newLines[i], [field]: value };
    } else {
      newLines[i] = { ...newLines[i], [field]: value };
    }
    setLines(newLines);
  };

  const totalDr = lines.reduce((sum, l) => sum + Number(l.debit), 0);
  const totalCr = lines.reduce((sum, l) => sum + Number(l.credit), 0);
  const isBalanced = Math.abs(totalDr - totalCr) < 0.01;

  const handleSaveDraft = async () => {
    if (!isBalanced || !currentPeriod) return alert("Journal must be balanced and Period must be open!");
    
    const ref = await supabase.rpc("get_next_number", { p_type: "JOURNAL_ENTRY" });
    
    const { data: je, error } = await supabase.from("journal_entries").insert({
      reference: ref.data, description, status: "DRAFT",
      transaction_date: new Date().toISOString().split("T")[0], 
      period_id: currentPeriod.period_id, 
      fiscal_year_id: currentPeriod.fiscal_year_id, 
      total_debit: totalDr, total_credit: totalCr, 
      created_by: (await supabase.auth.getUser()).data.user?.id
    }).select().single();

    if (!error && je) {
      const linesToInsert = lines.map((l, i) => ({
        journal_entry_id: je.id, line_number: i + 1, account_id: l.account_id,
        debit_amount: l.debit, credit_amount: l.credit
      }));
      await supabase.from("journal_lines").insert(linesToInsert);
      setShowModal(false); setDescription(""); setLines([{ account_id: "", debit: 0, credit: 0 }]);
      // Refresh list
      const { data: fresh } = await supabase.from("journal_entries").select("*").order("transaction_date", { ascending: false }).limit(50);
      if(fresh) setJournals(fresh);
    } else console.error(error);
  };

  // Filter journals based on search
  const filteredJournals = journals.filter(j => 
    j.reference?.toLowerCase().includes(search.toLowerCase()) || 
    j.description?.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="p-6">
      <div className="flex justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Journal Entries</h1>
        {canCreate && (
          <button onClick={() => setShowModal(true)} className="bg-blue-600 text-white px-4 py-2 rounded-lg flex items-center gap-2">
            <Plus className="w-4 h-4" /> New Journal
          </button>
        )}
      </div>

      {/* Search Bar */}
      <div className="relative mb-4">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
        <input 
          type="text" 
          placeholder="Search by Reference or Description..." 
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full pl-10 pr-4 py-2 border dark:border-gray-600 rounded-lg bg-transparent dark:bg-gray-800 text-sm"
        />
      </div>

      <div className="bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 dark:bg-gray-900/50 text-left text-xs uppercase text-gray-500">
            <tr>
              <th className="p-3">Ref</th>
              <th className="p-3">Date</th>
              <th className="p-3">Description</th>
              <th className="p-3 text-right">Debit</th>
              <th className="p-3 text-right">Credit</th>
              <th className="p-3">Status</th>
            </tr>
          </thead>
          <tbody>
            {filteredJournals.map(j => (
              <>
                <tr key={j.id} className="border-t dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/30 cursor-pointer" onClick={() => loadLines(j.id)}>
                  <td className="p-3 font-mono text-blue-600 dark:text-blue-400">{j.reference}</td>
                  <td className="p-3 text-gray-500">{j.transaction_date}</td>
                  <td className="p-3 font-medium text-gray-900 dark:text-white">{j.description}</td>
                  <td className="p-3 text-right">{j.total_debit?.toLocaleString()}</td>
                  <td className="p-3 text-right">{j.total_credit?.toLocaleString()}</td>
                  <td className="p-3"><span className={`px-2 py-0.5 rounded text-xs ${j.status === 'POSTED' ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' : 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300'}`}>{j.status}</span></td>
                </tr>
                {expandedId === j.id && j.lines && (
                  <tr key={`${j.id}-lines`} className="bg-gray-50 dark:bg-gray-900/20 border-t dark:border-gray-700">
                    <td colSpan={6} className="p-4">
                      <table className="w-full text-xs border dark:border-gray-600 rounded overflow-hidden">
                        <thead><tr className="bg-gray-100 dark:bg-gray-800"><th className="p-2 text-left">#</th><th className="p-2 text-left">Account</th><th className="p-2 text-right">Debit</th><th className="p-2 text-right">Credit</th></tr></thead>
                        <tbody>
                          {j.lines?.map((l: any) => (
                            <tr key={l.id} className="border-t dark:border-gray-700">
                              <td className="p-2">{l.line_number}</td>
                              <td className="p-2">{l.chart_of_accounts?.code} - {l.chart_of_accounts?.name}</td>
                              <td className="p-2 text-right">{l.debit_amount > 0 ? l.debit_amount.toLocaleString() : '-'}</td>
                              <td className="p-2 text-right">{l.credit_amount > 0 ? l.credit_amount.toLocaleString() : '-'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </td>
                  </tr>
                )}
              </>
            ))}
          </tbody>
        </table>
      </div>

      {/* Create Modal - Ab ZYADA SMART HAI */}
      {showModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-xl w-full max-w-4xl p-6 max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between mb-4">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Create Journal Entry</h2>
              <button onClick={() => setShowModal(false)}><X className="w-5 h-5 text-gray-500" /></button>
            </div>
            
            <div className="space-y-4">
              <div>
                <label className="text-sm font-medium text-gray-700 dark:text-gray-300">Description</label>
                <input type="text" value={description} onChange={e => setDescription(e.target.value)} className="w-full border dark:border-gray-600 rounded-lg p-2 mt-1 bg-transparent dark:bg-gray-700 text-sm" placeholder="Why are you making this journal?" />
              </div>

              <div className="text-xs text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-500/10 p-2 rounded">
                Auto-Period Detected: <strong>{currentPeriod?.period_name || "No open period found!"}</strong>
              </div>
            
              <div>
                <label className="text-sm font-medium text-gray-700 dark:text-gray-300">Journal Lines</label>
                {lines.map((l, i) => (
                  <div key={i} className="flex gap-2 mt-2 items-center">
                    
                    <select 
                      value={l.account_id} 
                      onChange={e => updateLine(i, 'account_id', e.target.value)}
                      className="flex-1 border dark:border-gray-600 rounded p-2 text-sm bg-transparent dark:bg-gray-700"
                    >
                      <option value="">Select Account...</option>
                      {accounts.map(acc => (
                        <option key={acc.id} value={acc.id}>{acc.code} - {acc.name}</option>
                      ))}
                    </select>
                    <input type="number" placeholder="Debit" value={l.debit || ''} onChange={e => updateLine(i, 'debit', parseFloat(e.target.value)||0)} className="w-28 border dark:border-gray-600 rounded p-2 text-sm text-right bg-transparent dark:bg-gray-700" />
                    <input type="number" placeholder="Credit" value={l.credit || ''} onChange={e => updateLine(i, 'credit', parseFloat(e.target.value)||0)} className="w-28 border dark:border-gray-600 rounded p-2 text-sm text-right bg-transparent dark:bg-gray-700" />
                  </div>
                ))}
                <button onClick={addLine} className="mt-2 text-blue-600 text-sm font-medium">+ Add Line</button>
              </div>

              <div className={`flex justify-between p-3 rounded ${isBalanced ? 'bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-400' : 'bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-400'}`}>
                <span>DR: {totalDr.toFixed(2)}</span>
                <span>CR: {totalCr.toFixed(2)}</span>
                <span className="font-bold">{isBalanced ? '✓ Balanced' : '⚠ Unbalanced'}</span>
              </div>
            </div>

            <div className="flex justify-end gap-2 mt-6 border-t dark:border-gray-700 pt-4">
              <button onClick={() => setShowModal(false)} className="px-4 py-2 border dark:border-gray-600 rounded text-sm">Cancel</button>
              <button onClick={handleSaveDraft} disabled={!isBalanced} className="px-4 py-2 bg-blue-600 text-white rounded text-sm disabled:opacity-50">Save as Draft</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
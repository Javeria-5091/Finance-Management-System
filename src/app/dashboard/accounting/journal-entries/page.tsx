"use client";
import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/context/AuthContext";
import { usePermissions } from "@/context/PermissionContext";
import { Plus, X, CheckCircle, Eye, RotateCcw, AlertTriangle } from "lucide-react";
import toast from "react-hot-toast";
import ReasonModal from "@/components/finance/ReasonModal";
import { callWorkflow, postJournal } from "@/lib/workflow";

const STATUS_STYLES: Record<string, string> = {
  DRAFT: 'bg-gray-100 text-gray-700',
  SUBMITTED: 'bg-blue-100 text-blue-700',
  VERIFIED: 'bg-indigo-100 text-indigo-700',
  APPROVED: 'bg-purple-100 text-purple-700',
  POSTED: 'bg-green-100 text-green-700',
  REVERSED: 'bg-orange-100 text-orange-700',
};

const emptyLine = () => ({ account_id: '', description: '', debit_amount: '', credit_amount: '' });

export default function JournalEntriesPage() {
  const { user } = useAuth();
  const { hasPermission, role } = usePermissions();
  const [journals, setJournals] = useState<any[]>([]);
  const [accounts, setAccounts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [showLines, setShowLines] = useState<string | null>(null);
  const [showReasonModal, setShowReasonModal] = useState(false);
  const [pendingAction, setPendingAction] = useState<string>("");
  const [selectedJournal, setSelectedJournal] = useState<any>(null);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  // Form state
  const [formRef, setFormRef] = useState('');
  const [formDate, setFormDate] = useState(new Date().toISOString().split('T')[0]);
  const [formDesc, setFormDesc] = useState('');
  const [formLines, setFormLines] = useState([emptyLine(), emptyLine()]);
  const [formProjectId, setFormProjectId] = useState<string | null>(null);
  const [projects, setProjects] = useState<any[]>([]);

  const fetchJournals = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('finance.journal_entries')
      .select(`*, journal_lines:finance.journal_lines(*, chart_of_accounts:account_id(code, name))`)
      .order('created_at', { ascending: false })
      .limit(100);
    if (!error && data) setJournals(data);
    setLoading(false);
  }, []);

  const fetchAccounts = useCallback(async () => {
    const { data } = await supabase
      .from('finance.chart_of_accounts')
      .select('id, code, name, account_type, is_active, posting_allowed')
      .eq('is_active', true)
      .eq('posting_allowed', true)
      .order('code');
    if (data) setAccounts(data);
  }, []);

  const fetchProjects = useCallback(async () => {
    const { data } = await supabase.from('projects').select('id, name');
    if (data) setProjects(data);
  }, []);

  useEffect(() => { fetchJournals(); fetchAccounts(); fetchProjects(); }, [fetchJournals, fetchAccounts, fetchProjects]);

  const totalDebit = formLines.reduce((s, l) => s + (parseFloat(String(l.debit_amount)) || 0), 0);
  const totalCredit = formLines.reduce((s, l) => s + (parseFloat(String(l.credit_amount)) || 0), 0);
  const isBalanced = Math.abs(totalDebit - totalCredit) < 0.01;

  async function handleSubmit() {
    if (!formRef.trim() || !formDate || !formDesc.trim()) {
      toast.error('Reference, date and description are required.');
      return;
    }
    if (!isBalanced) {
      toast.error(`Debits (PKR ${totalDebit}) must equal Credits (PKR ${totalCredit}).`);
      return;
    }
    if (formLines.length < 2) {
      toast.error('At least 2 journal lines required.');
      return;
    }
    const validLines = formLines.filter(l => l.account_id && (parseFloat(String(l.debit_amount)) > 0 || parseFloat(String(l.credit_amount)) > 0));
    if (validLines.length < 2) {
      toast.error('At least 2 lines with account and amount required.');
      return;
    }

    setSaving(true);
    try {
      // Get open period
      const { data: period } = await supabase
        .from('finance.accounting_periods')
        .select('id')
        .eq('status', 'OPEN')
        .order('start_date', { ascending: false })
        .limit(1)
        .single();
      if (!period) { toast.error('No OPEN accounting period found.'); setSaving(false); return; }

      // Insert header
      const { data: journal, error: jErr } = await supabase.from('finance.journal_entries').insert({
        reference: formRef,
        description: formDesc,
        status: 'DRAFT',
        entry_date: formDate,
        period_id: period.id,
        project_id: formProjectId,
        total_debit: totalDebit,
        total_credit: totalCredit,
      }).select().single();
      if (jErr) throw jErr;

      // Insert lines
      const lines = validLines.map(l => ({
        journal_entry_id: journal.id,
        account_id: l.account_id,
        debit_amount: parseFloat(String(l.debit_amount)) || 0,
        credit_amount: parseFloat(String(l.credit_amount)) || 0,
        description: l.description,
      }));
      const { error: lErr } = await supabase.from('finance.journal_lines').insert(lines);
      if (lErr) {
        await supabase.from('finance.journal_entries').delete().eq('id', journal.id);
        throw lErr;
      }

      toast.success(`Journal ${formRef} created as DRAFT`);
      setShowForm(false);
      resetForm();
      fetchJournals();
    } catch (err: any) {
      toast.error('Error: ' + err.message);
    } finally {
      setSaving(false);
    }
  }

  function resetForm() {
    setFormRef(''); setFormDate(new Date().toISOString().split('T')[0]);
    setFormDesc(''); setFormLines([emptyLine(), emptyLine()]);
    setFormProjectId(null);
  }

  async function handleStatusAction(journalId: string, action: string, needsReason?: boolean) {
    const journal = journals.find(j => j.id === journalId);
    if (!journal) return;

    if (needsReason) {
      setSelectedJournal(journal);
      setPendingAction(action);
      setShowReasonModal(true);
      return;
    }

    // ALL actions through SERVER-SIDE WORKFLOW API
    try {
      if (action === 'post') {
        const result = await postJournal(journalId);
        if (result.success) {
          toast.success(result.message || 'Journal posted');
          fetchJournals();
        } else {
          toast.error(result.error || 'Posting failed');
        }
      } else {
        const result = await callWorkflow('journal_entry', journalId, action as any);
        if (result.success) {
          toast.success(result.message || `Journal ${action.toUpperCase()} successfully`);
          fetchJournals();
        } else {
          toast.error(result.error || 'Action failed');
        }
      }
    } catch (err: any) {
      toast.error('Error: ' + err.message);
    }
  }

  async function confirmReason() {
    if (!selectedJournal || !reason.trim()) return;
    try {
      if (pendingAction === 'reverse') {
        // Reverse still uses RPC for proper accounting
        const { error } = await supabase.rpc('finance.reverse_journal_entry', {
          p_journal_id: selectedJournal.id,
          p_reason: reason,
          p_reversed_by: user?.id,
        });
        if (error) throw error;
      } else {
        const result = await callWorkflow('journal_entry', selectedJournal.id, pendingAction as any, reason);
        if (!result.success) { toast.error(result.error || 'Action failed'); return; }
      }
      toast.success(`Journal ${pendingAction} successfully`);
      setShowReasonModal(false); setReason(''); fetchJournals();
    } catch (err: any) {
      toast.error('Error: ' + err.message);
    }
  }

  function formatCurrency(n: number) {
    return new Intl.NumberFormat('en-PK', { style: 'currency', currency: 'PKR', minimumFractionDigits: 0 }).format(n);
  }

  const canCreate = hasPermission('JOURNAL_CREATE');
  const canPost = hasPermission('JOURNAL_UPDATE');

  return (
    <div className="p-6">
      <div className="flex justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold text-gray-900 dark:text-white">Journal Entries</h2>
          <p className="text-sm text-gray-500">Create, verify, approve and post manual journals</p>
        </div>
        {canCreate && (
          <button onClick={() => setShowForm(true)} className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2.5 rounded-lg font-medium">
            <Plus size={18} /> New Journal
          </button>
        )}
      </div>

      {/* JOURNAL TABLE */}
      <div className="bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left">
            <thead className="bg-gray-50 dark:bg-gray-900/50 border-b dark:border-gray-700 text-xs uppercase text-gray-500">
              <tr>
                <th className="px-4 py-3">Reference</th>
                <th className="px-4 py-3">Date</th>
                <th className="px-4 py-3">Description</th>
                <th className="px-4 py-3 text-right">Debit</th>
                <th className="px-4 py-3 text-right">Credit</th>
                <th className="px-4 py-3 text-center">Status</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y dark:divide-gray-700">
              {loading ? <tr><td colSpan={7} className="p-8 text-center text-gray-400">Loading...</td></tr> :
               journals.length === 0 ? <tr><td colSpan={7} className="p-8 text-center text-gray-400">No journal entries</td></tr> :
               journals.map(j => (
                <tr key={j.id} className={`hover:bg-gray-50 dark:hover:bg-gray-700/30 ${j.status === 'REVERSED' ? 'opacity-50' : ''}`}>
                  <td className="px-4 py-3 font-mono text-xs text-blue-600">{j.reference}</td>
                  <td className="px-4 py-3 text-xs">{j.entry_date}</td>
                  <td className="px-4 py-3">{j.description}</td>
                  <td className="px-4 py-3 text-right font-semibold">{formatCurrency(j.total_debit)}</td>
                  <td className="px-4 py-3 text-right font-semibold">{formatCurrency(j.total_credit)}</td>
                  <td className="px-4 py-3 text-center">
                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${STATUS_STYLES[j.status] || ''}`}>{j.status}</span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-1">
                      {/* View lines */}
                      <button onClick={() => setShowLines(showLines === j.id ? null : j.id)} className="p-1.5 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700 rounded" title="View Lines">
                        <Eye size={14} />
                      </button>
                      {/* Status actions */}
                      {j.status === 'DRAFT' && hasPermission('JOURNAL_UPDATE') && (
                        <button onClick={() => handleStatusAction(j.id, 'submit')} className="p-1.5 text-blue-600 hover:bg-blue-50 rounded" title="Submit">
                          <CheckCircle size={14} />
                        </button>
                      )}
                      {j.status === 'SUBMITTED' && hasPermission('APPROVE_JOURNAL') && j.created_by !== user?.id && (
                        <button onClick={() => handleStatusAction(j.id, 'verify')} className="p-1.5 text-indigo-600 hover:bg-indigo-50 rounded" title="Verify">
                          <CheckCircle size={14} />
                        </button>
                      )}
                      {(j.status === 'VERIFIED' || j.status === 'APPROVED') && canPost && j.created_by !== user?.id && (
                        <button onClick={() => handleStatusAction(j.id, 'approve')} className="p-1.5 text-purple-600 hover:bg-purple-50 rounded" title="Approve">
                          <CheckCircle size={14} />
                        </button>
                      )}
                      {j.status === 'APPROVED' && canPost && (
                        <button onClick={() => handleStatusAction(j.id, 'post')} className="p-1.5 text-green-600 hover:bg-green-50 rounded font-medium" title="Post to GL">
                          <CheckCircle size={14} /> Post
                        </button>
                      )}
                      {j.status === 'POSTED' && hasPermission('JOURNAL_UPDATE') && (
                        <button onClick={() => handleStatusAction(j.id, 'reverse', true)} className="p-1.5 text-orange-600 hover:bg-orange-50 rounded" title="Reverse">
                          <RotateCcw size={14} />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* EXPANDABLE LINES */}
      {showLines && journals.find(j => j.id === showLines)?.journal_lines && (
        <div className="mt-4 bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-xl p-4">
          <h4 className="text-sm font-semibold mb-3">Journal Lines — {journals.find(j => j.id === showLines)?.reference}</h4>
          <table className="w-full text-sm">
            <thead className="text-xs text-gray-500 uppercase border-b dark:border-gray-700">
              <tr><th className="p-2 text-left">Account</th><th className="p-2">Description</th><th className="p-2 text-right">Debit</th><th className="p-2 text-right">Credit</th></tr>
            </thead>
            <tbody>
              {journals.find(j => j.id === showLines)!.journal_lines.map((l: any, i: number) => (
                <tr key={i} className="border-b dark:border-gray-700/50">
                  <td className="p-2 font-mono text-xs">{l.chart_of_accounts?.code} — {l.chart_of_accounts?.name}</td>
                  <td className="p-2 text-xs text-gray-600">{l.description}</td>
                  <td className="p-2 text-right font-semibold">{l.debit_amount > 0 ? formatCurrency(l.debit_amount) : '-'}</td>
                  <td className="p-2 text-right font-semibold">{l.credit_amount > 0 ? formatCurrency(l.credit_amount) : '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* CREATE JOURNAL FORM */}
      {showForm && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4 backdrop-blur-sm">
          <div className="bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-2xl w-full max-w-4xl shadow-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between p-5 border-b dark:border-gray-700">
              <h3 className="text-lg font-bold">New Journal Entry</h3>
              <button onClick={() => { setShowForm(false); resetForm(); }} className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500"><X size={18} /></button>
            </div>
            <div className="p-5 space-y-4">
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <label className="block text-sm font-medium mb-1">Reference *</label>
                  <input value={formRef} onChange={e => setFormRef(e.target.value)} placeholder="JE-MAN-00001" className="w-full p-2.5 border dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-sm" />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Date *</label>
                  <input type="date" value={formDate} onChange={e => setFormDate(e.target.value)} className="w-full p-2.5 border dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-sm" />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Project</label>
                  <select value={formProjectId || ''} onChange={e => setFormProjectId(e.target.value || null)} className="w-full p-2.5 border dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-sm">
                    <option value=''>None</option>
                    {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Description *</label>
                <input value={formDesc} onChange={e => setFormDesc(e.target.value)} placeholder="Journal description..." className="w-full p-2.5 border dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-sm" />
              </div>

              {/* Lines */}
              <div>
                <div className="flex justify-between items-center mb-2">
                  <label className="text-sm font-medium">Journal Lines *</label>
                  <button onClick={() => setFormLines([...formLines, emptyLine()])} className="text-xs text-blue-600 hover:underline">+ Add Line</button>
                </div>
                <table className="w-full text-sm">
                  <thead className="text-xs text-gray-500 uppercase border-b">
                    <tr><th className="p-2 text-left">Account</th><th className="p-2">Description</th><th className="p-2 text-right">Debit</th><th className="p-2 text-right">Credit</th><th></th></tr>
                  </thead>
                  <tbody>
                    {formLines.map((line, i) => (
                      <tr key={i}>
                        <td className="p-1">
                          <select value={line.account_id} onChange={e => {
                            const updated = [...formLines]; updated[i].account_id = e.target.value; setFormLines(updated);
                          }} className="w-full p-2 border dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-xs">
                            <option value=''>Select account</option>
                            {accounts.map(a => <option key={a.id} value={a.id}>{a.code} — {a.name}</option>)}
                          </select>
                        </td>
                        <td className="p-1">
                          <input value={line.description} onChange={e => {
                            const updated = [...formLines]; updated[i].description = e.target.value; setFormLines(updated);
                          }} className="w-full p-2 border dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-xs" />
                        </td>
                        <td className="p-1">
                          <input type="number" value={line.debit_amount} min="0" onChange={e => {
                            const updated = [...formLines]; updated[i].debit_amount = e.target.value; updated[i].credit_amount = '0'; setFormLines(updated);
                          }} className="w-full p-2 border dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-xs text-right" />
                        </td>
                        <td className="p-1">
                          <input type="number" value={line.credit_amount} min="0" onChange={e => {
                            const updated = [...formLines]; updated[i].credit_amount = e.target.value; updated[i].debit_amount = '0'; setFormLines(updated);
                          }} className="w-full p-2 border dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-xs text-right" />
                        </td>
                        <td className="p-1">
                          {formLines.length > 2 && (
                            <button onClick={() => setFormLines(formLines.filter((_, idx) => idx !== i))} className="p-1 text-red-500 hover:bg-red-50 rounded">
                              <X size={14} />
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2">
                      <td colSpan={2} className="p-2 text-right font-semibold text-sm">Totals:</td>
                      <td className={`p-2 text-right font-bold ${isBalanced ? 'text-green-600' : 'text-red-600'}`}>{formatCurrency(totalDebit)}</td>
                      <td className={`p-2 text-right font-bold ${isBalanced ? 'text-green-600' : 'text-red-600'}`}>{formatCurrency(totalCredit)}</td>
                      <td></td>
                    </tr>
                  </tfoot>
                </table>
                {!isBalanced && (
                  <div className="flex items-center gap-2 mt-2 text-red-600 text-xs">
                    <AlertTriangle size={14} /> Debits and Credits must be equal (balanced).
                  </div>
                )}
              </div>

              <div className="flex justify-end gap-3 pt-4 border-t dark:border-gray-700">
                <button onClick={() => { setShowForm(false); resetForm(); }} className="px-5 py-2.5 bg-gray-200 dark:bg-gray-700 rounded-xl text-sm font-medium">Cancel</button>
                <button onClick={handleSubmit} disabled={saving || !isBalanced} className="px-5 py-2.5 bg-blue-600 text-white rounded-xl text-sm font-medium disabled:opacity-50">
                  {saving ? 'Saving...' : 'Create as DRAFT'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <ReasonModal open={showReasonModal} title={`Confirm ${pendingAction}`} onConfirm={confirmReason} onCancel={() => setShowReasonModal(false)} />
    </div>
  );
}
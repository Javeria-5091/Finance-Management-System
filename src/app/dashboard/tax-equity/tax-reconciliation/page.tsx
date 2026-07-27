'use client';
import { useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import { usePermissions } from '@/hooks/usePermissions';
import { useTaxReconciliations, useTaxReconciliation, useTaxRuleSets, useCreateTaxReconciliation, useTaxAdjustments, useAddTaxAdjustment, useDeleteTaxAdjustment, useComputeTax, useUpdateTaxReconciliation, useFiscalYears, useExpenseAccounts } from '@/hooks/useTaxEquity';
import { Calculator, Plus, Trash2, Loader2, ArrowRight, FileText } from 'lucide-react';

const STATUS_STYLES: Record<string, string> = {
  DRAFT: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300',
  CALCULATED: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  UNDER_REVIEW: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400',
  ACCOUNTANT_APPROVED: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400',
  FILED: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  PAID: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
  AMENDED: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400',
  CLOSED: 'bg-gray-200 text-gray-500 dark:bg-gray-600 dark:text-gray-400',
};

const ADJ_CATEGORIES = [
  { value: 'ADD_BACK', label: 'Add Back (increases taxable income)' },
  { value: 'DEDUCTION', label: 'Deduction (decreases taxable income)' },
  { value: 'NON_DEDUCTIBLE', label: 'Non-Deductible Expense' },
  { value: 'EXEMPTION', label: 'Tax Exemption' },
  { value: 'DEPRECIATION_DIFF', label: 'Tax vs Book Depreciation Difference' },
  { value: 'PROVISION_ADJUST', label: 'Provision Adjustment' },
  { value: 'PRIVATE_EXPENSE', label: 'Private / Non-Business Expense' },
  { value: 'CAPITAL_VS_REVENUE', label: 'Capital vs Revenue Reclassification' },
  { value: 'LOSS_CARRY_FORWARD', label: 'Loss Carry Forward' },
  { value: 'OTHER', label: 'Other Adjustment' },
];

const formatCurrency = (n: number) => new Intl.NumberFormat('en-PK', { style: 'currency', currency: 'PKR', minimumFractionDigits: 0 }).format(n || 0);
const formatStatus = (s: string) => s?.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
const inputCls = 'w-full px-3 py-2.5 border dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm outline-none focus:ring-2 focus:ring-blue-500';
const labelCls = 'block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1';

export default function TaxReconciliationPage() {
  const { user } = useAuth();
  const { hasPermission, isLoading: permLoading } = usePermissions();
  const { data: reconciliations, isLoading: loadingList } = useTaxReconciliations();
  const { data: ruleSets } = useTaxRuleSets();
  const { data: fiscalYears } = useFiscalYears();
  const { data: expenseAccounts } = useExpenseAccounts();
  const createRecon = useCreateTaxReconciliation();
  const updateRecon = useUpdateTaxReconciliation();
  const computeTax = useComputeTax();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  // ✅ FIXED: Sab strings hain — input se string aata hai
  const [createForm, setCreateForm] = useState({
    tax_year: '',
    fiscal_year_id: '',
    tax_rule_set_id: '',
    withholding_credits: '',
    advance_tax_credits: '',
    other_tax_credits: '',
  });

  const { data: detail, isLoading: loadingDetail, refetch: refetchDetail } = useTaxReconciliation(selectedId || '');
  const { data: adjustments, isLoading: loadingAdj } = useTaxAdjustments(selectedId || '');
  const addAdj = useAddTaxAdjustment();
  const deleteAdj = useDeleteTaxAdjustment();

  const [adjForm, setAdjForm] = useState({
    adjustment_category: 'ADD_BACK',
    description: '',
    amount: '',
    source_account_id: '',
    evidence_notes: '',
  });

  if (permLoading || !hasPermission('TAX_READ')) return <div className="p-6 flex items-center justify-center min-h-[60vh]"><p className="text-gray-500 dark:text-gray-400">Access Denied</p></div>;

  // ✅ FIXED: Strings ko numbers mein convert kar rahe hain submission pe
  const handleCreate = () => {
    if (!createForm.tax_year || !createForm.fiscal_year_id || !createForm.tax_rule_set_id) {
      alert('All fields required');
      return;
    }
    createRecon.mutate(
      {
        tax_year: createForm.tax_year,
        fiscal_year_id: createForm.fiscal_year_id,
        tax_rule_set_id: createForm.tax_rule_set_id,
        withholding_credits: parseFloat(createForm.withholding_credits) || 0,
        advance_tax_credits: parseFloat(createForm.advance_tax_credits) || 0,
        other_tax_credits: parseFloat(createForm.other_tax_credits) || 0,
        created_by: user?.id,
      },
      {
        onSuccess: () => {
          setShowCreate(false);
          setCreateForm({
            tax_year: '',
            fiscal_year_id: '',
            tax_rule_set_id: '',
            withholding_credits: '',
            advance_tax_credits: '',
            other_tax_credits: '',
          });
        },
      }
    );
  };

  const handleAddAdj = () => {
    if (!selectedId || !adjForm.description || !adjForm.amount) {
      alert('Description and amount required');
      return;
    }
    addAdj.mutate(
      {
        tax_reconciliation_id: selectedId,
        adjustment_category: adjForm.adjustment_category,
        description: adjForm.description,
        amount: parseFloat(adjForm.amount),
        source_account_id: adjForm.source_account_id || null,
        evidence_notes: adjForm.evidence_notes || null,
        created_by: user?.id || '',
      },
      {
        onSuccess: () =>
          setAdjForm({
            adjustment_category: 'ADD_BACK',
            description: '',
            amount: '',
            source_account_id: '',
            evidence_notes: '',
          }),
      }
    );
  };

  const handleCompute = () => {
    if (!selectedId) return;
    computeTax.mutate(selectedId, { onSuccess: () => refetchDetail() });
  };

  const handleStatusChange = (status: string) => {
    if (!selectedId || !detail) return;
    const updates: any = { status };
    if (status === 'ACCOUNTANT_APPROVED') {
      updates.accountant_approved_by = user?.id;
      updates.approved_at = new Date().toISOString();
    }
    if (status === 'FILED') updates.filing_date = new Date().toISOString().split('T')[0];
    updateRecon.mutate({ id: selectedId, ...updates }, { onSuccess: () => refetchDetail() });
  };

  const totalAdj = adjustments?.reduce((sum, a) => sum + a.amount, 0) || 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
            <Calculator className="w-7 h-7 text-purple-600" /> Tax Reconciliation
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">Accounting PBT → Adjustments → Taxable Income → Net Tax</p>
        </div>
        {hasPermission('TAX_MANAGE') && (
          <button
            onClick={() => setShowCreate(true)}
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2.5 rounded-lg text-sm"
          >
            <Plus size={16} /> New Reconciliation
          </button>
        )}
      </div>

      <div className="flex gap-5 min-h-[calc(100vh-200px)]">
        {/* Left: List */}
        <div className="w-80 bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-xl overflow-hidden flex flex-col shrink-0">
          <div className="p-3 border-b dark:border-gray-700">
            <h3 className="text-xs font-bold uppercase text-gray-500 dark:text-gray-400">Tax Years</h3>
          </div>
          <div className="flex-1 overflow-y-auto">
            {loadingList ? (
              <div className="p-8 flex justify-center"><Loader2 className="w-5 h-5 animate-spin" /></div>
            ) : !reconciliations?.length ? (
              <div className="p-8 text-center text-gray-400 text-sm">No reconciliations</div>
            ) : (
              reconciliations.map((r) => (
                <div
                  key={r.id}
                  onClick={() => setSelectedId(r.id)}
                  className={`p-3 border-b dark:border-gray-700 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors ${
                    selectedId === r.id ? 'bg-blue-50 dark:bg-blue-900/20 border-l-4 border-l-blue-500' : ''
                  }`}
                >
                  <div className="flex justify-between items-center">
                    <span className="text-sm font-medium text-gray-900 dark:text-white">{r.tax_year}</span>
                    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${STATUS_STYLES[r.status] || ''}`}>
                      {formatStatus(r.status)}
                    </span>
                  </div>
                  <div className="flex justify-between text-xs text-gray-500 mt-1">
                    <span>PBT: {formatCurrency(r.accounting_profit_before_tax)}</span>
                    <span>Net Tax: {formatCurrency(r.net_tax_payable)}</span>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Right: Detail */}
        <div className="flex-1 min-w-0 space-y-4 overflow-y-auto">
          {!selectedId && (
            <div className="flex items-center justify-center h-full text-gray-400">
              <div className="text-center">
                <FileText className="w-16 h-16 mx-auto mb-4 opacity-20" />
                <p className="text-lg font-medium">Select a tax year</p>
              </div>
            </div>
          )}

          {selectedId && loadingDetail && (
            <div className="flex justify-center py-16"><Loader2 className="w-8 h-8 animate-spin" /></div>
          )}

          {selectedId && detail && (
            <>
              {/* Section 1: PBT */}
              <div className="bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-xl p-5">
                <h3 className="text-sm font-bold text-gray-900 dark:text-white mb-3">Section 1: Accounting Profit Before Tax (from GL)</h3>
                <div className="bg-gray-50 dark:bg-gray-900/50 rounded-lg p-4 flex justify-between items-center">
                  <span className="text-sm text-gray-600 dark:text-gray-400">Accounting PBT for {detail.tax_year}</span>
                  <span className="text-2xl font-bold text-gray-900 dark:text-white">{formatCurrency(detail.accounting_profit_before_tax)}</span>
                </div>
                <p className="text-[10px] text-gray-400 mt-2">This value is pulled directly from the General Ledger P&L. It is not editable here.</p>
              </div>

              {/* Section 2: Adjustments */}
              <div className="bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-xl p-5">
                <h3 className="text-sm font-bold text-gray-900 dark:text-white mb-3">Section 2: Tax Adjustments</h3>
                <div className="overflow-x-auto mb-4">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 dark:bg-gray-900/50 text-xs uppercase text-gray-500">
                      <tr>
                        <th className="px-3 py-2 text-left">Category</th>
                        <th className="px-3 py-2 text-left">Description</th>
                        <th className="px-3 py-2 text-right">Amount</th>
                        <th className="px-3 py-2 w-10"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y dark:divide-gray-700">
                      {loadingAdj && (
                        <tr>
                          <td colSpan={4} className="px-3 py-4 text-center">
                            <Loader2 className="w-4 h-4 animate-spin mx-auto" />
                          </td>
                        </tr>
                      )}
                      {adjustments?.map((adj) => (
                        <tr key={adj.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/30">
                          <td className="px-3 py-2">
                            <span className="text-xs bg-gray-100 dark:bg-gray-700 px-2 py-0.5 rounded">{adj.adjustment_category.replace(/_/g, ' ')}</span>
                          </td>
                          <td className="px-3 py-2 text-gray-900 dark:text-white">{adj.description}</td>
                          <td className={`px-3 py-2 text-right font-semibold ${adj.amount >= 0 ? 'text-red-600 dark:text-red-400' : 'text-green-600 dark:text-green-400'}`}>
                            {adj.amount >= 0 ? '+' : ''}{formatCurrency(adj.amount)}
                          </td>
                          <td className="px-3 py-2">
                            {hasPermission('TAX_MANAGE') && detail.status === 'DRAFT' && (
                              <button onClick={() => deleteAdj.mutate(adj.id)} className="p-1 text-red-400 hover:text-red-600">
                                <Trash2 size={14} />
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                      {adjustments?.length === 0 && !loadingAdj && (
                        <tr>
                          <td colSpan={4} className="px-3 py-6 text-center text-gray-400 text-sm">No adjustments added</td>
                        </tr>
                      )}
                    </tbody>
                    <tfoot className="border-t dark:border-gray-700">
                      <tr>
                        <td colSpan={2} className="px-3 py-2 text-sm font-bold text-gray-900 dark:text-white">Net Adjustment</td>
                        <td className={`px-3 py-2 text-right font-bold ${totalAdj >= 0 ? 'text-red-600' : 'text-green-600'}`}>
                          {totalAdj >= 0 ? '+' : ''}{formatCurrency(totalAdj)}
                        </td>
                        <td></td>
                      </tr>
                    </tfoot>
                  </table>
                </div>

                {/* Add Adjustment Form */}
                {hasPermission('TAX_MANAGE') && detail.status === 'DRAFT' && (
                  <div className="border dark:border-gray-700 rounded-lg p-4 space-y-3">
                    <h4 className="text-xs font-bold text-gray-500 uppercase">Add Adjustment</h4>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                      <div>
                        <label className="text-[10px] text-gray-400">Category</label>
                        <select value={adjForm.adjustment_category} onChange={e => setAdjForm(p => ({ ...p, adjustment_category: e.target.value }))} className={inputCls}>
                          {ADJ_CATEGORIES.map(c => (
                            <option key={c.value} value={c.value}>{c.label}</option>
                          ))}
                        </select>
                      </div>
                      <div className="col-span-1">
                        <label className="text-[10px] text-gray-400">Amount (+/-)</label>
                        <input type="number" step="0.01" value={adjForm.amount} onChange={e => setAdjForm(p => ({ ...p, amount: e.target.value }))} className={inputCls} placeholder="+50000 or -30000" />
                      </div>
                      <div>
                        <label className="text-[10px] text-gray-400">Source Account</label>
                        <select value={adjForm.source_account_id} onChange={e => setAdjForm(p => ({ ...p, source_account_id: e.target.value }))} className={inputCls}>
                          <option value="">Optional</option>
                          {expenseAccounts?.map((a: any) => (
                            <option key={a.id} value={a.id}>{a.code} - {a.name}</option>
                          ))}
                        </select>
                      </div>
                      <div className="flex items-end">
                        <button onClick={handleAddAdj} disabled={addAdj.isPending} className="w-full px-3 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm disabled:opacity-50 flex items-center justify-center gap-1">
                          {addAdj.isPending && <Loader2 size={14} className="animate-spin" />} Add
                        </button>
                      </div>
                    </div>
                    <div>
                      <label className="text-[10px] text-gray-400">Description</label>
                      <input value={adjForm.description} onChange={e => setAdjForm(p => ({ ...p, description: e.target.value }))} className={inputCls} placeholder="Reason for this adjustment..." />
                    </div>
                  </div>
                )}
              </div>

              {/* Section 3: Calculation Summary */}
              <div className="bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-xl p-5">
                <div className="flex justify-between items-center mb-4">
                  <h3 className="text-sm font-bold text-gray-900 dark:text-white">Section 3: Tax Calculation Summary</h3>
                  {hasPermission('TAX_MANAGE') && ['DRAFT', 'CALCULATED'].includes(detail.status) && (
                    <button onClick={handleCompute} disabled={computeTax.isPending} className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg text-sm disabled:opacity-50">
                      {computeTax.isPending && <Loader2 size={14} className="animate-spin" />} Recalculate Tax
                    </button>
                  )}
                </div>
                <div className="space-y-2">
                  {[
                    { label: 'Accounting PBT', value: detail.accounting_profit_before_tax, bold: false },
                    { label: 'Net Tax Adjustments', value: totalAdj, bold: false, color: totalAdj >= 0 ? 'text-red-600' : 'text-green-600' },
                    { label: '', value: null, divider: true },
                    { label: 'Taxable Income', value: detail.taxable_income, bold: true },
                    { label: 'Gross Tax Liability (from slabs)', value: detail.gross_tax_liability, indent: true },
                    { label: 'Less: Withholding Credits', value: -detail.withholding_credits, indent: true },
                    { label: 'Less: Advance Tax Credits', value: -detail.advance_tax_credits, indent: true },
                    { label: 'Less: Other Tax Credits', value: -detail.other_tax_credits, indent: true },
                    { label: '', value: null, divider: true },
                    { label: 'Net Tax Payable / (Refundable)', value: detail.net_tax_payable, bold: true, color: detail.net_tax_payable > 0 ? 'text-red-600' : 'text-green-600' },
                    { label: 'Profit After Tax', value: detail.profit_after_tax, bold: true, color: 'text-blue-600' },
                    { label: 'Effective Tax Rate', value: null, rate: detail.effective_tax_rate, bold: false },
                  ].map((row, i) =>
                    row.divider ? (
                      <div key={i} className="border-t dark:border-gray-700 my-1" />
                    ) : (
                      <div key={i} className={`flex justify-between items-center ${row.indent ? 'pl-6' : ''}`}>
                        <span className={`text-sm ${row.bold ? 'font-bold text-gray-900 dark:text-white' : 'text-gray-600 dark:text-gray-400'}`}>{row.label}</span>
                        <span className={`text-sm ${row.bold ? 'font-bold' : 'font-medium'} ${row.color || 'text-gray-900 dark:text-white'}`}>
                          {row.rate != null ? `${row.rate}%` : formatCurrency(row.value || 0)}
                        </span>
                      </div>
                    )
                  )}
                </div>
                {detail.tax_rule_sets && (
                  <p className="text-[10px] text-gray-400 mt-3">Rule Set: {detail.tax_rule_sets.name}</p>
                )}
              </div>

              {/* Actions */}
              <div className="bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-xl p-5">
                <h3 className="text-sm font-bold text-gray-900 dark:text-white mb-3">Actions</h3>
                <div className="flex flex-wrap gap-2">
                  {detail.status === 'CALCULATED' && hasPermission('TAX_APPROVE') && (
                    <button onClick={() => handleStatusChange('UNDER_REVIEW')} className="px-4 py-2 bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-400 rounded-lg text-sm font-medium hover:bg-yellow-200">Send for Review</button>
                  )}
                  {detail.status === 'UNDER_REVIEW' && hasPermission('TAX_APPROVE') && (
                    <button onClick={() => handleStatusChange('ACCOUNTANT_APPROVED')} className="px-4 py-2 bg-indigo-100 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-400 rounded-lg text-sm font-medium hover:bg-indigo-200">Accountant Approve</button>
                  )}
                  {detail.status === 'ACCOUNTANT_APPROVED' && hasPermission('TAX_APPROVE') && (
                    <button onClick={() => handleStatusChange('FILED')} className="px-4 py-2 bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 rounded-lg text-sm font-medium hover:bg-green-200">Mark as Filed</button>
                  )}
                  {detail.status === 'FILED' && hasPermission('TAX_APPROVE') && (
                    <button onClick={() => handleStatusChange('PAID')} className="px-4 py-2 bg-emerald-600 text-white rounded-lg text-sm font-medium hover:bg-emerald-700">Mark as Paid</button>
                  )}
                  {['DRAFT', 'CALCULATED', 'UNDER_REVIEW'].includes(detail.status) && hasPermission('TAX_MANAGE') && (
                    <button onClick={() => handleStatusChange('DRAFT')} className="px-4 py-2 bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-lg text-sm">Recalculate</button>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Create Modal */}
      {showCreate && (
        <div
          className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4"
          onClick={e => { if (e.target === e.currentTarget) setShowCreate(false); }}
        >
          <div className="bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-2xl w-full max-w-md shadow-2xl p-5 space-y-4">
            <h2 className="text-lg font-bold text-gray-900 dark:text-white">New Tax Reconciliation</h2>
            <div>
              <label className={labelCls}>Tax Year *</label>
              <input value={createForm.tax_year} onChange={e => setCreateForm(p => ({ ...p, tax_year: e.target.value }))} className={inputCls} placeholder="2024-25" />
            </div>
            <div>
              <label className={labelCls}>Fiscal Year *</label>
              <select value={createForm.fiscal_year_id} onChange={e => setCreateForm(p => ({ ...p, fiscal_year_id: e.target.value }))} className={inputCls}>
                <option value="">Select...</option>
                {fiscalYears?.map((fy: any) => (
                  <option key={fy.name} value={fy.name}>{fy.year_label || fy.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelCls}>Tax Rule Set *</label>
              <select value={createForm.tax_rule_set_id} onChange={e => setCreateForm(p => ({ ...p, tax_rule_set_id: e.target.value }))} className={inputCls}>
                <option value="">Select LOCKED/APPROVED rule set...</option>
                {ruleSets?.filter(r => ['APPROVED', 'LOCKED'].includes(r.status)).map(r => (
                  <option key={r.id} value={r.id}>{r.name} ({r.status})</option>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className={labelCls}>WHT Credits</label>
                <input type="number" value={createForm.withholding_credits} onChange={e => setCreateForm(p => ({ ...p, withholding_credits: e.target.value }))} className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>Advance Tax</label>
                <input type="number" value={createForm.advance_tax_credits} onChange={e => setCreateForm(p => ({ ...p, advance_tax_credits: e.target.value }))} className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>Other Credits</label>
                <input type="number" value={createForm.other_tax_credits} onChange={e => setCreateForm(p => ({ ...p, other_tax_credits: e.target.value }))} className={inputCls} />
              </div>
            </div>
            <div className="flex justify-end gap-3 pt-2">
              <button onClick={() => setShowCreate(false)} className="px-4 py-2.5 bg-gray-200 dark:bg-gray-700 text-gray-800 dark:text-white rounded-xl text-sm">Cancel</button>
              <button
                onClick={handleCreate}
                disabled={createRecon.isPending || !createForm.tax_year || !createForm.fiscal_year_id}
                className="px-4 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-sm disabled:opacity-50 flex items-center gap-2"
              >
                {createRecon.isPending && <Loader2 size={14} className="animate-spin" />} Create
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
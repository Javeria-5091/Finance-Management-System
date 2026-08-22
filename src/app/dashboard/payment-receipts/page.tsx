"use client";
 
import { useState, useEffect } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/context/AuthContext";
import { usePermissions } from "@/context/PermissionContext";
import { Plus, CheckCircle, Split, Search, ChevronDown } from "lucide-react";
 
interface ClientOption {
  id: string;
  name: string;
  email: string;
}
 
export default function PaymentReceiptsPage() {
  const { user } = useAuth();
  const { hasPermission, isLoading: permissionsLoading } = usePermissions();
  const [receipts, setReceipts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [financialAccountId, setFinancialAccountId] = useState("");
  
  const [invoices, setInvoices] = useState<any[]>([]);
  const [allocations, setAllocations] = useState<Record<string, number>>({});
  
  // Client dropdown state
  const [clients, setClients] = useState<ClientOption[]>([]);
  const [clientSearch, setClientSearch] = useState("");
  const [showClientDropdown, setShowClientDropdown] = useState(false);
  const [selectedClientName, setSelectedClientName] = useState("");
  
  // Form State
  const [form, setForm] = useState({
    amount: "", 
    client_id: "", 
    payment_method: "BANK_TRANSFER", 
    reference: "", 
    description: "",
    payment_date: new Date().toISOString().split("T")[0]
  });
 
  const totalAllocated = Object.values(allocations).reduce((sum, val) => sum + val, 0);
  const unallocated = parseFloat(form.amount || "0") - totalAllocated;
  const isBalanced = unallocated === 0 && totalAllocated > 0;
 
  useEffect(() => {
    fetchReceipts();
  }, []);
 
  const fetchReceipts = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/finance/payment-receipts?page=1&pageSize=100', { credentials: 'include' });
      const result = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(result.error || 'Failed to load payment receipts');
      setReceipts(result.data || []);
    } catch (e: any) {
      console.error(e);
    } finally { setLoading(false); }
  };

  const fetchClients = async () => {
    const { data } = await supabase
      .from("clients")
      .select("id, name, email")
      .eq("status", "ACTIVE")
      .order("name");
    if (data) setClients(data as ClientOption[]);
  };
 
  const filteredClients = clients.filter((cl) =>
    cl.name.toLowerCase().includes(clientSearch.toLowerCase()) ||
    cl.email.toLowerCase().includes(clientSearch.toLowerCase())
  );
 
  const selectClient = (client: ClientOption) => {
    setForm((prev) => ({ ...prev, client_id: client.id }));
    setSelectedClientName(client.name);
    setShowClientDropdown(false);
    setClientSearch("");
  };
 
  const openCreateModal = async () => {
    await fetchClients();
    const { data: financialAccounts } = await supabase
      .schema("finance")
      .from("financial_accounts")
      .select("id, currency, is_active, is_default")
      .eq("is_active", true)
      .order("is_default", { ascending: false })
      .limit(1);
    setFinancialAccountId(financialAccounts?.[0]?.id || "");
    const { data: invData } = await supabase
      .from("invoices")
      .select("*")
      .in("status", ["ISSUED", "PARTIALLY_PAID"])
      .gt("outstanding_amount", 0)
      .order("due_date", { ascending: true });
    
    if (invData) setInvoices(invData);
    setAllocations({});
    setForm({ 
      amount: "", 
      client_id: "", 
      payment_method: "BANK_TRANSFER", 
      reference: "", 
      description: "",
      payment_date: new Date().toISOString().split("T")[0]
    });
    setSelectedClientName("");
    setClientSearch("");
    setShowModal(true);
  };
 
  const handleAllocate = (invId: string, amount: string) => {
    const val = parseFloat(amount) || 0;
    setAllocations(prev => {
      const next = { ...prev };
      if (val > 0) next[invId] = val;
      else delete next[invId];
      return next;
    });
  };
 
  const handleSubmit = async () => {
    if (!isBalanced || !form.amount) return alert("Pura amount invoices ke against allocate karna zaroori hai.");
    if (!form.client_id) return alert("Client select karna zaroori hai.");
    if (!financialAccountId) return alert("Active bank/cash account configure karna zaroori hai.");

    setSaving(true);
    try {
      const response = await fetch('/api/finance/payment-receipts', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: form.client_id,
          amount: Number(form.amount),
          currency: 'PKR',
          exchange_rate: 1,
          received_date: form.payment_date,
          payment_method: form.payment_method,
          reference: form.reference || undefined,
          financial_account_id: financialAccountId,
          notes: form.description || undefined,
          allocations: Object.entries(allocations).map(([invoice_id, amount]) => ({ invoice_id, amount: Number(amount) })),
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'Payment receipt could not be posted');

      alert(result.message || 'Payment Received & Allocated Successfully!');
      setShowModal(false);
      fetchReceipts();
    } catch (error: any) {
      console.error("Payment Error:", error);
      alert("Error: " + error.message);
    } finally {
      setSaving(false);
    }
  };

  if (permissionsLoading || !hasPermission("PAYMENT_RECEIPT_READ")) return <div className="p-6">Access Denied</div>;

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Payment Receipts</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">Receive payments and allocate against invoices</p>
        </div>
        <button disabled={!hasPermission("PAYMENT_RECEIPT_CREATE")} onClick={openCreateModal} className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2.5 rounded-lg text-sm font-medium">
          <Plus size={16} /> Record Payment
        </button>
      </div>
 
      {/* Receipts List */}
      <div className="bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 dark:bg-gray-900/50 border-b dark:border-gray-700 text-left text-xs uppercase text-gray-500">
            <tr>
              <th className="p-3">Receipt #</th>
              <th className="p-3">Date</th>
              <th className="p-3 text-right">Amount</th>
              <th className="p-3">Method</th>
              <th className="p-3 text-center">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y dark:divide-gray-700">
            {loading ? (
              <tr><td colSpan={5} className="text-center py-8 text-gray-400">Loading...</td></tr>
            ) : receipts.length === 0 ? (
              <tr><td colSpan={5} className="text-center py-8 text-gray-400">No receipts yet</td></tr>
            ) : (
              receipts.map((r) => (
                <tr key={r.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/30">
                  <td className="p-3 font-mono text-xs">{r.receipt_number || r.id.slice(0, 8)}</td>
                  <td className="p-3 text-gray-600 dark:text-gray-300">
                    {r.payment_date ? new Date(r.payment_date).toLocaleDateString() : 'N/A'}
                  </td>
                  <td className="p-3 text-right font-semibold text-green-600 dark:text-green-400">
                    {parseFloat(r.amount).toLocaleString()}
                  </td>
                  <td className="p-3 text-gray-500 text-xs">{r.payment_method}</td>
                  <td className="p-3 text-center">
                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                      r.status === "POSTED" 
                        ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400" 
                        : "bg-gray-100 text-gray-700 dark:bg-gray-700"
                    }`}>
                      {r.status}
                    </span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
 
      {/* Allocation Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-xl w-full max-w-3xl shadow-xl max-h-[90vh] overflow-y-auto">
            
            <div className="p-5 border-b dark:border-gray-700">
              <div className="flex items-center gap-2">
                <Split className="w-5 h-5 text-blue-600" />
                <h2 className="text-lg font-bold text-gray-900 dark:text-white">Allocate Payment</h2>
              </div>
            </div>
            
            <div className="p-5 space-y-4">
              <div className="grid grid-cols-2 gap-4 bg-gray-50 dark:bg-gray-900/30 p-4 rounded-lg">
 
                {/* CLIENT SELECTOR DROPDOWN (replaces raw UUID input) */}
                <div className="relative col-span-2">
                  <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Client *</label>
                  {selectedClientName ? (
                    <div className="flex items-center justify-between w-full p-2 border dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm">
                      <span>{selectedClientName}</span>
                      <button
                        type="button"
                        onClick={() => { setForm((p) => ({ ...p, client_id: '' })); setSelectedClientName(''); }}
                        className="text-gray-400 hover:text-red-500 text-xs ml-2"
                      >
                        Clear
                      </button>
                    </div>
                  ) : (
                    <div className="relative">
                      <div className="flex items-center gap-2 w-full p-2 border dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-sm">
                        <Search size={14} className="text-gray-400 flex-shrink-0" />
                        <input
                          type="text"
                          value={clientSearch}
                          onChange={(e) => { setClientSearch(e.target.value); setShowClientDropdown(true); }}
                          onFocus={() => setShowClientDropdown(true)}
                          className="flex-1 bg-transparent text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none"
                          placeholder="Search client by name or email..."
                        />
                        <ChevronDown size={14} className="text-gray-400 flex-shrink-0" />
                      </div>
                      {showClientDropdown && filteredClients.length > 0 && (
                        <div className="absolute z-20 mt-1 w-full max-h-48 overflow-y-auto bg-white dark:bg-gray-700 border dark:border-gray-600 rounded-lg shadow-lg">
                          {filteredClients.map((cl) => (
                            <button
                              key={cl.id}
                              type="button"
                              onClick={() => selectClient(cl)}
                              className="w-full text-left px-3 py-2 text-sm text-gray-900 dark:text-white hover:bg-blue-50 dark:hover:bg-blue-900/30 transition-colors"
                            >
                              <span className="font-medium">{cl.name}</span>
                              <span className="text-gray-400 text-xs ml-2">{cl.email}</span>
                            </button>
                          ))}
                        </div>
                      )}
                      {showClientDropdown && clientSearch && filteredClients.length === 0 && (
                        <div className="absolute z-20 mt-1 w-full p-3 bg-white dark:bg-gray-700 border dark:border-gray-600 rounded-lg shadow-lg text-sm text-gray-500 text-center">
                          No clients found
                        </div>
                      )}
                    </div>
                  )}
                </div>
 
                <div>
                  <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Payment Date *</label>
                  <input 
                    type="date" 
                    value={form.payment_date} 
                    onChange={(e) => setForm({ ...form, payment_date: e.target.value })} 
                    className="w-full p-2 border dark:border-gray-600 rounded bg-transparent dark:bg-gray-700 text-gray-900 dark:text-white text-sm" 
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Total Amount Received (PKR) *</label>
                  <input 
                    type="number" 
                    value={form.amount} 
                    onChange={(e) => setForm({ ...form, amount: e.target.value })} 
                    className="w-full p-2 border dark:border-gray-600 rounded bg-transparent dark:bg-gray-700 text-gray-900 dark:text-white text-sm" 
                    placeholder="0.00" 
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Payment Method</label>
                  <select 
                    value={form.payment_method} 
                    onChange={(e) => setForm({ ...form, payment_method: e.target.value })} 
                    className="w-full p-2 border dark:border-gray-600 rounded bg-transparent dark:bg-gray-700 text-gray-900 dark:text-white text-sm"
                  >
                    <option value="BANK_TRANSFER">Bank Transfer</option>
                    <option value="PLATFORM">Platform (Freelancer/Wise)</option>
                    <option value="CASH">Cash</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Reference / Cheque No</label>
                  <input 
                    type="text" 
                    value={form.reference} 
                    onChange={(e) => setForm({ ...form, reference: e.target.value })} 
                    className="w-full p-2 border dark:border-gray-600 rounded bg-transparent dark:bg-gray-700 text-gray-900 dark:text-white text-sm" 
                    placeholder="Optional" 
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Description</label>
                  <input 
                    type="text" 
                    value={form.description} 
                    onChange={(e) => setForm({ ...form, description: e.target.value })} 
                    className="w-full p-2 border dark:border-gray-600 rounded bg-transparent dark:bg-gray-700 text-gray-900 dark:text-white text-sm" 
                    placeholder="Optional" 
                  />
                </div>
              </div>
 
              {/* Unallocated Amount Banner */}
              <div className={`p-3 rounded-lg border-2 flex justify-between items-center ${
                isBalanced 
                  ? "bg-green-50 border-green-200 text-green-700 dark:bg-green-900/20 dark:text-green-400" 
                  : "bg-red-50 border-red-200 text-red-700 dark:bg-red-900/20 dark:text-red-400"
              }`}>
                <span className="text-sm font-medium">Unallocated:</span>
                <span className="text-lg font-bold">
                  {unallocated.toLocaleString()} {unallocated < 0 ? "(Over-allocated!)" : ""}
                </span>
              </div>
 
              {/* Invoice Allocation List */}
              <div className="space-y-2">
                <h3 className="text-sm font-bold text-gray-700 dark:text-gray-300">
                  Allocate against Outstanding Invoices:
                </h3>
                {invoices.length === 0 ? (
                  <p className="text-sm text-gray-400 bg-gray-50 dark:bg-gray-800 p-4 rounded-lg text-center">
                    No outstanding invoices found.
                  </p>
                ) : (
                  invoices.map((inv) => (
                    <div key={inv.id} className="flex items-center gap-4 p-3 border dark:border-gray-700 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700/30">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-gray-900 dark:text-white truncate">
                          {inv.invoice_number || "No Number"}
                        </p>
                        <p className="text-xs text-gray-500 dark:text-gray-400">
                          Outstanding: <span className="font-bold text-red-500">{parseFloat(inv.outstanding_amount).toLocaleString()}</span>
                        </p>
                      </div>
                      <input 
                        type="number" 
                        placeholder="0" 
                        value={allocations[inv.id] || ""} 
                        onChange={(e) => handleAllocate(inv.id, e.target.value)}
                        className="w-32 p-2 border dark:border-gray-600 rounded bg-transparent dark:bg-gray-700 text-gray-900 dark:text-white text-sm text-right"
                        max={parseFloat(inv.outstanding_amount)}
                      />
                    </div>
                  ))
                )}
              </div>
            </div>
 
            <div className="flex justify-end gap-3 p-5 border-t dark:border-gray-700">
              <button 
                onClick={() => setShowModal(false)} 
                className="px-4 py-2 bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-800 dark:text-white rounded-lg text-sm"
              >
                Cancel
              </button>
              <button 
                onClick={handleSubmit} 
                disabled={!isBalanced || saving} 
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {saving ? "Processing..." : <><CheckCircle size={16} /> Post Payment</>}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

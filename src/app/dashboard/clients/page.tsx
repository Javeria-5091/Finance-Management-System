"use client";
import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/context/AuthContext";
import { usePermissions } from "@/context/PermissionContext";
import {
  Plus, Search, Edit2, Trash2, Building2, Phone, Mail, X,
  Eye, FileText, FolderKanban, TrendingUp, Users, Filter
} from "lucide-react";
import toast from "react-hot-toast";
import { logAction } from "@/lib/logAction";

// ═══════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════
interface Client {
  id: string;
  name: string;
  contact_person: string;
  email: string;
  phone: string;
  address: string;
  city: string;
  country: string;
  tax_id: string;
  status: string;
  user_id: string;
  created_at: string;
}

interface ClientInvoice {
  id: string;
  invoice_number: string;
  total_amount: number;
  amount_paid: number;
  outstanding_amount: number;
  status: string;
  due_date: string;
  issue_date: string;
}

interface ClientProject {
  id: string;
  name: string;
  status: string;
  start_date: string;
}

interface ClientDetail {
  client: Client;
  invoices: ClientInvoice[];
  projects: ClientProject[];
}

const emptyClient = {
  name: "", contact_person: "", email: "", phone: "",
  address: "", city: "", country: "Pakistan", tax_id: "", status: "ACTIVE",
};

const inputCls = "w-full px-3 py-2.5 bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-lg text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors";
const labelCls = "block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1";

// ═══════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════
export default function ClientsPage() {
  const { user } = useAuth();
  const { hasPermission } = usePermissions();
  const canCreate = hasPermission("CLIENT_CREATE");
  const canEdit = hasPermission("CLIENT_UPDATE");
  const canDelete = hasPermission("CLIENT_DELETE");

  const [clients, setClients] = useState<Client[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("ALL");
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Client | null>(null);
  const [form, setForm] = useState(emptyClient);
  const [saving, setSaving] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  // Detail Panel State
  const [selectedClient, setSelectedClient] = useState<ClientDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // ─── FETCH ───
  const fetchClients = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    const { data, error } = await supabase.from("clients").select("*").order("name");
    if (error) toast.error("Failed to load clients: " + error.message);
    else setClients(data || []);
    setLoading(false);
  }, [user]);

  useEffect(() => { fetchClients(); }, [fetchClients]);

  // ─── DERIVED ───
  const filtered = clients.filter((c) => {
    const matchSearch = c.name.toLowerCase().includes(search.toLowerCase()) ||
      (c.email || "").toLowerCase().includes(search.toLowerCase()) ||
      (c.contact_person || "").toLowerCase().includes(search.toLowerCase()) ||
      (c.phone || "").includes(search) ||
      (c.tax_id || "").toLowerCase().includes(search.toLowerCase());
    const matchStatus = statusFilter === "ALL" || c.status === statusFilter;
    return matchSearch && matchStatus;
  });

  const activeCount = clients.filter((c) => c.status === "ACTIVE").length;
  const inactiveCount = clients.filter((c) => c.status === "INACTIVE").length;

  function formatCurrency(amount: number) {
    return new Intl.NumberFormat("en-PK", { style: "currency", currency: "PKR", minimumFractionDigits: 0 }).format(amount || 0);
  }

  // ─── FORM HANDLERS ───
  function openNew() { setEditing(null); setForm(emptyClient); setShowForm(true); }

  function openEdit(client: Client) {
    setEditing(client);
    setForm({
      name: client.name, contact_person: client.contact_person || "",
      email: client.email || "", phone: client.phone || "",
      address: client.address || "", city: client.city || "",
      country: client.country || "Pakistan", tax_id: client.tax_id || "",
      status: client.status || "ACTIVE",
    });
    setShowForm(true);
  }

  async function handleSave() {
    if (!form.name.trim()) { toast.error("Client name is required"); return; }
    if (form.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) { toast.error("Invalid email format"); return; }
    setSaving(true);
    if (editing) {
      const { error } = await supabase.from("clients").update({ ...form, updated_at: new Date().toISOString() }).eq("id", editing.id);
      if (error) toast.error("Update failed: " + error.message);
      else { toast.success("Client updated"); logAction({ action: "UPDATE", entityType: "clients", entityId: editing.id, description: "..." }) }
    } else {
      const { error } = await supabase.from("clients").insert({ ...form, user_id: user?.id });
      if (error) toast.error("Create failed: " + error.message);
      else { toast.success("Client created"); logAction({ action: "CREATE", entityType: "clients", description: "..." })}
    }
    setSaving(false); setShowForm(false); fetchClients();
  }

  async function handleDelete() {
    if (!deleteId) return;
    const { error } = await supabase.from("clients").delete().eq("id", deleteId);
    if (error) toast.error("Delete failed: " + error.message);
    else { toast.success("Client deleted"); logAction({ action: "DELETE", entityType: "clients", entityId: deleteId, description: "..." }); setDeleteId(null); fetchClients(); }
  }

  // ─── CLIENT DETAIL ───
  async function openDetail(client: Client) {
    setSelectedClient(null);
    setDetailLoading(true);

    const [invRes, projRes] = await Promise.all([
      supabase.from("invoices").select("id, invoice_number, total_amount, amount_paid, outstanding_amount, status, due_date, issue_date").eq("client_name", client.name),
      supabase.from("projects").select("id, name, status, start_date").eq("client_name", client.name),
    ]);

    setSelectedClient({
      client,
      invoices: invRes.data || [],
      projects: projRes.data || [],
    });
    setDetailLoading(false);
  }

  const detailTotalInvoiced = selectedClient?.invoices.reduce((s, i) => s + (i.total_amount || 0), 0) || 0;
  const detailTotalPaid = selectedClient?.invoices.reduce((s, i) => s + (i.amount_paid || 0), 0) || 0;
  const detailTotalOutstanding = selectedClient?.invoices.reduce((s, i) => s + (i.outstanding_amount || 0), 0) || 0;

  return (
    <div className="flex gap-6">
      {/* ═══════════ MAIN CONTENT ═══════════ */}
      <div className={`flex-1 min-w-0 ${selectedClient ? 'hidden lg:block' : ''}`}>
        {/* Header */}
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 mb-6">
          <div>
            <h2 className="text-2xl font-bold text-gray-900 dark:text-white">Clients</h2>
            <p className="text-gray-500 text-sm">Manage clients, track invoices and project relationships</p>
          </div>
          {canCreate && (
            <button onClick={openNew} className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2.5 rounded-lg font-medium transition-colors shadow-sm">
              <Plus size={18} /> Add Client
            </button>
          )}
        </div>

        {/* Summary Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
          <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wider font-medium">Total Clients</p>
                <p className="text-2xl font-bold text-gray-900 dark:text-white mt-1">{clients.length}</p>
              </div>
              <div className="w-10 h-10 bg-blue-100 dark:bg-blue-900/30 rounded-lg flex items-center justify-center">
                <Users size={20} className="text-blue-600 dark:text-blue-400" />
              </div>
            </div>
          </div>
          <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wider font-medium">Active</p>
                <p className="text-2xl font-bold text-green-600 dark:text-green-400 mt-1">{activeCount}</p>
              </div>
              <div className="w-10 h-10 bg-green-100 dark:bg-green-900/30 rounded-lg flex items-center justify-center">
                <TrendingUp size={20} className="text-green-600 dark:text-green-400" />
              </div>
            </div>
          </div>
          <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wider font-medium">Inactive</p>
                <p className="text-2xl font-bold text-gray-400 mt-1">{inactiveCount}</p>
              </div>
              <div className="w-10 h-10 bg-gray-100 dark:bg-gray-700 rounded-lg flex items-center justify-center">
                <Users size={20} className="text-gray-400" />
              </div>
            </div>
          </div>
        </div>

        {/* Search & Filter Bar */}
        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-3 mb-4 flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={18} />
            <input type="text" placeholder="Search by name, email, phone, NTN..."
              value={search} onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-10 pr-4 py-2.5 bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-lg text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div className="flex items-center gap-2">
            <Filter size={16} className="text-gray-400" />
            {['ALL', 'ACTIVE', 'INACTIVE'].map((s) => (
              <button key={s} onClick={() => setStatusFilter(s)}
                className={`px-3 py-2 rounded-lg text-xs font-semibold transition-colors ${
                  statusFilter === s ? 'bg-blue-600 text-white' : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-600'
                }`}>
                {s === 'ALL' ? `All (${clients.length})` : s === 'ACTIVE' ? `Active (${activeCount})` : `Inactive (${inactiveCount})`}
              </button>
            ))}
          </div>
        </div>

        {/* Table */}
        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-gray-50 dark:bg-gray-900/50 border-b border-gray-200 dark:border-gray-700 text-xs text-gray-500 uppercase tracking-wider">
                <tr>
                  <th className="px-4 py-3">Client</th>
                  <th className="px-4 py-3 hidden md:table-cell">Contact</th>
                  <th className="px-4 py-3 hidden lg:table-cell">City / Country</th>
                  <th className="px-4 py-3 hidden lg:table-cell">Tax ID</th>
                  <th className="px-4 py-3 text-center">Status</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                {loading && <tr><td colSpan={6} className="p-12 text-center text-gray-400">Loading clients...</td></tr>}
                {!loading && filtered.length === 0 && (
                  <tr><td colSpan={6} className="p-12 text-center text-gray-400">
                    <Building2 size={40} className="mx-auto mb-3 text-gray-300 dark:text-gray-600" />
                    <p className="font-medium">No clients found</p>
                    <p className="text-xs mt-1">Add your first client to get started</p>
                  </td></tr>
                )}
                {filtered.map((c) => (
                  <tr key={c.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/30 transition-colors cursor-pointer group" onClick={() => openDetail(c)}>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <div className="w-9 h-9 bg-gradient-to-br from-blue-500 to-blue-700 rounded-lg flex items-center justify-center flex-shrink-0">
                          <span className="text-white font-bold text-sm">{c.name.charAt(0).toUpperCase()}</span>
                        </div>
                        <div className="min-w-0">
                          <p className="font-semibold text-gray-900 dark:text-white group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors truncate">{c.name}</p>
                          <div className="flex items-center gap-2 mt-0.5">
                            {c.email && <span className="text-xs text-gray-500 truncate max-w-[150px]">{c.email}</span>}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 hidden md:table-cell">
                      <p className="text-gray-700 dark:text-gray-300 text-sm">{c.contact_person || "-"}</p>
                      {c.phone && <p className="text-xs text-gray-500 flex items-center gap-1 mt-0.5"><Phone size={10} /> {c.phone}</p>}
                    </td>
                    <td className="px-4 py-3 hidden lg:table-cell text-gray-600 dark:text-gray-400 text-sm">
                      {c.city || "-"}{c.city && c.country ? ", " : ""}{c.country || ""}
                    </td>
                    <td className="px-4 py-3 hidden lg:table-cell text-gray-600 dark:text-gray-400 font-mono text-xs">
                      {c.tax_id || "-"}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className={`px-2.5 py-1 rounded-full text-[11px] font-bold ${
                        c.status === "ACTIVE" ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400" : "bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400"
                      }`}>{c.status}</span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity" onClick={(e) => e.stopPropagation()}>
                        <button onClick={() => openDetail(c)} title="View Details" className="p-1.5 rounded-lg hover:bg-blue-50 dark:hover:bg-blue-500/10 text-blue-600 dark:text-blue-400 transition-colors">
                          <Eye size={15} />
                        </button>
                        {canEdit && (
                          <button onClick={() => openEdit(c)} title="Edit" className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500 transition-colors">
                            <Edit2 size={15} />
                          </button>
                        )}
                        {canDelete && (
                          <button onClick={() => setDeleteId(c.id)} title="Delete" className="p-1.5 rounded-lg hover:bg-red-50 dark:hover:bg-red-500/10 text-red-500 transition-colors">
                            <Trash2 size={15} />
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
      </div>

      {/* ═══════════ CLIENT DETAIL PANEL ═══════════ */}
      {selectedClient && (
        <div className="hidden lg:block w-96 flex-shrink-0">
          <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden sticky top-4">
            {/* Panel Header */}
            <div className="p-4 border-b border-gray-200 dark:border-gray-700 bg-gradient-to-r from-blue-600 to-blue-700">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-white/20 rounded-lg flex items-center justify-center">
                    <span className="text-white font-bold">{selectedClient.client.name.charAt(0).toUpperCase()}</span>
                  </div>
                  <div>
                    <h3 className="text-white font-bold text-sm">{selectedClient.client.name}</h3>
                    <p className="text-blue-200 text-xs">Client Details</p>
                  </div>
                </div>
                <button onClick={() => setSelectedClient(null)} className="text-white/70 hover:text-white p-1 rounded hover:bg-white/10">
                  <X size={18} />
                </button>
              </div>
            </div>

            {detailLoading ? (
              <div className="p-8 text-center text-gray-400 text-sm">Loading...</div>
            ) : (
              <div className="p-4 space-y-4 max-h-[calc(100vh-200px)] overflow-y-auto">
                {/* Contact Info */}
                <div className="space-y-2">
                  <h4 className="text-xs font-bold text-gray-500 uppercase tracking-wider">Contact Information</h4>
                  <div className="bg-gray-50 dark:bg-gray-900/50 rounded-lg p-3 space-y-2">
                    {selectedClient.client.contact_person && (
                      <div className="flex items-center gap-2 text-sm"><Users size={14} className="text-gray-400" /><span className="text-gray-700 dark:text-gray-300">{selectedClient.client.contact_person}</span></div>
                    )}
                    {selectedClient.client.email && (
                      <div className="flex items-center gap-2 text-sm"><Mail size={14} className="text-gray-400" /><span className="text-blue-600 dark:text-blue-400">{selectedClient.client.email}</span></div>
                    )}
                    {selectedClient.client.phone && (
                      <div className="flex items-center gap-2 text-sm"><Phone size={14} className="text-gray-400" /><span className="text-gray-700 dark:text-gray-300">{selectedClient.client.phone}</span></div>
                    )}
                    {(selectedClient.client.city || selectedClient.client.country) && (
                      <p className="text-xs text-gray-500 mt-1">{selectedClient.client.city}{selectedClient.client.city && selectedClient.client.country ? ', ' : ''}{selectedClient.client.country}</p>
                    )}
                    {selectedClient.client.address && (
                      <p className="text-xs text-gray-500">{selectedClient.client.address}</p>
                    )}
                    {selectedClient.client.tax_id && (
                      <p className="text-xs text-gray-500 font-mono">NTN: {selectedClient.client.tax_id}</p>
                    )}
                  </div>
                </div>

                {/* Financial Summary */}
                <div className="space-y-2">
                  <h4 className="text-xs font-bold text-gray-500 uppercase tracking-wider flex items-center gap-1.5"><FileText size={12} /> Financial Summary</h4>
                  <div className="grid grid-cols-3 gap-2">
                    <div className="bg-gray-50 dark:bg-gray-900/50 rounded-lg p-2.5 text-center">
                      <p className="text-[10px] text-gray-500 uppercase">Invoiced</p>
                      <p className="text-sm font-bold text-gray-900 dark:text-white mt-0.5">{formatCurrency(detailTotalInvoiced)}</p>
                    </div>
                    <div className="bg-gray-50 dark:bg-gray-900/50 rounded-lg p-2.5 text-center">
                      <p className="text-[10px] text-gray-500 uppercase">Paid</p>
                      <p className="text-sm font-bold text-green-600 mt-0.5">{formatCurrency(detailTotalPaid)}</p>
                    </div>
                    <div className="bg-gray-50 dark:bg-gray-900/50 rounded-lg p-2.5 text-center">
                      <p className="text-[10px] text-gray-500 uppercase">Outstanding</p>
                      <p className={`text-sm font-bold mt-0.5 ${detailTotalOutstanding > 0 ? 'text-red-600' : 'text-gray-400'}`}>{formatCurrency(detailTotalOutstanding)}</p>
                    </div>
                  </div>
                </div>

                {/* Projects */}
                <div className="space-y-2">
                  <h4 className="text-xs font-bold text-gray-500 uppercase tracking-wider flex items-center gap-1.5"><FolderKanban size={12} /> Projects ({selectedClient.projects.length})</h4>
                  {selectedClient.projects.length === 0 ? (
                    <p className="text-xs text-gray-400 italic">No linked projects</p>
                  ) : (
                    <div className="space-y-1.5">
                      {selectedClient.projects.map((p) => (
                        <div key={p.id} className="flex items-center justify-between bg-gray-50 dark:bg-gray-900/50 rounded-lg px-3 py-2">
                          <span className="text-sm text-gray-700 dark:text-gray-300 font-medium truncate">{p.name}</span>
                          <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${
                            p.status === 'Active' ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' :
                            p.status === 'Completed' ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400' :
                            'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400'
                          }`}>{p.status}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Invoices */}
                <div className="space-y-2">
                  <h4 className="text-xs font-bold text-gray-500 uppercase tracking-wider flex items-center gap-1.5"><FileText size={12} /> Invoices ({selectedClient.invoices.length})</h4>
                  {selectedClient.invoices.length === 0 ? (
                    <p className="text-xs text-gray-400 italic">No linked invoices</p>
                  ) : (
                    <div className="space-y-1.5 max-h-48 overflow-y-auto">
                      {selectedClient.invoices.map((inv) => (
                        <div key={inv.id} className="bg-gray-50 dark:bg-gray-900/50 rounded-lg px-3 py-2.5">
                          <div className="flex items-center justify-between">
                            <span className="text-xs font-mono text-blue-600 dark:text-blue-400">{inv.invoice_number || 'N/A'}</span>
                            <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${
                              inv.status === 'PAID' ? 'bg-green-100 text-green-700' :
                              inv.status === 'OVERDUE' ? 'bg-red-100 text-red-700' :
                              'bg-gray-100 text-gray-600'
                            }`}>{inv.status}</span>
                          </div>
                          <div className="flex justify-between mt-1 text-xs">
                            <span className="text-gray-500">Total: {formatCurrency(inv.total_amount)}</span>
                            <span className={inv.outstanding_amount > 0 ? 'text-red-600 font-semibold' : 'text-green-600'}>Due: {formatCurrency(inv.outstanding_amount)}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ═══════════ CREATE/EDIT MODAL ═══════════ */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-2xl w-full max-w-lg shadow-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between p-5 border-b border-gray-200 dark:border-gray-700">
              <h3 className="text-lg font-bold text-gray-900 dark:text-white">{editing ? "Edit Client" : "New Client"}</h3>
              <button onClick={() => setShowForm(false)} className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500 transition-colors"><X size={18} /></button>
            </div>
            <div className="p-5 space-y-4">
              {/* Business Name */}
              <div>
                <label className={labelCls}>Business / Client Name *</label>
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g., TechCorp Pvt Ltd" className={inputCls} />
              </div>

              {/* Contact Person */}
              <div>
                <label className={labelCls}>Contact Person</label>
                <input value={form.contact_person} onChange={(e) => setForm({ ...form, contact_person: e.target.value })} placeholder="e.g., Ahmed Khan" className={inputCls} />
              </div>

              {/* Email & Phone */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className={labelCls}>Email</label>
                  <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="contact@company.com" className={inputCls} />
                </div>
                <div>
                  <label className={labelCls}>Phone</label>
                  <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="03XX-XXXXXXX" className={inputCls} />
                </div>
              </div>

              {/* Address */}
              <div>
                <label className={labelCls}>Address</label>
                <input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} placeholder="Office address" className={inputCls} />
              </div>

              {/* City & Country */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className={labelCls}>City</label>
                  <input value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} placeholder="e.g., Karachi" className={inputCls} />
                </div>
                <div>
                  <label className={labelCls}>Country</label>
                  <input value={form.country} onChange={(e) => setForm({ ...form, country: e.target.value })} placeholder="Pakistan" className={inputCls} />
                </div>
              </div>

              {/* Tax ID */}
              <div>
                <label className={labelCls}>Tax ID / NTN</label>
                <input value={form.tax_id} onChange={(e) => setForm({ ...form, tax_id: e.target.value })} placeholder="e.g., 1234567-8" className={`${inputCls} font-mono`} />
              </div>

              {/* Status */}
              <div>
                <label className={labelCls}>Status</label>
                <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })} className={inputCls}>
                  <option value="ACTIVE">Active</option>
                  <option value="INACTIVE">Inactive</option>
                </select>
              </div>
            </div>
            <div className="flex gap-3 p-5 border-t border-gray-200 dark:border-gray-700 bg-gray-50/50 dark:bg-gray-900/30">
              <button onClick={() => setShowForm(false)} className="flex-1 px-4 py-2.5 bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-800 dark:text-white rounded-xl text-sm font-medium transition-colors">Cancel</button>
              <button onClick={handleSave} disabled={saving} className="flex-1 px-4 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-sm font-medium disabled:opacity-50 transition-colors">{saving ? "Saving..." : "Save Client"}</button>
            </div>
          </div>
        </div>
      )}

      {/* ═══════════ DELETE CONFIRMATION ═══════════ */}
      {deleteId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-2xl w-full max-w-sm shadow-2xl p-6 text-center">
            <div className="mx-auto w-12 h-12 bg-red-100 dark:bg-red-900/30 rounded-full flex items-center justify-center mb-4">
              <Trash2 size={24} className="text-red-600 dark:text-red-400" />
            </div>
            <h3 className="text-lg font-bold text-gray-900 dark:text-white mb-2">Delete Client?</h3>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">This client&apos;s data will be permanently removed. Invoices and projects linked to this client will not be deleted.</p>
            <div className="flex gap-3">
              <button onClick={() => setDeleteId(null)} className="flex-1 px-4 py-2.5 bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-800 dark:text-white rounded-xl text-sm font-medium transition-colors">Cancel</button>
              <button onClick={handleDelete} className="flex-1 px-4 py-2.5 bg-red-600 hover:bg-red-700 text-white rounded-xl text-sm font-medium transition-colors">Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

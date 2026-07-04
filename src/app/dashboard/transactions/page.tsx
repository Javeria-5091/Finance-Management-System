"use client";
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/context/AuthContext";
import { Project, Income, Expense } from "@/types";
import { Search, Filter, ChevronLeft, ChevronRight } from "lucide-react";

interface Transaction {
  id: string;
  type: "Income" | "Expense";
  title: string;
  amount: number;
  category: string;
  date: string;
  project_id: string | null;
}

export default function TransactionsPage() {
  const { user } = useAuth();
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);

  // Search & Filter States
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("All");

  // Pagination States
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 10;

  // Data Fetch
  useEffect(() => {
    if (!user) return;
    async function fetchData() {
     
      const [incRes, expRes, projRes] = await Promise.all([
        supabase.from("incomes").select("*").order("income_date", { ascending: false }),
        supabase.from("expenses").select("*").order("expense_date", { ascending: false }),
        supabase.from("projects").select("*") 
      ]);

      const incData: Transaction[] = (incRes.data || []).map(i => ({
        id: i.id, type: "Income", title: i.title, amount: i.amount,
        category: i.category, date: i.income_date, project_id: i.project_id
      }));

      const expData: Transaction[] = (expRes.data || []).map(e => ({
        id: e.id, type: "Expense", title: e.title, amount: e.amount,
        category: e.category, date: e.expense_date, project_id: e.project_id
      }));

      const merged = [...incData, ...expData].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
      setTransactions(merged);
      if (projRes.data) setProjects(projRes.data);
      setLoading(false);
    }
    fetchData();
  }, [user]);

  // Filtering Logic
  const filteredData = transactions.filter(t => {
    const matchesSearch = 
      t.title.toLowerCase().includes(search.toLowerCase()) ||
      t.category.toLowerCase().includes(search.toLowerCase());
    
    const matchesType = typeFilter === "All" || t.type === typeFilter;
    
    return matchesSearch && matchesType;
  });

  // Pagination Logic
  const totalPages = Math.ceil(filteredData.length / itemsPerPage);
  const startIndex = (currentPage - 1) * itemsPerPage;
  const currentTableData = filteredData.slice(startIndex, startIndex + itemsPerPage);

  function handleFilterChange(newFilter: string) {
    setTypeFilter(newFilter);
    setCurrentPage(1);
  }

  function handleSearchChange(newSearch: string) {
    setSearch(newSearch);
    setCurrentPage(1);
  }

  function getProjectName(projectId: string | null) {
    if (!projectId) return "-";
    return projects.find(p => p.id === projectId)?.name || "Deleted";
  }

  function formatCurrency(amount: number) {
    return new Intl.NumberFormat("en-PK", { style: "currency", currency: "PKR", minimumFractionDigits: 0 }).format(amount);
  }

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
        <div>
          <h2 className="text-2xl font-bold text-white">Transaction History</h2>
          <p className="text-gray-400 text-sm">All your income and expenses in one place</p>
        </div>
      </div>

      {/* SEARCH & FILTER BAR */}
      <div className="bg-gray-800 border border-gray-700 rounded-xl p-4 mb-6">
        <div className="flex flex-col sm:flex-row gap-4">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              type="text"
              placeholder="Search by title or category..."
              value={search}
              onChange={e => handleSearchChange(e.target.value)}
              className="w-full pl-9 pr-4 py-2.5 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div className="relative sm:w-48">
            <Filter className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <select 
              value={typeFilter} 
              onChange={e => handleFilterChange(e.target.value)}
              className="w-full pl-9 pr-4 py-2.5 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 appearance-none"
            >
              <option value="All">All Types</option>
              <option value="Income">Income Only</option>
              <option value="Expense">Expense Only</option>
            </select>
          </div>
        </div>
        
        <p className="text-xs text-gray-500 mt-3">
          Showing {currentTableData.length} of {filteredData.length} results
          {typeFilter !== "All" && ` (Filtered by ${typeFilter})`}
          {search && ` (Searching: "${search}")`}
        </p>
      </div>

      {/* TABLE */}
      <div className="bg-gray-800 border border-gray-700 rounded-xl overflow-hidden">
        <table className="w-full text-left">
          <thead className="border-b border-gray-700 bg-gray-900/50">
            <tr>
              <th className="px-4 py-3 text-xs font-medium text-gray-400 uppercase">Type</th>
              <th className="px-4 py-3 text-xs font-medium text-gray-400 uppercase">Title / Details</th>
              <th className="px-4 py-3 text-xs font-medium text-gray-400 uppercase hidden md:table-cell">Project</th>
              <th className="px-4 py-3 text-xs font-medium text-gray-400 uppercase hidden sm:table-cell">Category</th>
              <th className="px-4 py-3 text-xs font-medium text-gray-400 uppercase text-right">Amount</th>
              <th className="px-4 py-3 text-xs font-medium text-gray-400 uppercase text-right hidden sm:table-cell">Date</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-700">
            {loading && <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-400">Loading...</td></tr>}
            {!loading && filteredData.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-12 text-center text-gray-400">No transactions found.</td></tr>
            )}

            {currentTableData.map(t => (
              <tr key={t.id} className="hover:bg-gray-700/50 transition-colors">
                <td className="px-4 py-3">
                  <span className={`text-xs font-bold px-2 py-1 rounded ${t.type === "Income" ? "bg-green-500/20 text-green-400" : "bg-red-500/20 text-red-400"}`}>
                    {t.type}
                  </span>
                </td>
                <td className="px-4 py-3 font-medium text-white">{t.title}</td>
                <td className="px-4 py-3 text-gray-400 hidden md:table-cell">{getProjectName(t.project_id)}</td>
                <td className="px-4 py-3 text-gray-400 hidden sm:table-cell">{t.category}</td>
                <td className={`px-4 py-3 text-right font-semibold ${t.type === "Income" ? "text-green-400" : "text-red-400"}`}>
                  {t.type === "Income" ? "+" : "-"}{formatCurrency(t.amount)}
                </td>
                <td className="px-4 py-3 text-gray-400 text-right hidden sm:table-cell">
                  {new Date(t.date).toLocaleDateString("en-PK")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* PAGINATION CONTROLS */}
      {!loading && filteredData.length > itemsPerPage && (
        <div className="flex items-center justify-between mt-4 px-1">
          <p className="text-sm text-gray-500">Page {currentPage} of {totalPages}</p>
          
          <div className="flex items-center gap-2">
            <button
              onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
              disabled={currentPage === 1}
              className="p-2 rounded-lg bg-gray-800 border border-gray-700 text-gray-400 hover:text-white hover:border-gray-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              <ChevronLeft size={18} />
            </button>
            
            <div className="hidden sm:flex items-center gap-1">
              {Array.from({ length: totalPages }, (_, i) => i + 1).map(page => (
                <button
                  key={page}
                  onClick={() => setCurrentPage(page)}
                  className={`w-9 h-9 rounded-lg text-sm font-medium transition-colors ${
                    currentPage === page 
                      ? "bg-blue-600 text-white" 
                      : "bg-gray-800 border border-gray-700 text-gray-400 hover:text-white hover:border-gray-600"
                  }`}
                >
                  {page}
                </button>
              ))}
            </div>

            <button
              onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
              disabled={currentPage === totalPages}
              className="p-2 rounded-lg bg-gray-800 border border-gray-700 text-gray-400 hover:text-white hover:border-gray-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              <ChevronRight size={18} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
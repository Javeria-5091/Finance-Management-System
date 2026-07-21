"use client";
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/context/AuthContext";
import { Income, Expense, Project } from "@/types";
import { Download, FileText, Filter } from "lucide-react"; 
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";

export default function ReportsPage() {
  const { user } = useAuth();
  const [incomes, setIncomes] = useState<Income[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);

  // Filters State
  const [reportType, setReportType] = useState("monthly");
  const [selectedMonth, setSelectedMonth] = useState(new Date().getMonth() + 1);
  const [selectedYear, setSelectedYear] = useState(new Date().getFullYear());
  const [selectedProject, setSelectedProject] = useState("all");

  useEffect(() => {
    if (!user?.id) return; 

    async function fetchData() {
      const [incRes, expRes, projRes] = await Promise.all([
        supabase.from("incomes").select("*").order("income_date", { ascending: false }),
        supabase.from("expenses").select("*").order("expense_date", { ascending: false }),
        supabase.from("projects").select("*").order("start_date", { ascending: false }),
      ]);

      if (incRes.data) setIncomes(incRes.data);
      if (expRes.data) setExpenses(expRes.data);
      if (projRes.data) setProjects(projRes.data);
      
      setLoading(false);
    }

    fetchData();
  }, [user]); 

  // DYNAMIC YEARS GENERATION
  const currentYear = new Date().getFullYear();
  const years = Array.from({ length: 5 }, (_, i) => currentYear - 2 + i);

  // Filtering Logic
  const getFilteredData = () => {
    let fIncome = [...incomes];
    let fExpense = [...expenses];

    if (reportType === "monthly") {
      fIncome = fIncome.filter(i => { const d = new Date(i.income_date); return d.getMonth() + 1 === selectedMonth && d.getFullYear() === selectedYear; });
      fExpense = fExpense.filter(e => { const d = new Date(e.expense_date); return d.getMonth() + 1 === selectedMonth && d.getFullYear() === selectedYear; });
    } else if (reportType === "yearly") {
      fIncome = fIncome.filter(i => new Date(i.income_date).getFullYear() === selectedYear);
      fExpense = fExpense.filter(e => new Date(e.expense_date).getFullYear() === selectedYear);
    } else if (reportType === "project-wise" && selectedProject !== "all") {
      fIncome = fIncome.filter(i => i.project_id === selectedProject);
      fExpense = fExpense.filter(e => e.project_id === selectedProject);
    }

    return { fIncome, fExpense };
  };

  const { fIncome, fExpense } = getFilteredData();
  const totalInc = fIncome.reduce((s, i) => s + i.amount, 0);
  const totalExp = fExpense.reduce((s, e) => s + e.amount, 0);
  const profit = totalInc - totalExp;

  const getProjectName = (id: string | null) => id ? projects.find(p => p.id === id)?.name || "Deleted" : "General";
  const formatCurrency = (amount: number) => new Intl.NumberFormat("en-PK", { style: "currency", currency: "PKR", minimumFractionDigits: 0 }).format(amount);
  
  const getTitle = () => {
    if (reportType === "monthly") return `Monthly Report - ${new Date(selectedYear, selectedMonth - 1).toLocaleString('default', { month: 'long' })} ${selectedYear}`;
    if (reportType === "yearly") return `Yearly Report - ${selectedYear}`;
    if (reportType === "project-wise") return `Project Wise Report - ${selectedProject === "all" ? "All Projects" : getProjectName(selectedProject)}`;
    if (reportType === "income") return "Income Report";
    if (reportType === "expense") return "Expense Report";
    return "Profit & Loss Report";
  };

  // --- EXPORT FUNCTIONS ---
  
  // 1. CSV EXPORT
  function downloadCSV() {
    let rows: string[][] = [["Osystic Finance - " + getTitle()], []];
    const showInc = reportType !== "expense";
    const showExp = reportType !== "income";

    if (showInc) {
      rows.push(["--- INCOME DATA ---"]);
      rows.push(["Title", "Project", "Amount (PKR)", "Category", "Date"]);
      fIncome.forEach(i => rows.push([String(i.title), String(getProjectName(i.id)), String(i.amount), String(i.category), String(i.income_date)]));
      rows.push(["TOTAL INCOME", "", String(totalInc), "", ""]);
      rows.push([]);
    }

    if (showExp) {
      rows.push(["--- EXPENSE DATA ---"]);
      rows.push(["Title", "Project", "Amount (PKR)", "Category", "Date"]);
      fExpense.forEach(e => rows.push([String(e.title), String(getProjectName(e.id)), String(e.amount), String(e.category), String(e.expense_date)]));
      rows.push(["TOTAL EXPENSES", "", String(totalExp), "", ""]);
      rows.push([]);
    }

    if (reportType === "profit-loss") {
      rows.push(["--- SUMMARY ---"]);
      rows.push(["NET PROFIT/LOSS", "", String(profit), "", ""]);
    }

    const csvContent = "data:text/csv;charset=utf-8," + rows.map(e => e.join(",")).join("\n");
    const link = document.createElement("a");
    link.setAttribute("href", encodeURI(csvContent));
    link.setAttribute("download", `${reportType}_report.csv`);
    document.body.appendChild(link); link.click(); document.body.removeChild(link);
  }

  // 2. PDF EXPORT
  function downloadPDF() {
    const doc = new jsPDF();
    const pageWidth = doc.internal.pageSize.getWidth();
    
    doc.setFillColor(17, 24, 39);
    doc.rect(0, 0, pageWidth, 35, 'F');
    doc.setFontSize(20); doc.setTextColor(59, 130, 246); doc.text("Osystic Finance", 14, 22);
    doc.setFontSize(10); doc.setTextColor(200); doc.text("Financial Report", 14, 29);

    let y = 45;
    doc.setTextColor(30, 41, 59); doc.setFontSize(14); doc.setFont("helvetica", "bold");
    doc.text(getTitle(), 14, y);
    y += 15;

    const showInc = reportType !== "expense";
    const showExp = reportType !== "income";

    if (showInc) {
      doc.setFontSize(11); doc.setFont("helvetica", "bold"); doc.text("Income Summary", 14, y); y += 5;
      autoTable(doc, {
        startY: y, margin: { left: 14, right: 14 },
        head: [["Title", "Project", "Amount (PKR)", "Date"]],
        body: fIncome.map(i => [String(i.title), String(getProjectName(i.id)), String(Number(i.amount).toLocaleString()), String(i.income_date)]),
        theme: "striped", headStyles: { fillColor: [16, 185, 129], textColor: 255 }, styles: { fontSize: 9 }
      });
      y = (doc as any).lastAutoTable.finalY + 10;
      doc.setFontSize(10); doc.setTextColor(16, 185, 129); doc.text("Total Income: " + formatCurrency(totalInc), 14, y);
      y += 10;
    }

    if (showExp) {
      if (y > 250) { doc.addPage(); y = 20; }
      doc.setFontSize(11); doc.setTextColor(30, 41, 59); doc.setFont("helvetica", "bold"); doc.text("Expense Summary", 14, y); y += 5;
      autoTable(doc, {
        startY: y, margin: { left: 14, right: 14 },
        head: [["Title", "Project", "Amount (PKR)", "Date"]],
        body: fExpense.map(e => [String(e.title), String(getProjectName(e.id)), String(Number(e.amount).toLocaleString()), String(e.expense_date)]),
        theme: "striped", headStyles: { fillColor: [239, 68, 68], textColor: 255 }, styles: { fontSize: 9 }
      });
      y = (doc as any).lastAutoTable.finalY + 10;
      doc.setFontSize(10); doc.setTextColor(239, 68, 68); doc.text("Total Expenses: " + formatCurrency(totalExp), 14, y);
      y += 10;
    }

    if (reportType === "profit-loss") {
      if (y > 260) { doc.addPage(); y = 20; }
      doc.setFillColor(241, 245, 249); doc.rect(14, y - 5, pageWidth - 28, 20, 'F');
      doc.setFontSize(12); doc.setTextColor(30, 41, 59); doc.setFont("helvetica", "bold");
      doc.text("NET PROFIT/LOSS: " + formatCurrency(profit), 20, y + 8);
    }

    doc.save(`${reportType}_report.pdf`);
  }

  if (loading) return <div className="flex items-center justify-center h-64 text-gray-500 dark:text-gray-400">Loading Data...</div>;

  return (
    <div>
      {/* HEADER */}
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-gray-900 dark:text-white">Financial Reports</h2>
        <p className="text-gray-500 dark:text-gray-400 text-sm">Generate and export detailed reports</p>
      </div>

      {/* FILTERS SECTION */}
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-5 mb-6 shadow-sm dark:shadow-none space-y-5">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
          
          {/* Report Type */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Report Type</label>
            <select 
              value={reportType} 
              onChange={e => setReportType(e.target.value)} 
              className="w-full px-3 py-2.5 bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-lg text-gray-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors"
            >
              <option value="monthly">Monthly Report</option>
              <option value="yearly">Yearly Report</option>
              <option value="project-wise">Project-wise Report</option>
              <option value="income">Income Report</option>
              <option value="expense">Expense Report</option>
              <option value="profit-loss">Profit/Loss Report</option>
            </select>
          </div>

          {/* Month */}
          {(reportType === "monthly" || reportType === "yearly") && (
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Month</label>
              <select 
                value={selectedMonth} 
                onChange={e => setSelectedMonth(Number(e.target.value))} 
                className="w-full px-3 py-2.5 bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-lg text-gray-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors"
              >
                {Array.from({length: 12}, (_, i) => i + 1).map(m => (
                  <option key={m} value={m}>{new Date(2000, m-1).toLocaleString('default', {month: 'long'})}</option>
                ))}
              </select>
            </div>
          )}

          {/* Year */}
          {(reportType === "monthly" || reportType === "yearly") && (
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Year</label>
              <select 
                value={selectedYear} 
                onChange={e => setSelectedYear(Number(e.target.value))} 
                className="w-full px-3 py-2.5 bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-lg text-gray-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors"
              >
                {years.map(y => <option key={y} value={y}>{y}</option>)}
              </select>
            </div>
          )}

          {/* Project Selection */}
          {reportType === "project-wise" && (
            <div className="sm:col-span-2">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Select Project</label>
              <select 
                value={selectedProject} 
                onChange={e => setSelectedProject(e.target.value)} 
                className="w-full px-3 py-2.5 bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-lg text-gray-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors"
              >
                <option value="all">All Projects</option>
                {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
          )}
        </div>
      </div>

      {/* SUMMARY CARDS */}
      {(reportType === "profit-loss" || reportType === "monthly" || reportType === "yearly" || reportType === "project-wise") && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
          <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-4 shadow-sm dark:shadow-none">
            <p className="text-sm text-gray-500 dark:text-gray-400">Total Income</p>
            <p className="text-xl font-bold text-green-600 dark:text-green-400 mt-1">{formatCurrency(totalInc)}</p>
          </div>
          <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-4 shadow-sm dark:shadow-none">
            <p className="text-sm text-gray-500 dark:text-gray-400">Total Expenses</p>
            <p className="text-xl font-bold text-red-600 dark:text-red-400 mt-1">{formatCurrency(totalExp)}</p>
          </div>
          <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-4 shadow-sm dark:shadow-none">
            <p className="text-sm text-gray-500 dark:text-gray-400">Net Profit/Loss</p>
            <p className={`text-xl font-bold mt-1 ${profit >= 0 ? "text-blue-600 dark:text-blue-400" : "text-red-600 dark:text-red-400"}`}>{formatCurrency(profit)}</p>
          </div>
        </div>
      )}

      {/* TABLE PREVIEW & EXPORT BUTTONS */}
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden shadow-sm dark:shadow-none">
        
        {/* Top Bar */}
        <div className="p-4 border-b border-gray-200 dark:border-gray-700 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
          <h3 className="text-gray-900 dark:text-white font-medium">Preview: {getTitle()}</h3>
          <div className="flex gap-2 w-full sm:w-auto">
            <button onClick={downloadCSV} className="flex-1 sm:flex-initial flex items-center justify-center gap-2 bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2.5 rounded-lg text-sm font-medium transition-colors shadow-sm">
              <Download size={16} /> Excel (CSV)
            </button>
            <button onClick={downloadPDF} className="flex-1 sm:flex-initial flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2.5 rounded-lg text-sm font-medium transition-colors shadow-sm">
              <FileText size={16} /> Download PDF
            </button>
          </div>
        </div>
        
        {/* Table */}
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            {/* Table Head */}
            <thead className="bg-gray-100 dark:bg-gray-900/70 border-b border-gray-200 dark:border-gray-700 text-xs text-gray-600 dark:text-gray-400 uppercase tracking-wider">
              <tr>
                <th className="px-4 py-3 text-left font-semibold">Type</th>
                <th className="px-4 py-3 text-left font-semibold">Title</th>
                <th className="px-4 py-3 text-left font-semibold hidden md:table-cell">Project</th>
                <th className="px-4 py-3 text-left font-semibold">Category</th>
                <th className="px-4 py-3 text-right font-semibold">Amount</th>
                <th className="px-4 py-3 text-right font-semibold hidden sm:table-cell">Date</th>
              </tr>
            </thead>
            
            {/* Table Body */}
            <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
              {(reportType !== "expense") && fIncome.map(i => (
                <tr key={i.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors">
                  <td className="px-4 py-2.5">
                    <span className="bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-400 text-xs px-2 py-0.5 rounded font-medium">Income</span>
                  </td>
                  <td className="px-4 py-2.5 text-gray-900 dark:text-white font-medium">{i.title}</td>
                  <td className="px-4 py-2.5 text-gray-500 dark:text-gray-400 hidden md:table-cell">{getProjectName(i.id)}</td>
                  <td className="px-4 py-2.5 text-gray-500 dark:text-gray-400">{i.category}</td>
                  <td className="px-4 py-2.5 text-right text-emerald-600 dark:text-emerald-400 font-semibold">+{formatCurrency(i.amount)}</td>
                  <td className="px-4 py-2.5 text-right text-gray-500 dark:text-gray-400 hidden sm:table-cell">{i.income_date}</td>
                </tr>
              ))}
              
              {(reportType !== "income") && fExpense.map(e => (
                <tr key={e.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors">
                  <td className="px-4 py-2.5">
                    <span className="bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-400 text-xs px-2 py-0.5 rounded font-medium">Expense</span>
                  </td>
                  <td className="px-4 py-2.5 text-gray-900 dark:text-white font-medium">{e.title}</td>
                  <td className="px-4 py-2.5 text-gray-500 dark:text-gray-400 hidden md:table-cell">{getProjectName(e.id)}</td>
                  <td className="px-4 py-2.5 text-gray-500 dark:text-gray-400">{e.category}</td>
                  <td className="px-4 py-2.5 text-right text-red-600 dark:text-red-400 font-semibold">-{formatCurrency(e.amount)}</td>
                  <td className="px-4 py-2.5 text-right text-gray-500 dark:text-gray-400 hidden sm:table-cell">{e.expense_date}</td>
                </tr>
              ))}

              {fIncome.length === 0 && fExpense.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center text-gray-400 dark:text-gray-500">
                    No data found for this selection.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
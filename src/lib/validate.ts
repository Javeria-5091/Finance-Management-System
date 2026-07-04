// lib/validate.ts
export function validateForm(type: string, data: any): string | null {
  if (type === "project") {
    if (!data.name?.trim()) return "Project name is required.";
    if (!data.client_name?.trim()) return "Client name is required.";
    if (!data.start_date) return "Start date is required.";
  }
  
  if (type === "income") {
    if (!data.title?.trim()) return "Income title is required.";
    if (!data.amount || Number(data.amount) <= 0) return "Amount must be greater than 0.";
    if (!data.income_date) return "Date is required.";
    if (!data.category) return "Please select a category.";
  }

  if (type === "expense") {
    if (!data.title?.trim()) return "Expense title is required.";
    if (!data.amount || Number(data.amount) <= 0) return "Amount must be greater than 0.";
    if (!data.expense_date) return "Date is required.";
    if (!data.category) return "Please select a category.";
  }

  if (type === "invoice") {
    if (!data.client_name?.trim()) return "Client name is required.";
    if (!data.amount || Number(data.amount) <= 0) return "Amount must be greater than 0.";
    if (!data.due_date) return "Due date is required.";
  }

  return null; 
}
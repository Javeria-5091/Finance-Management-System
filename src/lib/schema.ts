export const DATABASE_SCHEMA = `
-- OSYSTIC FINANCE MANAGEMENT SYSTEM - DATABASE SCHEMA

-- TABLE RELATIONSHIPS (IMPORTANT FOR JOINS):
-- projects.budget_id → budgets.id
-- incomes.project_id → projects.id
-- expenses.project_id → projects.id
-- invoices.project_id → projects.id
-- payments.project_id → projects.id
-- payments.invoice_id → invoices.id

-- TABLES:
projects (id UUID, user_id UUID, name VARCHAR, client_name VARCHAR, description TEXT, status VARCHAR['Active','Completed','On Hold'], start_date DATE, end_date DATE, budget_id UUID, created_at TIMESTAMPTZ)

incomes (id UUID, user_id UUID, project_id UUID, title VARCHAR, amount DECIMAL, category VARCHAR['Salary','Freelance','Business','Investment','Rental','Other'], description TEXT, income_date DATE, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ)

expenses (id UUID, user_id UUID, project_id UUID, title VARCHAR, amount DECIMAL, category VARCHAR['Domain','Hosting','Software','Marketing','Salary','Freelance','Other'], expense_date DATE, notes TEXT, created_at TIMESTAMPTZ)

invoices (id UUID, user_id UUID, project_id UUID, invoice_number VARCHAR, client_name VARCHAR, amount DECIMAL, status VARCHAR['Draft','Pending','Paid','Overdue'], issue_date DATE, due_date DATE, notes TEXT, created_at TIMESTAMPTZ)

budgets (id UUID, user_id UUID, name TEXT, category TEXT, total_amount DECIMAL, start_date DATE, end_date DATE, description TEXT, created_at TIMESTAMPTZ)

payments (id UUID, user_id UUID, invoice_id UUID, project_id UUID, amount DECIMAL, payment_date DATE, payment_method VARCHAR['Bank Transfer','JazzCash','EasyPaisa','Cheque','Cash'], status VARCHAR['Pending','Paid','Partial Payment','Overdue'], notes TEXT, created_at TIMESTAMPTZ)

profiles (id UUID, user_id UUID, full_name TEXT, role VARCHAR['Admin','HOD','Program Manager','Project Manager','User'], email TEXT, created_at TIMESTAMPTZ)

audit_logs (id UUID, user_id UUID, action VARCHAR, module VARCHAR, details TEXT, created_at TIMESTAMPTZ)

-- COMMON QUERY PATTERNS:
-- Project with budget: SELECT p.name, b.total_amount FROM projects p LEFT JOIN budgets b ON p.budget_id = b.id
-- Project expenses: SELECT p.name, COALESCE(SUM(e.amount),0) as spent FROM projects p LEFT JOIN expenses e ON e.project_id = p.id GROUP BY p.id, p.name
-- Overbudget: Compare spent vs budget using above patterns

IGNORE: notifications table
`;
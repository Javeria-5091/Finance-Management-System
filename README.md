Osystic Finance Management System
A modern, enterprise-grade, full-stack financial management application built to track projects, incomes, expenses, and invoices efficiently. Features advanced analytics, role-based access control (RBAC), budget tracking, payment management, and automated reporting.

Next.jsTypeScriptTailwind CSSSupabaseChart.js

Tech Stack
Frontend: Next.js 14 (App Router), TypeScript, Tailwind CSS
Backend/Database: Supabase (PostgreSQL)
Authentication: Supabase Auth (Email/Password)
Charts & Analytics: Chart.js & React-Chartjs-2 (Upgraded for premium UI)
PDF Generation: jsPDF & jspdf-autotable
Icons: Lucide React
Features
🟢 Phase 1: Foundation & Income
Authentication System: Secure Login, Signup, and Logout functionality.
Protected Routes: Dashboard and sub-routes are protected, redirecting unauthenticated users to the login page.
Dashboard Layout: A clean, responsive layout featuring a collapsible Sidebar and a Top Navbar.
Income Management: Full CRUD (Create, Read, Update, Delete) operations for income records.
🟡 Phase 2: Projects, Expenses & Relations
Project Management: Create, edit, and delete client projects. Track client name, status (Active, On Hold, Completed), and start/end dates.
Expense Management: Full CRUD operations for tracking outgoing money.
Relational Database Design: Implemented robust Foreign Key relationships. Every Income and Expense is strictly linked to a Project.
Form Validations: Client-side validations ensuring no income or expense can be added without selecting a related project.
Cascading Deletes: Deleting a project automatically deletes all its associated incomes and expenses to maintain data integrity.
Responsive UI: Fully responsive tables and modals, adapting seamlessly from mobile to desktop.
🔴 Phase 3: Analytics, Invoices & Advanced Security
1. Finance Dashboard Analytics
Dynamic stat cards displaying: Total Projects, Total Income, Total Expenses, Net Profit/Loss, Monthly Revenue, Monthly Expenses, Active Projects, and Completed Projects.
Interactive Charts:
Monthly Income vs Expense (Forecast Line Chart)
Expense by Category (Donut Chart)
Real-time data fetching with global visibility (Admins see company-wide data, Users see read-only analytics).
2. Invoice Management Module
Complete CRUD operations for invoices.
Auto-Generated Invoice Numbers for professional tracking.
Link invoices directly to specific Projects.
Invoice Status Tracking: Draft, Pending, Paid, Overdue.
PDF Generation: Enterprise-level, beautifully formatted PDF invoices downloadable with a single click.
View-Only Access: Clients/Users can view and download invoices without edit/delete permissions.
3. Transaction History
Centralized Transactions page displaying both Income and Expense records in one unified table.
Displays: Transaction Type, Project, Amount, Date, and Category.
Advanced Search & Filters: Filter by transaction type or search by title/category.
Pagination: Clean pagination for large datasets.
4. Reports Module
Generate professional financial reports based on:
Monthly, Yearly, and Project-wise parameters.
Specific Income or Expense reports.
Overall Profit/Loss summaries.
Export Capabilities: Download reports as PDF or Excel (CSV).
5. Audit Log
Comprehensive tracking of system activities (Logins, CRUD operations on Projects, Incomes, Expenses, and User updates).
Displays: User Email, Action Performed, Module, and Date/Time.
6. Advanced Security (RBAC)
Role-Based Access Control (RBAC): Granular permissions system.
Dynamic Roles: Admin, HOD, Program Manager, Project Manager, User.
Granular Permissions: Admin can assign specific rights (e.g., "Can Create Project", "Can Add Income") to any user via the Admin Panel.
View-Only Access: Normal users can view global data (dashboards, invoices, reports) but cannot edit or delete unless explicitly permitted.
Supabase Row Level Security (RLS): Enterprise-grade database policies ensuring users can only modify their own created data, while securely allowing global read access.
Secure Route Guards: Frontend layout blocks unauthorized access to sensitive modules (like Admin Panel).
🟣 Phase 4: Budget Management, Payments & Premium UI
1. Organization Budget Management
Create, Edit, Delete Budgets: Define organization-level financial boundaries.
Budget Utilization Tracking: System automatically calculates Total Allocated, Used Amount, Remaining Balance, and Utilization Percentage.
Visual Progress Bars: Dynamic bars that change color based on usage (Green < 80%, Yellow 80-99%, Red > 100%).
2. Project Budget Allocation
Link Budgets to Projects: Assign organizational budgets to specific projects from the project creation/edit form.
Project-Wise Spending: Real-time tracking of how much budget a project has consumed vs. how much is allocated.
Budget Statuses: Automatic status updates (Within Budget, Near Limit, Over Budget) based on expense thresholds.
3. Expense Budget Control & Validation
Real-time Budget Checks: Before an expense is added, the system checks the remaining budget of the linked project.
Visual Warnings: Yellow warnings if the expense consumes over 80% of the remaining budget.
Hard Blocking: System physically disables the "Save" button if an expense exceeds the total remaining project budget to prevent overspending.
Budget Impact Display: Expense form shows exactly how much budget is left for the selected project.
4. Payment Tracking Module
Record Payments: Log incoming payments linked to specific Projects or Invoices.
Payment Methods: Support for Bank Transfer, JazzCash, EasyPaisa, Cheque, and Cash.
Status Tracking: Manage payment statuses (Pending, Paid, Partial Payment, Overdue).
Payment History: Centralized view of all incoming and outgoing financial flows.
5. Advanced Financial Dashboard (Chart.js Upgrade)
Upgraded from Recharts to Chart.js for a premium, modern enterprise look.
New Budget Analytics Cards: Total Org Budget, Used Budget, Remaining Budget, and Over Budget Projects count.
Premium Chart Types:
Financial Forecast (Gradient Area Chart)
Budget vs Actual Expenses (Bar Chart)
Project Budget Comparison (Bar Chart)
Monthly Expense Trend (Gradient Line Chart)
Canvas Drawn Labels: Replaced bugged tooltips with direct text rendering on charts for cleaner UI and zero "NaN" errors.
6. Light/Dark Theme System
Seamless Toggle: Elegant Sun/Moon toggle switch located in the top navigation bar.
Persistent Preference: Theme choice is saved in localStorage and persists across sessions.
Dynamic Styling: Complete UI adapts seamlessly between a clean Corporate Light theme and a Premium Dark theme using Tailwind's dark mode utilities.
Database Schema (Supabase PostgreSQL)
The system uses a scalable relational database structure:

profiles: Stores user details, roles (Admin, HOD, PM, User), and granular boolean permissions (can_create_project, can_add_income, etc.).
projects: Stores project details (name, client, status, dates). Contains budget_id to link with budgets.
budgets: Stores organization budget limits (name, category, total_amount, start/end dates).
incomes: Stores income data. Contains a project_id Foreign Key linked to projects.
expenses: Stores expense data. Contains a project_id Foreign Key linked to projects.
invoices: Stores invoice data, auto-generated numbers, statuses, and client details.
payments: Stores payment records, methods, statuses, linked to invoices and projects.
audit_logs: Tracks all critical system actions.
notifications: Stores alerts for users (e.g., large expenses, due invoices).
Security: Row Level Security (RLS) is strictly enabled on all tables. A custom is_admin() SQL function bypasses recursion loops to securely allow admins full read/write access to all data while keeping user data safe.

Getting Started
Prerequisites
Node.js (v18 or higher)
A Supabase account and project
1. Clone the repository
git clone https://github.com/Javeria-5091/Finance-Management-System.gitcd Finance-Management-System
2. Install dependencies
npm install
3. Set up Environment Variables
Create a .env.local file in the root directory and add your Supabase credentials:

env

NEXT_PUBLIC_SUPABASE_URL=your_supabase_url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_supabase_anon_key
4. Set up Supabase Database
Go to your Supabase SQL Editor and run the required SQL queries (located in the project documentation/notes) to create the tables (profiles, projects, incomes, expenses, invoices, budgets, payments, audit_logs), set up RLS policies, and create the is_admin() function.

5. Run the development server

npm run dev
Open http://localhost:3000 to view the app.

System Architecture & Security Logic
Global Read Access: Through advanced RLS policies, all authenticated users can view the entire company's financial data (Income, Expenses, Projects, Budgets) to generate accurate analytics and reports.
Strict Write Access: Users can only INSERT, UPDATE, or DELETE records that belong to them (auth.uid() = user_id), unless they are an Admin.
Budget Enforcement: Write operations on expenses are blocked at the frontend if they violate the allocated project budget limits, ensuring financial control.
Admin Override: Users with the Admin role in the profiles table bypass standard write restrictions to manage all system data safely.
License
This project is proprietary. All rights reserved.
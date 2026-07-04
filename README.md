
# Osystic Finance Management System

A modern, enterprise-grade, full-stack financial management application built to track projects, incomes, expenses, and invoices efficiently. Features advanced analytics, role-based access control (RBAC), and automated reporting.

![Next.js]
![TypeScript]
![Tailwind CSS]
![Supabase]

---

## 🚀 Tech Stack

- **Frontend:** Next.js 14 (App Router), TypeScript, Tailwind CSS
- **Backend/Database:** Supabase (PostgreSQL)
- **Authentication:** Supabase Auth (Email/Password)
- **Charts & Analytics:** Recharts
- **PDF Generation:** jsPDF & jspdf-autotable
- **Icons:** Lucide React

---

## ✨ Features

### 🟢 Phase 1: Foundation & Income
- **Authentication System:** Secure Login, Signup, and Logout functionality.
- **Protected Routes:** Dashboard and sub-routes are protected, redirecting unauthenticated users to the login page.
- **Dashboard Layout:** A clean, responsive layout featuring a collapsible Sidebar and a Top Navbar.
- **Income Management:** Full CRUD (Create, Read, Update, Delete) operations for income records.

### 🟡 Phase 2: Projects, Expenses & Relations
- **Project Management:** Create, edit, and delete client projects. Track client name, status (Active, On Hold, Completed), and start/end dates.
- **Expense Management:** Full CRUD operations for tracking outgoing money.
- **Relational Database Design:** Implemented robust Foreign Key relationships. Every Income and Expense is strictly linked to a Project.
- **Form Validations:** Client-side validations ensuring no income or expense can be added without selecting a related project.
- **Cascading Deletes:** Deleting a project automatically deletes all its associated incomes and expenses to maintain data integrity.
- **Responsive UI:** Fully responsive tables and modals, adapting seamlessly from mobile to desktop.

### 🔴 Phase 3: Analytics, Invoices & Advanced Security

#### 1. 📊 Finance Dashboard Analytics
- Dynamic stat cards displaying: Total Projects, Total Income, Total Expenses, Net Profit/Loss, Monthly Revenue, Monthly Expenses, Active Projects, and Completed Projects.
- **Interactive Charts:** 
  - Monthly Income vs Expense (Bar Chart)
  - Expense by Category (Pie Chart)
- Real-time data fetching with global visibility (Admins see company-wide data, Users see read-only analytics).

#### 2. 🧾 Invoice Management Module
- Complete CRUD operations for invoices.
- **Auto-Generated Invoice Numbers** for professional tracking.
- Link invoices directly to specific Projects.
- **Invoice Status Tracking:** Draft, Pending, Paid, Overdue.
- **PDF Generation:** Enterprise-level, beautifully formatted PDF invoices downloadable with a single click.

#### 3. 🔄 Transaction History
- Centralized Transactions page displaying both Income and Expense records in one unified table.
- Displays: Transaction Type, Project, Amount, Date, and Category.
- **Advanced Search & Filters:** Filter by transaction type or search by title/category.
- **Pagination:** Clean pagination for large datasets.

#### 4. 📈 Reports Module
- Generate professional financial reports based on:
  - Monthly, Yearly, and Project-wise parameters.
  - Specific Income or Expense reports.
  - Overall Profit/Loss summaries.
- **Export Capabilities:** Download reports as **PDF** or **Excel (CSV)**.

#### 5. 📝 Audit Log
- Comprehensive tracking of system activities (Logins, CRUD operations on Projects, Incomes, Expenses, and User updates).
- Displays: User Email, Action Performed, Module, and Date/Time.

#### 6. 🔐 Advanced Security (RBAC)
- **Role-Based Access Control (RBAC):** Granular permissions system.
- **Dynamic Roles:** Admin, HOD, Program Manager, Project Manager, User.
- **Granular Permissions:** Admin can assign specific rights (e.g., "Can Create Project", "Can Add Income") to any user.
- **View-Only Access:** Normal users can view global data (dashboards, invoices, reports) but cannot edit or delete unless explicitly permitted.
- **Supabase Row Level Security (RLS):** Enterprise-grade database policies ensuring users can only modify their own created data, while securely allowing global read access.
- **Secure Route Guards:** Frontend layout blocks unauthorized access to sensitive modules (like Admin Panel).

---

## 🗄️ Database Schema (Supabase PostgreSQL)

The system uses a scalable relational database structure:

- `profiles`: Stores user details, roles (Admin, HOD, PM, User), and granular boolean permissions.
- `projects`: Stores project details (name, client, status, dates). Linked to `auth.users`.
- `incomes`: Stores income data. Contains a `project_id` Foreign Key linked to `projects`.
- `expenses`: Stores expense data. Contains a `project_id` Foreign Key linked to `projects`.
- `invoices`: Stores invoice data, auto-generated numbers, statuses, and client details.
- `audit_logs`: Tracks all critical system actions.
- `notifications`: Stores alerts for users (e.g., large expenses, due invoices).

**Security:** Row Level Security (RLS) is strictly enabled on all tables to ensure data privacy and integrity.

---

## 🛠️ Getting Started

### Prerequisites
- Node.js (v18 or higher)
- A Supabase account and project

### 1. Clone the repository
```bash
git clone https://github.com/Javeria-5091/Finance-Management-System.git
cd Finance-Management-System
```

### 2. Install dependencies
```bash
npm install
```

### 3. Set up Environment Variables
Create a `.env.local` file in the root directory and add your Supabase credentials:
```env
NEXT_PUBLIC_SUPABASE_URL=your_supabase_url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_supabase_anon_key
```

### 4. Set up Supabase Database
Go to your Supabase SQL Editor and run the required SQL queries to create the tables (`profiles`, `projects`, `incomes`, `expenses`, `invoices`, `audit_logs`), set up RLS policies, and create the `is_admin()` function for secure role checking.

### 5. Run the development server
```bash
npm run dev
```
Open [http://localhost:3000] to view the app.

---

## 🏗️ System Architecture & Security Logic

- **Global Read Access:** Through advanced RLS policies, all authenticated users can view the entire company's financial data (Income, Expenses, Projects) to generate accurate analytics and reports.
- **Strict Write Access:** Users can only INSERT, UPDATE, or DELETE records that belong to them (`auth.uid() = user_id`), unless they are an Admin.
- **Admin Override:** Users with the `Admin` role in the `profiles` table bypass standard write restrictions to manage all system data safely.

---

## 📄 License

This project is proprietary. All rights reserved.


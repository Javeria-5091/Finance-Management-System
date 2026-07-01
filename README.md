Osystic Finance Management System
A modern, full-stack financial management application built to track projects, incomes, and expenses efficiently. Developed using Next.js, TypeScript, Tailwind CSS, and Supabase.

🚀 Tech Stack
Frontend: Next.js 14 (App Router), TypeScript, Tailwind CSS
Backend/Database: Supabase (PostgreSQL)
Authentication: Supabase Auth (Email/Password)
Icons: Lucide React
✨ Features
Phase 1: Foundation & Income
Authentication System: Secure Login, Signup, and Logout functionality.
Protected Routes: Dashboard and sub-routes are protected, redirecting unauthenticated users to the login page.
Dashboard Layout: A clean, responsive layout featuring a collapsible Sidebar and a Top Navbar.
Income Management: Full CRUD (Create, Read, Update, Delete) operations for income records.
Phase 2: Projects, Expenses & Relations
Project Management: Create, edit, and delete client projects. Track client name, status (Active, On Hold, Completed), and start/end dates.
Expense Management: Full CRUD operations for tracking outgoing money.
Relational Database Design: Implemented robust Foreign Key relationships. Every Income and Expense is strictly linked to a Project.
Form Validations: Client-side validations ensuring no income or expense can be added without selecting a related project.
Cascading Deletes: Deleting a project automatically deletes all its associated incomes and expenses to maintain data integrity.
Responsive UI: Fully responsive tables and modals, adapting seamlessly from mobile to desktop.
🗄️ Database Schema (Supabase PostgreSQL)
The system uses a relational database structure:

projects: Stores project details (name, client, status, dates). Linked to auth.users.
incomes: Stores income data. Contains a project_id Foreign Key linked to projects.
expenses: Stores expense data. Contains a project_id Foreign Key linked to projects.
Security: Row Level Security (RLS) is enabled on all tables to ensure users can only access their own data.
🛠️ Getting Started
Prerequisites
Node.js (v18 or higher)
A Supabase account and project
1. Clone the repository
git clone https://github.com/Javeria-5091/Finance-Management-System osystic-finance
2. Install dependencies
bash

npm install
3. Set up Environment Variables
Create a .env.local file in the root directory and add your Supabase credentials:

env

NEXT_PUBLIC_SUPABASE_URL=your_supabase_url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_supabase_anon_key
4. Set up Supabase Database
Go to your Supabase SQL Editor and run the required SQL queries to create the projects, incomes, and expenses tables along with RLS policies and Foreign Key constraints.

5. Run the development server
bash

npm run dev
Open http://localhost:3000 to view the app.
Osystic Finance Management System
A modern, responsive web application built to track and manage personal finances, featuring secure authentication and a clean income management dashboard.

🛠 Tech Stack
Framework: Next.js 14 (App Router)
Language: TypeScript
Styling: Tailwind CSS
Database & Auth: Supabase (PostgreSQL + Row Level Security)
Icons: Lucide React
✨ Features
Authentication: Secure Signup, Login, and Logout using Supabase Auth.
Protected Routes: Dashboard and income pages are protected. Unauthenticated users are redirected to login.
Responsive Dashboard: Clean layout featuring a collapsible Sidebar and a Top Navbar.
Income Management (CRUD):
View all income entries in a clean data table.
Add new income with title, amount, category, and date.
Edit existing income entries.
Delete entries with a confirmation modal.
Database Security: Row Level Security (RLS) ensures users can only see and modify their own data.
🚀 Getting Started
Follow these steps to run this project locally:

1. Clone the repository
git clone https://github.com/TUMHARA-USERNAME/osystic-finance.gitcd osystic-finance
2. Install dependencies

npm install
3. Set up Supabase
Create a project on Supabase.
Go to the SQL Editor and run the SQL to create the incomes table and enable RLS policies.
Go to Project Settings > API to get your keys.
4. Environment Variables
Create a .env.local file in the root directory and add your Supabase credentials:

env

NEXT_PUBLIC_SUPABASE_URL=your_supabase_url_here
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_supabase_anon_key_here
5. Run the development server

npm run dev
Open http://localhost:3000 in your browser.
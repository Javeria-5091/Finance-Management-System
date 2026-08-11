> A full-stack financial management system **under active development**. Targeting mid-to-large enterprises with complete double-entry accounting — from income & expenses to journal entries, bank reconciliation, payroll, tax filing, and executive reporting.
>
> ⚠️ **Currently in development.** Not production-ready. Some modules may have bugs, incomplete features, or ongoing refactoring.

---

## ✨ Highlights

```text
  📊  18+ enterprise report types (P&L, Balance Sheet, Cash Flow, Trial Balance...)
  🧾  Complete double-entry GL with 5 server-side posting pipelines
  🏦  Bank reconciliation with auto-match, CSV import, duplicate detection
  🤖  AI financial assistant (Groq Llama 3.3 70B) with text-to-SQL
  👥  8 roles, 75+ permission codes, 3-tier resolution, maker-checker
  💰  Multi-currency (PKR, USD, EUR, GBP, AED) with FX rate management
  🔒  RLS, TOTP MFA, AI safety (SQL injection + prompt injection defense)
  📊  6 role-based dashboards with real-time polling (CEO → Employee)
  🧩  Modules: AR, AP, Banking, Fixed Assets, Tax, Payroll, Subscriptions, Contractors, Commissions
```

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Presentation                                           │
│  Next.js 16 · React 19 · Tailwind CSS · 38+ pages      │
├─────────────────────────────────────────────────────────┤
│  API Layer (29 routes)                                  │
│  Workflow Engine · GL Posting · Budget Gate · Admin      │
│  Payments · Notifications · AI Chat                     │
├─────────────────────────────────────────────────────────┤
│  Services (16 modules) + Hooks (12) + React Query 5     │
├─────────────────────────────────────────────────────────┤
│  Auth · Permissions (75+ codes) · Theme                  │
├─────────────────────────────────────────────────────────┤
│  Database — 5 schemas on PostgreSQL 17 via Supabase     │
│  core · finance · audit · reporting · ai                │
└─────────────────────────────────────────────────────────┘
```

---

## 🛠️ Tech Stack

| Category | Tech |
|----------|------|
| Framework | Next.js 16 (App Router) |
| Language | TypeScript 5 |
| UI | React 19, Tailwind CSS 3.4, Lucide Icons |
| Database | PostgreSQL 17 (Supabase) |
| Auth | Supabase Auth + TOTP MFA |
| Data Fetching | TanStack React Query 5 |
| Validation | Zod 4 |
| Charts | Chart.js 4, Three.js (3D) |
| AI | Vercel AI SDK 7 + Groq (Llama 3.3 70B) |
| SQL Safety | libpg-query |
| PDF Export | jsPDF + jspdf-autotable |
| Date | date-fns 4 |

---

## 📦 Modules

### 💰 Core Accounting

- **Chart of Accounts** — Hierarchical COA with 8 account types, posting controls
- **Journal Entries** — Multi-line DR/CR, full lifecycle (Draft → Posted), reversal support
- **General Ledger** — Running balances, drill-down by account & period
- **Trial Balance** — Comparative period support
- **Fiscal Calendar** — Auto-generated 12 periods/year, soft-close, hard-close, year-end P&L carry-forward
- **GL Posting Pipelines** — 5 server-side routes that auto-discover COA accounts, validate balance, and post:
  - `Invoice → DR Receivable / CR Revenue + Tax`
  - `Vendor Bill → DR Expense(s) / CR Payable + Withholding Tax`
  - `Credit Note → DR Revenue / CR Receivable`
  - `Payment Receipt → DR Bank / CR Receivable` (with auto-allocation)
  - `Payment Reversal → Exact GL swap + cascade to allocations & invoice status`

### 📥 Accounts Receivable

- Invoices with full lifecycle (Draft → Issued → Paid → Overdue → Void)
- Multi-line items, tax/discount, multi-currency, PDF generation
- Payment receipts with multi-invoice allocation & auto GL posting
- Payment reversal with full cascade
- Credit notes with GL posting
- AR aging by client (Current, 1-30, 31-60, 61-90, 90+ days)

### 📤 Accounts Payable

- Vendor master (NTN, tax registration, contact details)
- Vendor bills with line items, tax, withholding, approval limits
- Vendor payments with partial/full & dual approval
- AP aging by vendor

### 🏦 Banking

- 7 account types (Bank, Cash, Wallet, Platform, Gateway, Card, Clearing)
- CSV bank statement import
- Auto-reconciliation (auto-match, manual match, duplicate detection)
- Inter-account transfers with FX & dual approval

### 🏢 Fixed Assets

- Asset register with KPI cards (cost, NBV, accum. depreciation)
- Depreciation engine (generate per period, post to GL)
- Physical verification rounds

### 📊 Tax & Equity

- Taxpayer profile, configurable tax rules (progressive/flat/fixed slabs)
- Tax reconciliation (PBT → adjustments → filing → paid)
- Profit distribution to owners
- Ownership % with effective dating, reserve policies

### 👥 Payroll

- Employee directory, compensation management
- Payroll runs (gross → deductions → net pay)
- Advances, commission integration

### 📋 Other Modules

| Module | Key Features |
|--------|-------------|
| **Projects** | Auto-codes, profitability enrichment, safe closure with integrity checks |
| **Clients (CRM)** | Multi-currency, tax registration, payment terms, AR aging per client |
| **Budgets** | Line-level GL mapping, server-side 4-level validation gate (OK/CAUTION/WARNING/BLOCKED) |
| **Contractors** | Role-based costs, contract expiration tracking, cost analytics |
| **Commissions** | Percentage/fixed/flat+variable, per-person & per-project breakdowns |
| **Subscriptions** | Recurring cost tracking, annualized cost, renewal alerts (7d/30d/overdue) |
| **Notifications** | 8 types, 4 priorities, entity binding, deep-links, workflow integration |

---

## 🤖 AI Financial Assistant

| Feature | Detail |
|---------|--------|
| Model | Groq Llama 3.3 70B |
| Capabilities | Cash position, project profitability, tax summary, ad-hoc text-to-SQL |
| Safety | `libpg-query` parsing, SELECT-only, org-scoped, prompt injection detection |
| Rate Limit | 100 queries/day, $1.50/day per org |
| Audit | Full conversation history, tool calls, query audit, user feedback |

---

## 📊 Reports (18+ types, 12 groups)

| Group | Reports |
|-------|---------|
| Financial Statements | P&L, Balance Sheet, Cash Flow, SOCE |
| General Ledger | Running balances, search, pagination |
| Trial Balance | Comparative periods |
| Aging | AR/AP by client/vendor |
| Project Profitability | Revenue, costs, margins, budget vs actual |
| Cash & Bank | Balances, reconciliation status, transfers |
| Budget Variance | Original/revised/committed/actual/forecast |
| Ownership & Equity | Capital, reserves, retained earnings, distributions |
| Platform Settlements | Gross, fees, effective rate, net payout |
| Tax | PBT, reconciliation, estimated tax, filing status |
| Fiscal Close | Period status, close checklist, year-end |
| Controls & Audit | Approval aging, policy exceptions, AI activity |

All reports support **PDF & CSV export** with permission gating and audit logging.

---

## 🎯 Role-Based Dashboards

| Dashboard | For | Shows |
|-----------|-----|-------|
| **CEO** | Chief Executive | Revenue, expenses, profit, cash, AR/AP aging, project profitability, budget vs actual, pending approvals, AI chat |
| **CFO** | Finance Head | Financial KPIs, revenue/expense trends, cash flow |
| **Accountant** | Accountant | Pending transactions, journal entries, period status |
| **PM** | Project Manager | Project profitability, budget utilization |
| **Viewer** | Read-Only | Summary view |
| **Employee** | Employee | Personal view |

---

## ⚙️ Workflow Engine

All documents go through a centralized server-side workflow:

```
Draft → Submitted → Verified → Approved → Posted
                                   ↘ Rejected
                ↘ Reversed ↗
```

- **Maker-Checker** — Creator cannot approve own work
- **Approval Limits** — CEO: ∞ · CFO: 500K · Accountant: 100K · HOD: 50K · PM: 25K (PKR)
- **Modules** — Expense, Income, Invoice, Vendor Bill, Journal Entry, Budget
- **Audit** — Every transition logged with user, timestamp, action, reason

---

## 🔐 Security

```
✓ Row Level Security (RLS) on all tables
✓ 75+ granular permission codes with 3-tier resolution
✓ 8 roles with effective dating & scope (ALL/DEPT/PROJECT/OWN)
✓ CEO uniqueness enforcement (only one active CEO)
✓ TOTP MFA (enroll, verify, unenroll)
✓ AI isolation (SELECT-only SQL, org-scoped, rate-limited)
✓ 27-column audit trail with tamper-detection hashing
✓ Protected field stripping on all update endpoints
✓ Referential integrity guards on delete/close
✓ Server-side budget validation gate
```

---

## 🗄️ Database

5-schema architecture on PostgreSQL 17:

| Schema | Purpose |
|--------|---------|
| `core` | Org config, roles, permissions, notifications, numbering, exchange rates, platform fees |
| `finance` | All financial transactions (40+ tables) |
| `audit` | Immutable audit trail |
| `reporting` | Read-only views (P&L, BS, CF, aging, profitability) |
| `ai` | Conversations, tool calls, query audit, feedback |

4 Supabase client instances: `supabase` (public) · `financeDB` · `auditDB` · `reportingDB`

---

## 📁 Project Structure

```
src/
├── app/
│   ├── api/              # 29 API routes
│   │   ├── admin/        # Users, exchange rates, numbering, platform fees
│   │   ├── ai/           # Chat, conversations, feedback
│   │   ├── auth/mfa/     # TOTP MFA
│   │   ├── chat/         # AI endpoint
│   │   ├── clients/      # Client CRUD
│   │   ├── finance/      # GL posting (5 routes), workflow, budget-check,
│   │   │                 # credit-notes, payment-receipts, allocations, reversals
│   │   ├── notifications/# Notification system
│   │   └── projects/     # Project CRUD
│   ├── dashboard/        # 38+ pages across 20 modules
│   ├── login/  signup/
│   └── layout.tsx
├── components/           # AI, banking, dashboards (6), finance, reports, UI
├── context/              # Auth, Permission (75+ codes), Theme
├── hooks/                # 12 custom hooks
├── lib/                  # Supabase clients (4), workflow, validation, MFA, audit
├── providers/            # React Query
├── services/             # 16 service modules
└── types/                # 12 type definition files

supabase/
├── config.toml
├── functions/            # Edge: historical data migration
└── migrations/
    ├── P0/               # Phases 1-9 (~30 files)
    └── P1/               # Extended (~10 files)

scripts/                  # backup-restore.sh
```

---

## 🚀 Quick Start

### Prerequisites

- Node.js 18+
- Supabase account (PostgreSQL 17)
- Groq API key (for AI features)

### Setup

```bash
# 1. Clone
https://github.com/Javeria-5091/Finance-Management-System.git
```

```bash
# 2. Install
npm install
```

```bash
# 3. Environment — create .env.local

NEXT_PUBLIC_SUPABASE_URL=your_supabase_url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_supabase_anon_key
GROQ_API_KEY=your_groq_key                    # optional, for AI
GOOGLE_GENERATIVE_AI_API_KEY=your_gemini_key  # optional, AI fallback
```

```bash
# 4. Database — run migrations in order via Supabase SQL Editor

# P0: Foundation → Double-Entry → Permissions → AR → AP → Banking → Tax → Reports → Dashboards
# P1: Fixed Assets → Payroll → Subscriptions → Contractors → Commissions → AI
# See full migration order below ↓
```

```bash
# 5. Run
npm run dev
# → http://localhost:3000
```

---

## 📋 Migration Order

```
P0 — Core
  Phase 1: Foundation     → schemas, org config, COA, fiscal years, audit, numbering
  Phase 2: Double-Entry  → journal entries, GL views, posting engine
  Phase 3: Permissions   → roles, 75+ permission codes, seed data
  Phase 4: AR & Currency → invoices, AR tables, aging, multi-currency
  Phase 5: AP & Vendors  → vendor master, vendor bills, AP posting
  Phase 6: Bank Recon    → financial accounts, statements, transfers, reconciliation
  Phase 7: Tax & Equity  → tax config, ownership, reserves
  Phase 8: Reports       → P&L, BS, CF, project profitability views
  Phase 9: Dashboards    → CEO KPIs
  Cross-cutting: maker-checker, platform fees, bug fixes

P1 — Extended
  Fixed Assets & Depreciation → Payroll → Subscriptions → Contractors → Commissions → AI
```

> ⚠️ Run P0 first, then P1. All via Supabase SQL Editor or CLI.

---

## 🛡️ Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `NEXT_PUBLIC_SUPABASE_URL` | ✅ | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | ✅ | Supabase anonymous key |
| `GROQ_API_KEY` | AI | Groq API key |
| `GOOGLE_GENERATIVE_AI_API_KEY` | AI | Google Gemini (fallback) |

---

## 🔧 Tools

| Script | Purpose |
|--------|---------|
| `scripts/backup-restore.sh backup` | DB backup (schema + data) |
| `scripts/backup-restore.sh restore <file>` | Restore with auto pre-backup + SHA256 verify |
| `scripts/backup-restore.sh verify` | Post-restore integrity check |
| `supabase/functions/data-processing/` | Edge function: migrate legacy income/expenses → GL journal entries |

---

## 📄 License

This project is proprietary. All rights reserved.
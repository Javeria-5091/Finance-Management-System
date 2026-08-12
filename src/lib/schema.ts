
// ============================================================
// OSYSTIC FINANCE MANAGEMENT SYSTEM — COMPLETE DATABASE SCHEMA
// Version 1.3 | Aligned with Implementation Specification v1.3//
//  Generated from actual schema.sql (69 tables, 6 schemas)// 
// ============================================================//
// SCHEMAS: core | finance | public | audit | ai | reporting (views)//
// USAGE: This file is the AI reference schema for text-to-SQL.// 
// Every table, column, type, constraint, and relationship is listed.// 
// For type definitions, see src/types/*.ts files.//
// ============================================================// 
// IMPORTANT NAMING CONVENTIONS//
// ============================================================// 
// - Database columns: snake_case
// - TypeScript types: PascalCase interfaces, camelCase fields//
// - Enums: UPPER_SNAKE_CASE in DB, PascalCase in TS// 
// - JSONB columns: marked with [JSONB]// 
// - Generated columns: marked with [GENERATED]// 
// - Views: listed separately in each schema section// 
// ============================================================
// export const DATABASE_SCHEMA = `
// -- ============================================================
// -- PART 1: CORE SCHEMA (Identity, Authorization, Organization)
// ============================================================
// -- Tables: organizations, organization_config, roles, permissions,
// --          role_permissions, user_roles-- 
// ============================================================
// -- SCHEMA: core
// -- ============================================================
// -- 1.1 organizations-- Purpose: Company/legal entity master record
// -- Organization-configurable, supports multi-org future
// -- ============================================================
// CREATE TABLE core.organizations (    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),    name            VARCHAR(100) NOT NULL,    legal_name      VARCHAR(200),    type            VARCHAR(50) NOT NULL DEFAULT 'COMPANY'        
// -- COMPANY | SOLE_PROPRIETOR | PARTNERSHIP | AOP | OTHER,    tax_registration VARCHAR(100),    ntn             VARCHAR(50),    base_currency   VARCHAR(3) NOT NULL DEFAULT 'PKR',    timezone        VARCHAR(50) DEFAULT 'Asia/Karachi',    date_format     VARCHAR(20),    number_format   VARCHAR(20),    fiscal_year_start_month INTEGER NOT NULL DEFAULT 7,    
// -- July for Pakistan (Jul-Jun fiscal year)    is_active       BOOLEAN NOT NULL DEFAULT true,    address         TEXT,    city            VARCHAR(100),    country         VARCHAR(100) DEFAULT 'Pakistan',    phone           VARCHAR(50),    email           VARCHAR(255),    website         VARCHAR(500),    logo_url        TEXT,    config          JSONB,  
// -- [JSONB] extensible organization configuration    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),    updated_at      TIMESTAMPTZ);
// -- 1.2 organization_config
// -- Purpose: Active organization runtime configuration singleton
// -- Fetched by apps for base_currency, timezone, formats, precision
// -- ============================================================
// CREATE TABLE core.organization_config (    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),    org_name                VARCHAR(200) NOT NULL,    base_currency           VARCHAR(3) NOT NULL DEFAULT 'PKR',    enabled_currencies      TEXT[] NOT NULL DEFAULT '{PKR,USD}',    timezone                VARCHAR(50) NOT NULL DEFAULT 'Asia/Karachi',    date_format             VARCHAR(20) NOT NULL DEFAULT 'DD/MM/YYYY',    number_format           VARCHAR(20) NOT NULL DEFAULT 'en-PK',    fiscal_year_start_month INTEGER NOT NULL DEFAULT 7,    fiscal_year_end_month   INTEGER NOT NULL DEFAULT 6,    decimal_precision       INTEGER NOT NULL DEFAULT 2,    rounding_method         VARCHAR(20) NOT NULL DEFAULT 'HALF_UP'        
// -- HALF_UP | HALF_DOWN | CEILING | FLOOR | UP | DOWN,    logo_url                TEXT,    active                  BOOLEAN NOT NULL DEFAULT true,    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),    updated_at              TIMESTAMPTZ);
// -- 1.3 roles
// -- Purpose: Configurable RBAC roles with hierarchy level
// -- System roles cannot be deleted
// -- ============================================================
// CREATE TABLE core.roles (    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),    name          VARCHAR(100) NOT NULL UNIQUE,  
// -- CEO, FINANCE_HEAD, ACCOUNTANT, AUDITOR, HOD, PROJECT_MANAGER, TECHNICAL_ADMIN, EMPLOYEE, VIEWER    display_name  VARCHAR(200) NOT NULL,    description   TEXT,    is_system     BOOLEAN NOT NULL DEFAULT false,  
// -- system_role flag: prevents deletion    level         INTEGER NOT NULL DEFAULT 0, 
//  -- hierarchy: CEO=100, FINANCE_HEAD=80, ACCOUNTANT=60, AUDITOR=55, HOD=40, PM=20, TECH_ADMIN=15, EMPLOYEE=10, VIEWER=0    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),    updated_at    TIMESTAMPTZ);
// -- 1.4 permissions-- Purpose: Atomic permission definitions
// -- Each row = one action on one resource
// -- ============================================================
// CREATE TABLE core.permissions (    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),    code        VARCHAR(200) NOT NULL UNIQUE,  
// -- e.g. 'expenses.create', 'invoices.approve', 'journals.post'    name        VARCHAR(200) NOT NULL,    module      VARCHAR(50) NOT NULL,  
// -- expenses, invoices, journals, reports, etc.    action      VARCHAR(50) NOT NULL,  
// -- create, read, update, delete, approve, post, export, etc.    description TEXT,    is_system   BOOLEAN NOT NULL DEFAULT false,  
// -- sensitive flag for system-level permissions    created_at  TIMESTAMPTZ NOT NULL DEFAULT now());
// -- 1.5 role_permissions
// -- Purpose: Grants permissions to roles with data scope and amount limits
// -- ============================================================
// CREATE TABLE core.role_permissions (    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),    role_id       UUID NOT NULL REFERENCES core.roles(id) ON DELETE CASCADE,    permission_id UUID NOT NULL REFERENCES core.permissions(id) ON DELETE CASCADE,    data_scope    VARCHAR(20) NOT NULL DEFAULT 'ALL'        
// -- OWN | DEPARTMENT | PROJECT | ALL,    amount_limit  NUMERIC(18,2),  
// -- max_amount for approval authority (NULL = unlimited)    effective_from TIMESTAMPTZ NOT NULL DEFAULT now(),    effective_to   TIMESTAMPTZ,  
// -- NULL = no expiry    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),    UNIQUE(role_id, permission_id));
// -- 1.6 user_roles
// -- Purpose: Effective-dated user-role assignments
// -- Supports delegation (delegated_from) and activation
// -- ============================================================
// CREATE TABLE core.user_roles (    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),    user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,    role_id         UUID NOT NULL REFERENCES core.roles(id) ON DELETE CASCADE,    effective_from  TIMESTAMPTZ NOT NULL DEFAULT now(),    effective_to    TIMESTAMPTZ,  
// -- NULL = no expiry    delegated_from  UUID REFERENCES auth.users(id),  
// -- temporary approval delegation    is_active       BOOLEAN NOT NULL DEFAULT true,    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),    UNIQUE(user_id, role_id, effective_from));
// -- ============================================================
// -- PART 2: FINANCE SCHEMA (Core Accounting Engine)
// -- ============================================================
// -- Tables: chart_of_accounts, fiscal_years, accounting_periods,
// --          journal_entries, journal_lines, financial_accounts,
// --          exchange_rates, platforms, fee_rules, fee_tiers,
// --          fee_computation_log,
// --          vendors, vendor_bills, vendor_bill_lines,
// --          vendor_payments, vendor_payment_allocations,
// --          payment_receipts, payment_allocations, credit_notes,
// --          invoices (via public view),
// --          budgets, budget_lines,
// --          tax tables, ownership tables,
// --          fixed assets, depreciation, bank statements,
// --          attachments, numbering_sequences, opening_balance_imports
// -- ============================================================
// -- SCHEMA: finance
// -- ============================================================
// -- 2.1 chart_of_accounts
// -- Purpose: Ledger account master (Chart of Accounts)
// -- Hierarchical via parent_id; supports control accounts
// -- ============================================================
// CREATE TABLE finance.chart_of_accounts (    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),    code                VARCHAR(50) NOT NULL UNIQUE,    name                VARCHAR(200) NOT NULL,    parent_id           UUID REFERENCES finance.chart_of_accounts(id),    account_type        VARCHAR(50) NOT NULL        
// -- ASSET | LIABILITY | EQUITY | REVENUE | COST_OF_SALES | OPERATING_EXPENSE | OTHER_INCOME | OTHER_EXPENSE,    normal_balance      VARCHAR(10) NOT NULL  
// -- DEBIT | CREDIT,    currency            VARCHAR(3) NOT NULL DEFAULT 'PKR',    is_active           BOOLEAN NOT NULL DEFAULT true,    posting_allowed      BOOLEAN NOT NULL DEFAULT true,    is_control_account  BOOLEAN NOT NULL DEFAULT false,  
// -- e.g., AR Control, AP Control    report_mapping      VARCHAR(50),  
// -- maps to P&L/BS line items for auto-report generation    description         TEXT,    display_order       INTEGER NOT NULL DEFAULT 0,    level               INTEGER NOT NULL DEFAULT 0,  
// -- 0=root, 1=group, 2+=detail    created_by          UUID REFERENCES auth.users(id),    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),    updated_at          TIMESTAMPTZ);
// -- 2.2 fiscal_years
// -- Purpose: Fiscal-year lifecycle management
// -- Status: OPEN -> SOFT_CLOSED -> HARD_CLOSED
// -- Transition-year flag for custom date ranges
// -- ============================================================
// CREATE TABLE finance.fiscal_years (    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),    name              VARCHAR(100) NOT NULL,  
// -- e.g. 
-- ==========================================
-- 1. EXTENSIONS & UTILITIES
-- ==========================================
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION public.update_updated_at()
RETURNS TRIGGER AS $$ BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ==========================================
-- 2. TABLES
-- ==========================================

CREATE TABLE IF NOT EXISTS public.projects (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
    name VARCHAR(255) NOT NULL,
    client_name VARCHAR(255) NOT NULL,
    description TEXT,
    status VARCHAR(50) DEFAULT 'Active' CHECK (status IN ('Active', 'Completed', 'On Hold')),
    start_date DATE NOT NULL,
    end_date DATE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.incomes (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
    title VARCHAR(255) NOT NULL,
    amount DECIMAL(12,2) NOT NULL,
    category VARCHAR(100) NOT NULL,
    description TEXT,
    income_date DATE NOT NULL DEFAULT CURRENT_DATE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    project_id UUID REFERENCES public.projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public.expenses (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
    project_id UUID REFERENCES public.projects(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    amount DECIMAL(12,2) NOT NULL,
    category VARCHAR(100) NOT NULL,
    expense_date DATE NOT NULL DEFAULT CURRENT_DATE,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.invoices (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
    project_id UUID REFERENCES public.projects(id) ON DELETE SET NULL,
    invoice_number VARCHAR(50) NOT NULL,
    client_name VARCHAR(255) NOT NULL,
    amount DECIMAL(12,2) NOT NULL,
    status VARCHAR(50) DEFAULT 'Draft' CHECK (status IN ('Draft', 'Pending', 'Paid', 'Overdue')),
    issue_date DATE NOT NULL DEFAULT CURRENT_DATE,
    due_date DATE NOT NULL,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.profiles (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL UNIQUE,
    full_name TEXT DEFAULT '',
    role TEXT NOT NULL DEFAULT 'User' CHECK (role IN ('Admin', 'HOD', 'Program Manager', 'Project Manager', 'User')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    email TEXT DEFAULT '',
    can_create_project BOOLEAN DEFAULT FALSE,
    can_delete_project BOOLEAN DEFAULT FALSE,
    can_add_income BOOLEAN DEFAULT FALSE,
    can_add_expense BOOLEAN DEFAULT FALSE,
    can_create_invoice BOOLEAN DEFAULT FALSE,
    can_delete_invoice BOOLEAN DEFAULT FALSE,
    can_edit_project BOOLEAN DEFAULT FALSE,
    can_edit_income BOOLEAN DEFAULT FALSE,
    can_edit_expense BOOLEAN DEFAULT FALSE,
    can_edit_invoice BOOLEAN DEFAULT FALSE,
    can_delete_income BOOLEAN DEFAULT FALSE,
    can_delete_expense BOOLEAN DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS public.audit_logs (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    action VARCHAR(100) NOT NULL,
    module VARCHAR(50) NOT NULL,
    details TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.notifications (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
    title VARCHAR(255) NOT NULL,
    message TEXT NOT NULL,
    is_read BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ==========================================
-- 3. TRIGGERS
-- ==========================================

DROP TRIGGER IF EXISTS incomes_updated_at ON public.incomes;
CREATE TRIGGER incomes_updated_at
    BEFORE UPDATE ON public.incomes
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$ BEGIN
    INSERT INTO public.profiles (
        user_id, full_name, role, email,
        can_create_project, can_edit_project, can_delete_project,
        can_add_income, can_edit_income, can_delete_income,
        can_add_expense, can_edit_expense, can_delete_expense,
        can_create_invoice, can_edit_invoice, can_delete_invoice
    )
    VALUES (
        NEW.id,
        COALESCE((NEW.raw_user_meta_data::jsonb)->>'full_name', ''),
        'User',
        NEW.email,
        FALSE, FALSE, FALSE, -- Projects
        FALSE, FALSE, FALSE, -- Income
        FALSE, FALSE, FALSE, -- Expense
        FALSE, FALSE, FALSE  -- Invoices
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_new_user();

-- Existing users ke liye email backfill (one-time, doc1 mein tha)
UPDATE public.profiles p
SET email = u.email
FROM auth.users u
WHERE p.user_id = u.id;

-- ==========================================
-- 4. SECURITY / RBAC FUNCTIONS
-- ==========================================

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN
LANGUAGE plpgsql STABLE SECURITY DEFINER
AS $$
DECLARE
    user_role TEXT;
BEGIN
    SELECT role INTO user_role
    FROM public.profiles
    WHERE user_id = auth.uid();

    RETURN COALESCE(user_role, 'User') = 'Admin';
END;
$$;

CREATE OR REPLACE FUNCTION public.create_user_by_admin(
  p_email TEXT,
  p_password TEXT,
  p_role TEXT DEFAULT 'User',
  p_full_name TEXT DEFAULT ''
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_new_user_id UUID;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE user_id = auth.uid() AND role = 'Admin'
  ) THEN
    RETURN json_build_object('error', 'Only admins can create users')::JSON;
  END IF;

  INSERT INTO auth.users (
    instance_id, id, email, encrypted_password, email_confirmed_at,
    raw_user_meta_data, created_at, updated_at, aud, role,
    confirmation_token, recovery_token, email_change_token_new, email_change, invited_at
  ) VALUES (
    '00000000-0000-0000-0000-000000000000',
    gen_random_uuid(),
    p_email,
    crypt(p_password, gen_salt('bf')),
    NOW(),
    jsonb_build_object('full_name', p_full_name),
    NOW(), NOW(),
    'authenticated', 'authenticated',
    '', '', '', '', NULL
  )
  RETURNING id INTO v_new_user_id;

  INSERT INTO public.profiles (user_id, email, full_name, role)
  VALUES (v_new_user_id, p_email, p_full_name, p_role);

  RETURN json_build_object('success', true, 'message', 'User created successfully')::JSON;

EXCEPTION
  WHEN unique_violation THEN
    RETURN json_build_object('error', 'User with this email already exists')::JSON;
  WHEN OTHERS THEN
    RETURN json_build_object('error', SQLERRM)::JSON;
END;
$$;

-- ==========================================
-- 5. PERFORMANCE INDEXES
-- ==========================================

CREATE INDEX IF NOT EXISTS idx_incomes_user_id ON incomes(user_id);
CREATE INDEX IF NOT EXISTS idx_incomes_project_id ON incomes(project_id);
CREATE INDEX IF NOT EXISTS idx_incomes_date ON incomes(income_date DESC);

CREATE INDEX IF NOT EXISTS idx_expenses_user_id ON expenses(user_id);
CREATE INDEX IF NOT EXISTS idx_expenses_project_id ON expenses(project_id);
CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(expense_date DESC);

CREATE INDEX IF NOT EXISTS idx_projects_user_id ON projects(user_id);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);

CREATE INDEX IF NOT EXISTS idx_invoices_user_id ON invoices(user_id);
CREATE INDEX IF NOT EXISTS idx_invoices_project_id ON invoices(project_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
CREATE INDEX IF NOT EXISTS idx_invoices_due_date ON invoices(due_date);

CREATE INDEX IF NOT EXISTS idx_profiles_user_id ON public.profiles(user_id);
CREATE INDEX IF NOT EXISTS idx_profiles_role ON public.profiles(role);

-- ==========================================
-- 6. ROW LEVEL SECURITY - FINAL POLICIES
-- ==========================================

ALTER TABLE incomes ENABLE ROW LEVEL SECURITY;
ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

-- INCOMES: sab authenticated dekh sakte hain, write sirf apni ya admin
CREATE POLICY "incomes_select" ON incomes FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "incomes_insert" ON incomes FOR INSERT WITH CHECK (auth.uid() = user_id OR public.is_admin());
CREATE POLICY "incomes_update" ON incomes FOR UPDATE USING (auth.uid() = user_id OR public.is_admin());
CREATE POLICY "incomes_delete" ON incomes FOR DELETE USING (auth.uid() = user_id OR public.is_admin());

-- EXPENSES: sab authenticated dekh sakte hain, write sirf apni ya admin
CREATE POLICY "expenses_select" ON expenses FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "expenses_insert" ON expenses FOR INSERT WITH CHECK (auth.uid() = user_id OR public.is_admin());
CREATE POLICY "expenses_update" ON expenses FOR UPDATE USING (auth.uid() = user_id OR public.is_admin());
CREATE POLICY "expenses_delete" ON expenses FOR DELETE USING (auth.uid() = user_id OR public.is_admin());

-- PROJECTS: sab authenticated dekh sakte hain, modify sirf apna ya admin
CREATE POLICY "projects_select" ON projects FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "projects_modify" ON projects FOR ALL USING (auth.uid() = user_id OR public.is_admin());

-- INVOICES: sab authenticated dekh sakte hain, modify sirf apna ya admin
CREATE POLICY "invoices_select" ON invoices FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "invoices_modify" ON invoices FOR ALL USING (auth.uid() = user_id OR public.is_admin());

-- PROFILES: apna profile ya admin sab dekh/modify kar sakta hai
CREATE POLICY "profiles_select" ON public.profiles FOR SELECT USING (auth.uid() = user_id OR public.is_admin());
CREATE POLICY "profiles_modify" ON public.profiles FOR ALL USING (auth.uid() = user_id OR public.is_admin());

-- AUDIT_LOGS: (KABHI update nahi hui doc1 mein - sirf apna record view/insert, koi admin override nahi)
CREATE POLICY "Users see own logs" ON audit_logs FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users insert own logs" ON audit_logs FOR INSERT WITH CHECK (auth.uid() = user_id);

-- NOTIFICATIONS: (KABHI update nahi hui doc1 mein - sirf apna, koi admin override nahi)
CREATE POLICY "Users manage own notifications" ON notifications FOR ALL USING (auth.uid() = user_id);

-- ==========================================
-- 1. BUDGETS TABLE
-- ==========================================
CREATE TABLE IF NOT EXISTS budgets (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  total_amount DECIMAL(12,2) NOT NULL CHECK (total_amount >= 0),
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE budgets ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone authenticated can view budgets" ON budgets FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "Admin can manage budgets" ON budgets FOR ALL USING (public.is_admin());
CREATE POLICY "Users with permission can manage budgets" ON budgets FOR ALL USING (auth.uid() = user_id);

-- ==========================================
-- 2. PAYMENTS TABLE
-- ==========================================
CREATE TABLE IF NOT EXISTS payments (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  invoice_id UUID REFERENCES invoices(id) ON DELETE SET NULL,
  project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
  amount DECIMAL(12,2) NOT NULL CHECK (amount >= 0),
  payment_date DATE NOT NULL DEFAULT CURRENT_DATE,
  payment_method TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending', 'Paid', 'Partial Payment', 'Overdue')),
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone authenticated can view payments" ON payments FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "Admin can manage payments" ON payments FOR ALL USING (public.is_admin());
CREATE POLICY "Users with permission can manage payments" ON payments FOR ALL USING (auth.uid() = user_id);

-- ==========================================
-- 3. LINK BUDGET TO PROJECTS
-- ==========================================
ALTER TABLE projects ADD COLUMN IF NOT EXISTS budget_id UUID REFERENCES budgets(id) ON DELETE SET NULL;

-- ==========================================
-- 4. UPDATE PROFILES PERMISSIONS (Optional but good)
-- ==========================================
-- Agar budget permission add karni ho toh yeh run karo (warna skip karo)
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS can_manage_budgets BOOLEAN DEFAULT FALSE;

-- This function allows the AI to run raw SQL queries safely
CREATE OR REPLACE FUNCTION execute_sql_query(query_string TEXT)
RETURNS JSON AS $$ 
DECLARE
  result JSON;
  lower_query TEXT;
BEGIN
  lower_query := LOWER(TRIM(query_string));
  
  -- Allow SELECT and WITH (CTE)
  IF NOT (
    LEFT(lower_query, 6) = 'select' 
    OR LEFT(lower_query, 4) = 'with'
  ) THEN
    RAISE EXCEPTION 'Only SELECT queries are allowed';
  END IF;

  -- Block dangerous operations (word boundaries)
  IF lower_query ~* '\b(DROP|DELETE|UPDATE|INSERT|ALTER|CREATE|TRUNCATE|GRANT|REVOKE)\b' THEN
    RAISE EXCEPTION 'Dangerous operation not allowed';
  END IF;

  -- Execute with error handling
  BEGIN
    EXECUTE format('SELECT json_agg(t) FROM (%s) t', query_string) INTO result;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'SQL Error: %', SQLERRM;
  END;
  
  RETURN COALESCE(result, '[]'::JSON);
END;
 $$ LANGUAGE plpgsql SECURITY DEFINER; 

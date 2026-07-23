import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

// Default client (public schema)
export const supabase = createClient(supabaseUrl, supabaseAnonKey);

export const financeDB = createClient(supabaseUrl, supabaseAnonKey, {
  db: {
    schema: 'finance',
  },
});

// Audit schema client
export const auditDB = createClient(supabaseUrl, supabaseAnonKey, {
  db: {
    schema: 'audit',
  },
});

// Reporting schema client (views — read only)
export const reportingDB = createClient(supabaseUrl, supabaseAnonKey, {
  db: {
    schema: 'reporting',
  },
});
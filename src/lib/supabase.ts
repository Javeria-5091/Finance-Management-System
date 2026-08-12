import { createClient } from '@supabase/supabase-js';
import { createServerClient, createBrowserClient } from '@supabase/ssr';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

// ═════════════════════════════════════════════════════════════════════
// CLIENT-SIDE ONLY: For browser/client components
// This uses an anon key — use only in client components.
// NEVER USE THIS CLIENT IN API ROUTES.
//
// FIX: Uses createBrowserClient (@supabase/ssr) so that cookies
// sync properly with the middleware's createServerClient.
// The old createClient() set cookies that the middleware could not read.
// ═════════════════════════════════════════════════════════════════════
export const supabase = createBrowserClient(supabaseUrl, supabaseAnonKey);

// Client-side finance schema
export const financeDB = createBrowserClient(supabaseUrl, supabaseAnonKey, {
  db: { schema: 'finance' },
});

// Client-side audit schema
export const auditDB = createBrowserClient(supabaseUrl, supabaseAnonKey, {
  db: { schema: 'audit' },
});

// Client-side reporting schema (views — read only)
export const reportingDB = createBrowserClient(supabaseUrl, supabaseAnonKey, {
  db: { schema: 'reporting' },
});
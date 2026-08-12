import { createClient } from '@supabase/supabase-js';
import { createServerClient } from '@supabase/ssr';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

// ═════════════════════════════════════════════════════════════════════
// CLIENT-SIDE ONLY: Browser/client components ke liye
// Yeh anon key use karta hai — sirf client components mein use karein.
// API routes mein YE CLIENT KABHI USE NAHI KAREIN.
// ═════════════════════════════════════════════════════════════════════
export const supabase = createClient(supabaseUrl, supabaseAnonKey);

// Client-side finance schema
export const financeDB = createClient(supabaseUrl, supabaseAnonKey, {
  db: { schema: 'finance' },
});

// Client-side audit schema
export const auditDB = createClient(supabaseUrl, supabaseAnonKey, {
  db: { schema: 'audit' },
});

// Client-side reporting schema (views — read only)
export const reportingDB = createClient(supabaseUrl, supabaseAnonKey, {
  db: { schema: 'reporting' },
});

// ═════════════════════════════════════════════════════════════════════
// SERVER-SIDE: API routes ke liye server client with cookie handling
// SECURITY FIX: API routes ko yeh use karna chahiye, naki `supabase` (anon key)
// ═════════════════════════════════════════════════════════════════════
export async function getServerSupabase(cookieStore?: any) {
  const { cookies: getCookies } = await import('next/headers');
  const cookieHeader = cookieStore || (await getCookies());

  return createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        return cookieHeader.getAll();
      },
      // FIX Bug 7.5: Previously setAll: () => {} (empty) which meant
      // session refresh tokens were never saved → silent auth failures.
      // Now properly persists refreshed cookies.
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieHeader.set(name, value, options)
          );
        } catch {
          // Server Component — read-only cookies, this is expected
        }
      },
    },
  });
}

// ═════════════════════════════════════════════════════════════════════
// ADMIN OPERATIONS: Service role key for bypassing RLS (admin-only tasks)
// ⚠️ USE WITH EXTREME CAUTION — only for background jobs, migrations,
//   cross-organization admin operations where RLS is handled in code.
// ═════════════════════════════════════════════════════════════════════
export function getServiceRoleClient() {
  if (!supabaseServiceRoleKey) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY is not configured. Admin operations require this key.');
  }
  return createClient(supabaseUrl, supabaseServiceRoleKey);
}

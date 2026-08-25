// =============================================================================
// MFA ENFORCEMENT MIDDLEWARE
// =============================================================================
// Add this to ANY API route that needs MFA enforcement.
// Usage: Import and call `enforceMFA(authResult)` after `getAuthUser()`.
//
// Example in an API route:
//   const auth = await getAuthUser();
//   if (auth instanceof NextResponse) return auth;
//   const mfaCheck = await enforceMFA(auth);
//   if (mfaCheck) return mfaCheck;
//
 
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import type { AuthResult } from './api-auth';
 
// Roles that require MFA
const MFA_REQUIRED_ROLES = ['CEO', 'Admin', 'FINANCE_HEAD', 'ACCOUNTANT', 'HOD', 'PROJECT_MANAGER', 'TECHNICAL_ADMIN'];
 
/**
 * Check if a user has MFA enabled and verified.
 * Returns NextResponse(403) if MFA is required but not set up, null otherwise.
 */
export async function enforceMFA(auth: AuthResult): Promise<NextResponse | null> {
  // Only enforce for sensitive roles
  if (!MFA_REQUIRED_ROLES.includes(auth.role)) {
    return null; // MFA not required for this role
  }
 
  // C9 FIX: Proper cookie handling instead of setAll: () => {} no-op
  const cookieStore = await cookies();
  const { createServerClient } = await import('@supabase/ssr');
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return cookieStore.getAll(); },
        setAll(cookiesToSet: any[]) {
          try {
            cookiesToSet.forEach(({ name, value, options }: any) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // Server Component — read-only cookies
          }
        },
      },
    }
  );
 
  // Check if user has MFA set up
  const { data: mfaFactors } = await supabase
    .from('user_mfa')
    .select('id, factor_type, is_verified')
    .eq('user_id', auth.userId);
 
  // If no MFA factors exist, user needs to set up MFA first
  if (!mfaFactors || mfaFactors.length === 0) {
    return NextResponse.json(
      { error: 'MFA setup required. Please enable Two-Factor Authentication from Settings.', code: 'MFA_REQUIRED' },
      { status: 403 }
    );
  }
 
  // Check if at least one factor is verified
  const hasVerified = mfaFactors.some((f: any) => f.is_verified === true);
  if (!hasVerified) {
    return NextResponse.json(
      { error: 'MFA verification pending. Please complete MFA setup from Settings.', code: 'MFA_PENDING' },
      { status: 403 }
    );
  }
 
  // A verified factor alone is not enough: the current authenticated session
  // must have reached AAL2. Otherwise a session authenticated only at AAL1
  // could use a previously-enrolled factor to bypass the per-session MFA
  // requirement.
  const { data: assurance, error: assuranceError } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (assuranceError || assurance?.currentLevel !== 'aal2') {
    return NextResponse.json(
      { error: 'MFA verification required for this session.', code: 'MFA_SESSION_REQUIRED' },
      { status: 403 }
    );
  }

  return null;
}
 
/**
 * Helper to add MFA enforcement to any route handler.
 * Usage: `const mfaResult = await withMFA(auth); if (mfaResult) return mfaResult;`
 */
export async function withMFA(auth: AuthResult): Promise<NextResponse | null> {
  return enforceMFA(auth);
}
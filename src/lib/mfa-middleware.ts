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

import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import type { AuthResult } from './api-auth';

// Roles that require MFA
const MFA_REQUIRED_ROLES = ['CEO', 'Admin', 'FINANCE_HEAD', 'ACCOUNTANT'];

/**
 * Check if a user has MFA enabled and verified.
 * Returns NextResponse(403) if MFA is required but not set up, null otherwise.
 */
export async function enforceMFA(auth: AuthResult): Promise<NextResponse | null> {
  // Only enforce for sensitive roles
  if (!MFA_REQUIRED_ROLES.includes(auth.role)) {
    return null; // MFA not required for this role
  }

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: { getAll: async () => (await cookies()).getAll(), setAll: () => {} } }
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

  // MFA is set up and verified — allow through
  // (Actual TOTP verification happens at login via Supabase Auth)
  return null;
}

/**
 * Helper to add MFA enforcement to any route handler.
 * Usage: `const mfaResult = await withMFA(auth); if (mfaResult) return mfaResult;`
 */
export async function withMFA(auth: AuthResult): Promise<NextResponse | null> {
  return enforceMFA(auth);
}

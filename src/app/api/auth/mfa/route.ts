import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/lib/api-auth';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

// ═══════════════════════════════════════════════════════════════════
// MFA API — Enroll, Verify, Challenge, Unenroll (TOTP)
// Fixed and production ready
// ═══════════════════════════════════════════════════════════════════

function db() {
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: { getAll: async () => (await cookies()).getAll(), setAll: () => {} } }
  );
}

// Check if user has active MFA in database
async function getUserMfaStatus(userId: string): Promise<boolean> {
  const supabase = db();
  const { data } = await supabase
    .from('user_mfa')
    .select('id')
    .eq('user_id', userId)
    .eq('is_verified', true)
    .maybeSingle();
  return !!data;
}

// Check if MFA is required for this user's role
async function isMfaRequiredForRole(userId: string): Promise<boolean> {
  const supabase = db();
  const { data: profile } = await supabase
    .from('profiles')
    .select('mfa_required, role')
    .eq('user_id', userId)
    .maybeSingle();
  
  if (profile?.mfa_required) return true;
  const mfaRoles = ['CEO', 'Admin', 'FINANCE_HEAD', 'ACCOUNTANT'];
  return mfaRoles.includes(profile?.role || '');
}

// ─── GET: Fetch MFA Status & Factors ───
export async function GET() {
  const auth = await getAuthUser();
  if (auth instanceof NextResponse) return auth;

  try {
    const supabase = db();
    
    // Fetch factors directly from Supabase [5]
    const { data: factorData, error: factorErr } = await supabase.auth.mfa.listFactors();
    if (factorErr) throw factorErr;

    const verifiedFactors = factorData?.all?.filter((f: any) => f.status === 'verified') || [];
    const unverifiedFactors = factorData?.all?.filter((f: any) => f.status === 'unverified') || [];

    const [mfaDbActive, mfaRequired] = await Promise.all([
      getUserMfaStatus(auth.userId),
      isMfaRequiredForRole(auth.userId),
    ]);

    return NextResponse.json({
      isMfaEnabled: verifiedFactors.length > 0 || mfaDbActive,
      mfa_required: mfaRequired,
      verifiedFactors,
      unverifiedFactors,
      allFactors: factorData?.all || [],
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// ─── POST: Handle Actions ───
export async function POST(req: NextRequest) {
  const auth = await getAuthUser();
  if (auth instanceof NextResponse) return auth;

  try {
    const body = await req.json();
    const { action, code, factorId } = body;
    const supabase = db();

    // ── 1. ENROLL: Start setup (QR code creation) ──
    if (action === 'enroll') {
      const existing = await getUserMfaStatus(auth.userId);
      if (existing) {
        return NextResponse.json({ error: 'MFA already enrolled. Unenroll first to re-enroll.' }, { status: 400 });
      }

      // FIXED: Correct method name is enroll() [1]
      const { data: enrollData, error: enrollErr } = await supabase.auth.mfa.enroll({
        factorType: 'totp',
      });

      if (enrollErr || !enrollData) {
        return NextResponse.json({ error: 'MFA enrollment failed: ' + enrollErr.message }, { status: 400 });
      }

      // Insert unverified factor to local tracking table
      await supabase.from('user_mfa').insert({
        user_id: auth.userId,
        factor_id: enrollData.id,
        factor_type: 'totp',
        is_verified: false,
      });

      return NextResponse.json({
        factorId: enrollData.id,
        type: enrollData.type,
        totp: enrollData.totp,
        message: 'Scan QR code with your authenticator app, then verify with a TOTP code.',
      });
    }

    // ── 2. VERIFY-SETUP: Confirm code during enrollment ──
    if (action === 'verify-setup' || action === 'verify') {
      if (!code || !factorId) {
        return NextResponse.json({ error: 'code and factorId are required' }, { status: 400 });
      }

      // FIXED: Mandatorily create a challenge first to get challengeId [2]
      const { data: challengeData, error: challengeErr } = await supabase.auth.mfa.challenge({
        factorId: factorId
      });

      if (challengeErr || !challengeData) {
        return NextResponse.json({ error: 'MFA challenge failed: ' + challengeErr.message }, { status: 400 });
      }

      // FIXED: Use the generated challengeId from the challenge request [3]
      const { data: verifyData, error: verifyErr } = await supabase.auth.mfa.verify({
        factorId,
        challengeId: challengeData.id,
        code,
      });

      if (verifyErr || !verifyData) {
        return NextResponse.json({ error: 'Invalid TOTP code. Please try again.' }, { status: 400 });
      }

      // Sync verification states in databases
      await supabase
        .from('user_mfa')
        .update({ is_verified: true, verified_at: new Date().toISOString() })
        .eq('user_id', auth.userId)
        .eq('factor_id', factorId);

      await supabase
        .from('profiles')
        .update({ mfa_required: true })
        .eq('user_id', auth.userId);

      try {
        await supabase.from('audit.audit_log').insert({
          user_id: auth.userId,
          action: 'MFA_ENROLLED',
          module: 'AUTH',
          details: JSON.stringify({ factor_id: factorId }),
        });
      } catch {}

      return NextResponse.json({ success: true, message: 'MFA verified and activated successfully.' });
    }

    // ── 3. UNENROLL: Delete MFA ──
    if (action === 'unenroll') {
      if (!factorId) {
        return NextResponse.json({ error: 'factorId is required to unenroll MFA.' }, { status: 400 });
      }

      // CRITICAL: TOTP code is MANDATORY for unenroll — prevents attackers from removing MFA
      if (!code) {
        return NextResponse.json({ error: 'TOTP code is required to unenroll MFA.' }, { status: 400 });
      }
      const { data: challengeData, error: challengeErr } = await supabase.auth.mfa.challenge({ factorId });
      if (challengeErr || !challengeData) {
        return NextResponse.json({ error: 'MFA challenge failed: ' + (challengeErr?.message || 'unknown') }, { status: 400 });
      }
      const { error: verifyErr } = await supabase.auth.mfa.verify({ factorId, challengeId: challengeData.id, code });
      if (verifyErr) {
        return NextResponse.json({ error: 'Invalid TOTP code. Cannot unenroll MFA.' }, { status: 400 });
      }

      // FIXED: Correct method invocation for unenroll [4]
      const { error: unenrollErr } = await supabase.auth.mfa.unenroll({
        factorId: factorId,
      });

      if (unenrollErr) {
        return NextResponse.json({ error: 'Unenrollment failed: ' + unenrollErr.message }, { status: 400 });
      }

      // Delete from DB tracking tables
      await supabase.from('user_mfa').delete().eq('user_id', auth.userId);
      await supabase.from('profiles').update({ mfa_required: false }).eq('user_id', auth.userId);

      try {
        await supabase.from('audit.audit_log').insert({
          user_id: auth.userId,
          action: 'MFA_UNENROLLED',
          module: 'AUTH',
        });
      } catch {}

      return NextResponse.json({ success: true, message: 'MFA removed successfully.' });
    }

    return NextResponse.json({ error: 'Invalid action. Use enroll, verify-setup, or unenroll.' }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Internal server error' }, { status: 500 });
  }
}

import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/lib/api-auth';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
 
// ═══════════════════════════════════════════════════════════════════
// MFA API — Enroll, Verify, Challenge, Unenroll (TOTP)
// Fixed: All audit calls now go through audit.log_security_event() RPC
// instead of raw audit.audit_log inserts (Spec 8.2 / 10.4 compliance)
// ═══════════════════════════════════════════════════════════════════
 
function db() {
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: async () => (await cookies()).getAll(),
        setAll: async (cookiesToSet: any[]) => {   
          try {
            const cookieStore = await cookies();
            cookiesToSet.forEach(({ name, value, options }: any) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // Server Component — read-only cookies
          }
        }
      }
    }
  );
}
 
// ✅ FIX: Centralized audit helper that uses the correct RPC
async function auditMfaEvent(
  supabase: any,
  userId: string,
  eventType: string,
  success: boolean,
  details?: Record<string, any>
) {
  try {
    await supabase.schema('audit').rpc('log_security_event', {
      p_user_id: userId,
      p_event_type: eventType,
      p_success: success,
      p_details: details || null,
    });
  } catch (err) {
    console.error('MFA audit log error:', err);
  }
}
 
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
 
    // ── 1. ENROLL ──
    if (action === 'enroll') {
      const existing = await getUserMfaStatus(auth.userId);
      if (existing) {
        return NextResponse.json({ error: 'MFA already enrolled. Unenroll first to re-enroll.' }, { status: 400 });
      }
 
      const { data: enrollData, error: enrollErr } = await supabase.auth.mfa.enroll({
        factorType: 'totp',
      });
 
      if (enrollErr || !enrollData) {
        return NextResponse.json({ error: 'MFA enrollment failed: ' + enrollErr.message }, { status: 400 });
      }
 
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
 
    // ── 2. VERIFY-SETUP ──
    if (action === 'verify-setup' || action === 'verify') {
      if (!code || !factorId) {
        return NextResponse.json({ error: 'code and factorId are required' }, { status: 400 });
      }
 
      const { data: challengeData, error: challengeErr } = await supabase.auth.mfa.challenge({
        factorId: factorId
      });
 
      if (challengeErr || !challengeData) {
        return NextResponse.json({ error: 'MFA challenge failed: ' + challengeErr.message }, { status: 400 });
      }
 
      const { data: verifyData, error: verifyErr } = await supabase.auth.mfa.verify({
        factorId,
        challengeId: challengeData.id,
        code,
      });
 
      if (verifyErr || !verifyData) {
        // ✅ FIX: Log MFA verification failure to security_events
        await auditMfaEvent(supabase, auth.userId, 'MFA_VERIFICATION_FAILURE', false, {
          factor_id: factorId,
          action: 'verify-setup',
        });
        return NextResponse.json({ error: 'Invalid TOTP code. Please try again.' }, { status: 400 });
      }
 
      await supabase
        .from('user_mfa')
        .update({ is_verified: true, verified_at: new Date().toISOString() })
        .eq('user_id', auth.userId)
        .eq('factor_id', factorId);
 
      await supabase
        .from('profiles')
        .update({ mfa_required: true })
        .eq('user_id', auth.userId);
 
      // ✅ FIX: Log MFA enabled to security_events (not raw audit_log insert)
      await auditMfaEvent(supabase, auth.userId, 'MFA_ENABLED', true, {
        factor_id: factorId,
        factor_type: 'totp',
      });
 
      return NextResponse.json({ success: true, message: 'MFA verified and activated successfully.' });
    }
 
    // ── 3. UNENROLL ──
    if (action === 'unenroll') {
      if (!factorId) {
        return NextResponse.json({ error: 'factorId is required to unenroll MFA.' }, { status: 400 });
      }
 
      if (!code) {
        return NextResponse.json({ error: 'TOTP code is required to unenroll MFA.' }, { status: 400 });
      }
 
      const { data: challengeData, error: challengeErr } = await supabase.auth.mfa.challenge({ factorId });
      if (challengeErr || !challengeData) {
        return NextResponse.json({ error: 'MFA challenge failed: ' + (challengeErr?.message || 'unknown') }, { status: 400 });
      }
 
      const { error: verifyErr } = await supabase.auth.mfa.verify({
        factorId,
        challengeId: challengeData.id,
        code,
      });
 
      if (verifyErr) {
        // ✅ FIX: Log failed unenroll attempt to security_events
        await auditMfaEvent(supabase, auth.userId, 'MFA_VERIFICATION_FAILURE', false, {
          factor_id: factorId,
          action: 'unenroll',
        });
        return NextResponse.json({ error: 'Invalid TOTP code. Cannot unenroll MFA.' }, { status: 400 });
      }
 
      const { error: unenrollErr } = await supabase.auth.mfa.unenroll({ factorId: factorId });
 
      if (unenrollErr) {
        return NextResponse.json({ error: 'Unenrollment failed: ' + unenrollErr.message }, { status: 400 });
      }
 
      await supabase.from('user_mfa').delete().eq('user_id', auth.userId);
      await supabase.from('profiles').update({ mfa_required: false }).eq('user_id', auth.userId);
 
      // ✅ FIX: Log MFA disabled to security_events (not raw audit_log insert)
      await auditMfaEvent(supabase, auth.userId, 'MFA_DISABLED', true, {
        factor_id: factorId,
      });
 
      return NextResponse.json({ success: true, message: 'MFA removed successfully.' });
    }
 
    return NextResponse.json({ error: 'Invalid action. Use enroll, verify-setup, or unenroll.' }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Internal server error' }, { status: 500 });
  }
}


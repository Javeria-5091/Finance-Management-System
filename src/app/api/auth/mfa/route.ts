import { NextRequest, NextResponse } from 'next/server';
import { getAuthSupabase, getAuthUser } from '@/lib/api-auth';
import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────────────────
// /api/auth/mfa — Multi-Factor Authentication enrollment / verification / removal
// ─────────────────────────────────────────────────────────────────────────────
//
// REWRITE (Critical fix — Audit Finding C-1):
// The previous version of this file was a STALE COPY of /api/finance/attachment
// (a copy-paste error from an earlier cleanup pass). It exposed an
// unauthenticated download_url action that let ANY authenticated user download
// ANY finance attachment by guessing the storage path — the same vulnerability
// fixed in /api/finance/attachment/route.ts via BUG-011.
//
// This file is now a REAL MFA endpoint, as expected by the MFA settings page
// (src/app/dashboard/settings/mfa/page.tsx), implementing:
//   - GET    : returns whether the caller has at least one verified MFA factor
//   - POST   action=enroll   : creates a new TOTP factor via Supabase Auth MFA
//   - POST   action=verify   : challenges + verifies a TOTP code, marks
//                               factor as verified in user_mfa
//   - POST   action=unenroll  : removes a verified MFA factor
//
// All actions require an authenticated user. The verify/unenroll actions
// additionally require a fresh TOTP code (challenge step) so a stolen session
// cookie alone cannot disable MFA.
// ─────────────────────────────────────────────────────────────────────────────

const enrollSchema = z.object({
  action: z.literal('enroll'),
});

const verifySchema = z.object({
  action: z.literal('verify'),
  code: z.string().regex(/^\d{6}$/, 'Code must be exactly 6 digits'),
  factorId: z.string().min(1, 'factorId is required'),
});

const unenrollSchema = z.object({
  action: z.literal('unenroll'),
  code: z.string().regex(/^\d{6}$/, 'Code must be exactly 6 digits'),
});

const mfaActionSchema = z.union([enrollSchema, verifySchema, unenrollSchema]);

function validateBody<T>(schema: z.ZodSchema<T>, body: unknown): { success: true; data: T } | { success: false; error: string } {
  const result = schema.safeParse(body);
  if (result.success) return { success: true, data: result.data };
  const firstError = result.error.issues[0];
  return {
    success: false,
    error: firstError ? `${firstError.path.join('.')}: ${firstError.message}` : 'Invalid request data',
  };
}

// ─── GET: MFA status ─────────────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  const auth = await getAuthUser();
  if (auth instanceof NextResponse) return auth;

  const { supabase } = await getAuthSupabase(req);

  try {
    // Check our local user_mfa table for verified factors.
    // (Supabase Auth MFA also tracks these via auth.mfa.factors, but our
    // lib/mfa-middleware.ts reads from user_mfa so we use the same source
    // of truth for consistency.)
    const { data: mfaFactors, error } = await supabase
      .from('user_mfa')
      .select('id, factor_type, is_verified, enrolled_at, verified_at')
      .eq('user_id', auth.userId);

    if (error) {
      return NextResponse.json({ error: 'Failed to fetch MFA status' }, { status: 500 });
    }

    const verified = (mfaFactors || []).some((f: any) => f.is_verified === true);

    return NextResponse.json({
      mfa_active: verified,
      factors: mfaFactors || [],
      // Frontend uses mfa_active to decide whether to show enrollment vs unenroll UI
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Internal server error' }, { status: 500 });
  }
}

// ─── POST: enroll / verify / unenroll ────────────────────────────────────────
export async function POST(req: NextRequest) {
  const auth = await getAuthUser();
  if (auth instanceof NextResponse) return auth;

  const { supabase } = await getAuthSupabase(req);

  try {
    const rawBody = await req.json();
    const validation = validateBody(mfaActionSchema, rawBody);
    if (!validation.success) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }
    const body = validation.data;

    // ─── ENROLL: create a new TOTP factor ────────────────────────────────
    if (body.action === 'enroll') {
      // Supabase Auth MFA: enroll a new TOTP factor.
      const { data, error } = await supabase.auth.mfa.enroll({
        factorType: 'totp',
        // Issuer + friendly name shown in the user's authenticator app
        issuer: 'OSYSTIC FMS',
        friendlyName: `OSYSTIC-${auth.email ?? auth.userId.slice(0, 8)}`,
      });

      if (error || !data) {
        return NextResponse.json({ error: error?.message || 'MFA enrollment failed' }, { status: 400 });
      }

      // data.totp returns { qr_code: dataURL, secret: string, uri: string }
      // data.id is the factorId needed for verify/unenroll
      const totp = (data as any).totp || (data as any);
      const factorId = (data as any).id;

      // Pre-insert an UNVERIFIED row in user_mfa — verified_at is set on
      // successful verify below. This means an abandoned enrollment leaves
      // an unverified factor row, which is fine (and helps the user see
      // pending enrollments). The lib/mfa-middleware.ts only treats
      // is_verified=true as "MFA active".
      await supabase
        .from('user_mfa')
        .insert({
          user_id: auth.userId,
          factor_id: factorId,
          factor_type: 'totp',
          is_verified: false,
        });

      return NextResponse.json({
        factor_id: factorId,
        totp: {
          qr_code: totp.qr_code,
          secret: totp.secret,
          uri: totp.uri,
        },
      });
    }

    // ─── VERIFY: challenge + verify a 6-digit TOTP code ─────────────────
    if (body.action === 'verify') {
      const { code, factorId } = body;

      // Create a challenge for this factor
      const { data: challengeData, error: challengeErr } = await supabase.auth.mfa.challenge({
        factorId,
      });
      if (challengeErr || !challengeData) {
        return NextResponse.json({ error: challengeErr?.message || 'Failed to create MFA challenge' }, { status: 400 });
      }

      // Verify the user's code against the challenge
      const { error: verifyErr } = await supabase.auth.mfa.verify({
        factorId,
        challengeId: challengeData.id,
        code,
      });
      if (verifyErr) {
        return NextResponse.json({ error: verifyErr.message || 'Invalid TOTP code' }, { status: 400 });
      }

      // Mark factor as verified in user_mfa table
      const { error: updateErr } = await supabase
        .from('user_mfa')
        .update({
          is_verified: true,
          verified_at: new Date().toISOString(),
          last_used_at: new Date().toISOString(),
        })
        .eq('user_id', auth.userId)
        .eq('factor_id', factorId);

      if (updateErr) {
        // Supabase Auth already marked the factor as verified on its side;
        // we just failed to mirror that into our local table. Log + continue
        // rather than rolling back the Auth-side verification.
        console.error('Failed to mark MFA factor as verified in user_mfa:', updateErr.message);
      }

      // Audit log
      try {
        await supabase.schema('audit').rpc('log_action', {
          p_user_id: auth.userId,
          p_action: 'MFA_ENROLLED',
          p_entity_type: 'user_mfa',
          p_entity_id: factorId,
          p_description: 'User activated MFA via TOTP verification',
          p_new_status: 'VERIFIED',
          p_source_module: 'auth',
          p_severity: 'high',
        });
      } catch (auditErr: any) {
        console.error('MFA enroll audit log failed:', auditErr);
      }

      return NextResponse.json({ success: true, message: 'MFA activated successfully' });
    }

    // ─── UNENROLL: remove a verified MFA factor ─────────────────────────
    if (body.action === 'unenroll') {
      const { code } = body;

      // Find the user's verified factor(s). We require the user to enter a
      // valid TOTP code to confirm unenrollment, so an attacker who steals
      // the session cookie alone cannot disable MFA.
      const { data: factors } = await supabase
        .from('user_mfa')
        .select('factor_id, is_verified')
        .eq('user_id', auth.userId)
        .eq('is_verified', true);

      if (!factors || factors.length === 0) {
        return NextResponse.json({ error: 'No verified MFA factor found' }, { status: 400 });
      }

      // Try each verified factor against the supplied code. If any verifies,
      // proceed with unenroll.
      let unenrolledFactorId: string | null = null;
      let lastErr: any = null;
      for (const f of factors) {
        const { data: challengeData, error: challengeErr } = await supabase.auth.mfa.challenge({
          factorId: f.factor_id,
        });
        if (challengeErr || !challengeData) { lastErr = challengeErr; continue; }

        const { error: verifyErr } = await supabase.auth.mfa.verify({
          factorId: f.factor_id,
          challengeId: challengeData.id,
          code,
        });
        if (verifyErr) { lastErr = verifyErr; continue; }

        unenrolledFactorId = f.factor_id;
        break;
      }

      if (!unenrolledFactorId) {
        return NextResponse.json({ error: lastErr?.message || 'Invalid TOTP code. Unenrollment aborted.' }, { status: 400 });
      }

      // Unenroll the factor on Supabase Auth side
      const { error: unenrollErr } = await supabase.auth.mfa.unenroll({
        factorId: unenrolledFactorId,
      });
      if (unenrollErr) {
        return NextResponse.json({ error: unenrollErr.message }, { status: 400 });
      }

      // Remove the row from user_mfa
      await supabase
        .from('user_mfa')
        .delete()
        .eq('user_id', auth.userId)
        .eq('factor_id', unenrolledFactorId);

      // Audit log — MFA removal is a sensitive security event (Spec 8.2)
      try {
        await supabase.schema('audit').rpc('log_action', {
          p_user_id: auth.userId,
          p_action: 'MFA_REMOVED',
          p_entity_type: 'user_mfa',
          p_entity_id: unenrolledFactorId,
          p_description: 'User removed MFA (TOTP factor unenrolled)',
          p_previous_status: 'VERIFIED',
          p_new_status: 'REMOVED',
          p_source_module: 'auth',
          p_severity: 'critical',
        });
      } catch (auditErr: any) {
        console.error('MFA removal audit log failed:', auditErr);
      }

      return NextResponse.json({ success: true, message: 'MFA removed' });
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Internal server error' }, { status: 500 });
  }
}

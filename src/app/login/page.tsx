'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { logSecurityEvent } from '@/lib/logAction';

export default function LoginPage() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mfaCode, setMfaCode] = useState('');
  const [mfaFactorId, setMfaFactorId] = useState<string | null>(null);
  const [mfaChallengeId, setMfaChallengeId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function sanitizeRedirect(raw: string | null): string {
    if (!raw) return '/dashboard';
    try {
      const url = new URL(raw, window.location.origin);
      if (url.origin !== window.location.origin || raw.startsWith('//')) return '/dashboard';
      return url.pathname + url.search || '/dashboard';
    } catch {
      return '/dashboard';
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const { data: signInData, error: authError } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (authError || !signInData.session) {
        await logSecurityEvent({ eventType: 'LOGIN_FAILURE', userEmail: email });
        setError(authError?.message || 'Unable to sign in');
        setLoading(false);
        return;
      }

      await logSecurityEvent({ eventType: 'LOGIN_SUCCESS', userId: signInData.user.id, userEmail: signInData.user.email });

      const { data: profile } = await supabase
        .from('profiles')
        .select('role, organization_id')
        .eq('user_id', signInData.user.id)
        .maybeSingle();

      const mfaRequiredRoles = [
        'CEO', 'FINANCE_HEAD', 'ACCOUNTANT', 'HOD',
        'PROJECT_MANAGER', 'TECHNICAL_ADMIN', 'AUDITOR',
      ];

      if (profile?.role && mfaRequiredRoles.includes(profile.role)) {
        const { data: aal, error: aalError } =
          await supabase.auth.mfa.getAuthenticatorAssuranceLevel();

        if (aalError) {
          await supabase.auth.signOut();
          throw aalError;
        }

        if (aal?.nextLevel === 'aal2' && aal.currentLevel !== 'aal2') {
          const { data: factors, error: factorsError } = await supabase.auth.mfa.listFactors();
          const verifiedFactor = factors?.totp?.find((factor: any) => factor.status === 'verified');

          if (factorsError || !verifiedFactor) {
            await supabase.auth.signOut();
            setError('MFA is required for this finance role. Please enroll a verified authenticator before signing in.');
            setLoading(false);
            return;
          }

          const { data: challenge, error: challengeError } =
            await supabase.auth.mfa.challenge({ factorId: verifiedFactor.id });

          if (challengeError || !challenge) {
            await supabase.auth.signOut();
            throw challengeError || new Error('Unable to start MFA challenge');
          }

          setMfaFactorId(verifiedFactor.id);
          setMfaChallengeId(challenge.id);
          setError(null);
          setLoading(false);
          return;
        }
      }

      router.push(sanitizeRedirect(searchParams.get('redirect')));
      router.refresh();
    } catch (err: any) {
      setError(err?.message || 'An unexpected error occurred');
      setLoading(false);
    }
  }

  async function handleMfaSubmit(e: React.FormEvent) {
    e.preventDefault();

    if (!mfaFactorId || !mfaChallengeId || !/^\d{6}$/.test(mfaCode)) {
      setError('Enter the 6-digit authenticator code.');
      return;
    }

    setLoading(true);
    setError(null);

    const { error: verifyError } = await supabase.auth.mfa.verify({
      factorId: mfaFactorId,
      challengeId: mfaChallengeId,
      code: mfaCode,
    });

    if (verifyError) {
      setError(verifyError.message);
      setLoading(false);
      return;
    }

    router.push(sanitizeRedirect(searchParams.get('redirect')));
    router.refresh();
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-950 px-4">
      <div className="w-full max-w-md">
        <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-lg border border-gray-200 dark:border-gray-800 p-8">
          <div className="text-center mb-8">
            <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
              Finance Management System
            </h1>
            <p className="text-gray-500 dark:text-gray-400 mt-2">
              {mfaFactorId ? 'Verify your authenticator code' : 'Sign in to your account'}
            </p>
          </div>

          {error && (
            <div className="mb-6 p-3 bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800 rounded-lg">
              <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
            </div>
          )}

          {mfaFactorId ? (
            <form onSubmit={handleMfaSubmit} className="space-y-5">
              <div>
                <label htmlFor="mfaCode" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Authenticator code
                </label>
                <input
                  id="mfaCode"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  pattern="\d{6}"
                  required
                  value={mfaCode}
                  onChange={(e) => setMfaCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder="123456"
                  className="w-full px-3 py-2.5 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <button
                type="submit"
                disabled={loading}
                className="w-full py-2.5 px-4 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white font-medium"
              >
                {loading ? 'Verifying...' : 'Verify MFA'}
              </button>
            </form>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-5">
              <div>
                <label htmlFor="email" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Email</label>
                <input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@company.com"
                  className="w-full px-3 py-2.5 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <div>
                <label htmlFor="password" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Password</label>
                <input id="password" type="password" required value={password} onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter your password"
                  className="w-full px-3 py-2.5 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <button type="submit" disabled={loading}
                className="w-full py-2.5 px-4 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white font-medium">
                {loading ? 'Signing in...' : 'Sign In'}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

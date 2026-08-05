"use client";
import { useState, FormEvent } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import Link from "next/link";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  
  // MFA States
  const [mfaRequired, setMfaRequired] = useState(false);
  const [mfaFactorId, setMfaFactorId] = useState("");
  const [mfaChallengeId, setMfaChallengeId] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [mfaLoading, setMfaLoading] = useState(false);

  // 1. Normal Login Flow
  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const { data, error: signInErr } = await supabase.auth.signInWithPassword({ email, password });

      if (signInErr) {
        setError(signInErr.message || "Login failed");
        setLoading(false);
        return;
      }

      // Supabase listFactors returns { all, totp, phone, webauthn } - NOT { factors }
      const { data: factorData, error: factorErr } = await supabase.auth.mfa.listFactors();
      const verifiedFactors = factorData?.all?.filter((f: any) => f.status === "verified") || [];

      if (verifiedFactors.length > 0) {
        const factor = verifiedFactors[0];
        const { data: challengeData, error: challengeErr } = await supabase.auth.mfa.challenge({
          factorId: factor.id,
        });

        if (challengeErr) {
          setError("MFA Challenge failed: " + challengeErr.message);
          setLoading(false);
          return;
        }

        setMfaFactorId(factor.id);
        setMfaChallengeId(challengeData.id);
        setMfaRequired(true);
        setLoading(false);
        return;
      }

      router.push("/dashboard");
    } catch (err: any) {
      setError(err.message || "Login failed");
    } finally {
      setLoading(false);
    }
  }

  // 2. MFA Verification Flow
  async function handleMfaVerify(e: FormEvent) {
    e.preventDefault();
    setError("");
    setMfaLoading(true);

    try {
      const { error: verifyErr } = await supabase.auth.mfa.verify({
        factorId: mfaFactorId,
        challengeId: mfaChallengeId,
        code: totpCode,
      });

      if (verifyErr) {
        setError("Invalid code. Please try again.");
        setMfaLoading(false);
        return;
      }

      router.push("/dashboard");
    } catch (err: any) {
      setError(err.message || "MFA verification failed");
    } finally {
      setMfaLoading(false);
    }
  }

  // ─── MFA Challenge Screen ───
  if (mfaRequired) {
    return (
      <main className="min-h-screen flex items-center justify-center px-4 bg-gray-50 dark:bg-gray-900">
        <div className="w-full max-w-md bg-white dark:bg-gray-800 p-8 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm">
          <h1 className="text-2xl font-bold text-center mb-2 text-gray-900 dark:text-white">
            Two-Factor Authentication
          </h1>
          <p className="text-center text-sm text-gray-500 dark:text-gray-400 mb-6">
            Enter the 6-digit code from your authenticator app.
          </p>
          {error && (
            <div className="mb-4 p-3 bg-red-50 dark:bg-red-500/20 border border-red-200 dark:border-red-500/50 text-red-600 dark:text-red-300 rounded-lg text-sm">
              {error}
            </div>
          )}
          <form onSubmit={handleMfaVerify} className="space-y-4">
            <Input id="totp_code" label="Authentication Code" type="text" placeholder="000000"
              value={totpCode} onChange={e => setTotpCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              required maxLength={6} />
            <Button type="submit" loading={mfaLoading}>Verify</Button>
          </form>
          <button onClick={() => { setMfaRequired(false); setError(""); }}
            className="w-full text-center text-sm text-gray-500 hover:text-gray-700 mt-4">
            Back to login
          </button>
        </div>
      </main>
    );
  }

  // ─── Normal Login Screen ───
  return (
    <main className="min-h-screen flex items-center justify-center px-4 bg-gray-50 dark:bg-gray-900">
      <div className="w-full max-w-md bg-white dark:bg-gray-800 p-8 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm">
        <h1 className="text-2xl font-bold text-center mb-6 text-gray-900 dark:text-white">Welcome Back</h1>
        {error && (
          <div className="mb-4 p-3 bg-red-50 dark:bg-red-500/20 border border-red-200 dark:border-red-500/50 text-red-600 dark:text-red-300 rounded-lg text-sm font-medium">
            {error}
          </div>
        )}
        <form onSubmit={handleSubmit} className="space-y-4">
          <Input id="email" label="Email" type="email" placeholder="you@example.com" value={email} onChange={e => setEmail(e.target.value)} required />
          <Input id="password" label="Password" type="password" placeholder="------" value={password} onChange={e => setPassword(e.target.value)} required />
          <Button type="submit" loading={loading}>Sign In</Button>
        </form>
        <p className="text-center text-sm text-gray-600 dark:text-gray-400 mt-6">
          Don&apos;t have an account?{" "}
          <Link href="/signup" className="text-blue-600 dark:text-blue-400 hover:underline font-medium">Sign up</Link>
        </p>
      </div>
    </main>
  );
}
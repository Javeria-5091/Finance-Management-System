"use client";
import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/context/AuthContext";
import { Shield, ShieldCheck, ShieldOff, Copy, CheckCircle } from "lucide-react";
import toast from "react-hot-toast";

export default function MfaSettingsPage() {
  const { user } = useAuth();
  const [mfaActive, setMfaActive] = useState(false);
  const [mfaRequired, setMfaRequired] = useState(false);
  const [enrolling, setEnrolling] = useState(false);
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [secret, setSecret] = useState("");
  const [factorId, setFactorId] = useState("");
  const [verifyCode, setVerifyCode] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [unenrollCode, setUnenrollCode] = useState("");
  const [unenrolling, setUnenrolling] = useState(false);
  const [loading, setLoading] = useState(true);

  const fetchStatus = useCallback(async () => {
    if (!user) return;
    try {
      const [apiRes, profileRes] = await Promise.all([
        fetch('/api/auth/mfa'),
        supabase.from('profiles').select('mfa_required').eq('user_id', user.id).maybeSingle(),
      ]);
      const apiData = await apiRes.json();
      setMfaActive(apiData.mfa_active);
      setMfaRequired(profileRes.data?.mfa_required || false);
    } catch (err: any) {
      console.error('MFA status fetch error:', err);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => { fetchStatus(); }, [fetchStatus]);

  // ─── Enroll ───
  async function handleEnroll() {
    setEnrolling(true);
    try {
      const res = await fetch('/api/auth/mfa', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'enroll' }),
      });
      const data = await res.json();
      if (!res.ok) { toast.error(data.error); return; }
      setQrCode(data.totp?.qr_code || null);
      setSecret(data.totp?.secret || '');
      setFactorId(data.factor_id);
      toast.success('QR code generated. Scan with your authenticator app.');
    } catch { toast.error('Enrollment failed'); }
    finally { setEnrolling(false); }
  }

  // ─── Verify ───
  async function handleVerify() {
    if (!verifyCode || verifyCode.length !== 6) { toast.error('Enter 6-digit code'); return; }
    setVerifying(true);
    try {
      const res = await fetch('/api/auth/mfa', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'verify', code: verifyCode, factorId }),
      });
      const data = await res.json();
      if (!res.ok) { toast.error(data.error); return; }
      toast.success('MFA activated successfully!');
      setQrCode(null); setSecret(''); setFactorId(''); setVerifyCode('');
      fetchStatus();
    } catch { toast.error('Verification failed'); }
    finally { setVerifying(false); }
  }

  // ─── Unenroll ───
  async function handleUnenroll() {
    if (!unenrollCode || unenrollCode.length !== 6) { toast.error('Enter current 6-digit code to confirm'); return; }
    setUnenrolling(true);
    try {
      const res = await fetch('/api/auth/mfa', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'unenroll', code: unenrollCode }),
      });
      const data = await res.json();
      if (!res.ok) { toast.error(data.error); return; }
      toast.success('MFA removed');
      setUnenrollCode('');
      fetchStatus();
    } catch { toast.error('Unenroll failed'); }
    finally { setUnenrolling(false); }
  }

  if (loading) return <div className="p-8 text-center text-gray-500">Loading MFA settings...</div>;

  return (
    <div className="max-w-2xl mx-auto p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
          <Shield className="w-6 h-6" /> Multi-Factor Authentication
        </h1>
        <p className="text-gray-500 dark:text-gray-400 mt-1 text-sm">
          Add an extra layer of security to your account using an authenticator app (Google Authenticator, Authy, etc.).
        </p>
      </div>

      {/* Status Card */}
      <div className={`p-6 rounded-xl border ${mfaActive ? 'bg-green-50 dark:bg-green-500/10 border-green-200 dark:border-green-500/30' : 'bg-yellow-50 dark:bg-yellow-500/10 border-yellow-200 dark:border-yellow-500/30'}`}>
        <div className="flex items-center gap-3">
          {mfaActive ? <ShieldCheck className="w-8 h-8 text-green-600" /> : <ShieldOff className="w-8 h-8 text-yellow-600" />}
          <div>
            <p className={`font-semibold ${mfaActive ? 'text-green-800 dark:text-green-200' : 'text-yellow-800 dark:text-yellow-200'}`}>
              {mfaActive ? 'MFA is Active' : 'MFA is Not Set Up'}
            </p>
            <p className="text-sm text-gray-500">
              {mfaActive ? 'Your account is protected with two-factor authentication.' : 'Your role requires MFA. Please set it up now.'}
            </p>
          </div>
        </div>
      </div>

      {/* Enrollment */}
      {!mfaActive && !qrCode && (
        <div className="bg-white dark:bg-gray-800 p-6 rounded-xl border border-gray-200 dark:border-gray-700">
          <h2 className="font-semibold text-gray-900 dark:text-white mb-3">Step 1: Generate QR Code</h2>
          <p className="text-sm text-gray-500 mb-4">Click below to generate a QR code. Then scan it with your authenticator app.</p>
          <button onClick={handleEnroll} disabled={enrolling}
            className="bg-blue-600 text-white px-6 py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50 font-medium">
            {enrolling ? 'Generating...' : 'Generate QR Code'}
          </button>
        </div>
      )}

      {/* QR Code Display */}
      {qrCode && (
        <div className="bg-white dark:bg-gray-800 p-6 rounded-xl border border-gray-200 dark:border-gray-700">
          <h2 className="font-semibold text-gray-900 dark:text-white mb-3">Step 2: Scan & Verify</h2>
          <div className="flex flex-col items-center gap-4">
            <img src={qrCode} alt="MFA QR Code" className="w-48 h-48 rounded-lg border" />
            <div className="text-center">
              <p className="text-sm text-gray-500">Can't scan? Enter this secret key manually:</p>
              <div className="flex items-center gap-2 mt-1">
                <code className="bg-gray-100 dark:bg-gray-700 px-3 py-1 rounded text-sm font-mono select-all">{secret}</code>
                <button onClick={() => { navigator.clipboard.writeText(secret); toast.success('Copied!'); }}
                  className="text-gray-400 hover:text-gray-600"><Copy className="w-4 h-4" /></button>
              </div>
            </div>
            <div className="w-full max-w-xs">
              <input type="text" placeholder="Enter 6-digit code" maxLength={6}
                value={verifyCode} onChange={e => setVerifyCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-4 py-2 text-center text-lg tracking-widest dark:bg-gray-700 dark:text-white" />
              <button onClick={handleVerify} disabled={verifying || verifyCode.length !== 6}
                className="w-full mt-2 bg-green-600 text-white px-6 py-2 rounded-lg hover:bg-green-700 disabled:opacity-50 font-medium">
                {verifying ? 'Verifying...' : 'Verify & Activate'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Unenroll */}
      {mfaActive && (
        <div className="bg-white dark:bg-gray-800 p-6 rounded-xl border border-red-200 dark:border-red-500/30">
          <h2 className="font-semibold text-red-600 mb-3">Remove MFA</h2>
          <p className="text-sm text-gray-500 mb-4">Enter your current TOTP code to remove MFA. This is not recommended for your role.</p>
          <div className="flex gap-2">
            <input type="text" placeholder="Current code" maxLength={6}
              value={unenrollCode} onChange={e => setUnenrollCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              className="flex-1 border border-gray-300 dark:border-gray-600 rounded-lg px-4 py-2 dark:bg-gray-700 dark:text-white" />
            <button onClick={handleUnenroll} disabled={unenrolling || unenrollCode.length !== 6}
              className="bg-red-600 text-white px-6 py-2 rounded-lg hover:bg-red-700 disabled:opacity-50 font-medium">
              {unenrolling ? 'Removing...' : 'Remove'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

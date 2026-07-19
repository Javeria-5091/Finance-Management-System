'use client';

import { useState, useEffect, useRef } from 'react';
import {
  Plus, Calendar, Lock, Unlock, AlertTriangle, X,
  ChevronDown, ChevronUp, AlertCircle, CheckCircle2, ShieldCheck, Sparkles,
} from 'lucide-react';
import {
  getFiscalYears, getPeriods, createFiscalYear,
  closePeriod, reopenPeriod, softCloseFiscalYear, hardCloseFiscalYear,
} from '@/types/services/fiscal-year.service';
import type { FiscalYearSummary, AccountingPeriod, CreateFiscalYearInput } from '@/types/accounting.types';

/* ═══════ UTILITIES ═══════ */
const cn = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(' ');

const parseError = (err: unknown): string => {
  const m = err && typeof err === 'object' && 'message' in err
    ? String((err as any).message) : err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  for (const [r, t] of [
    [/fy_dates_valid|end_date must be after/, 'End date must be after start date.'],
    [/fy_name_not_empty|name cannot be empty/, 'Fiscal year name is required.'],
    [/fy_min_duration/, 'Must be at least 1 month long.'],
    [/fy_max_duration/, 'Cannot exceed 24 months.'],
    [/unique constraint|duplicate key/, 'Name or dates already exist.'],
    [/overlapping|overlaps/, 'Overlaps with an existing fiscal year.'],
    [/already_closed/, 'Already closed.'], [/already_open/, 'Already open.'],
    [/cannot_reopen_hard/, 'Hard closed periods cannot be reopened.'],
    [/has_unclosed_periods/, 'Close all periods first.'],
    [/fy_already_closed/, 'Fiscal year is already closed.'],
    [/permission|unauthorized|forbidden/i, 'No permission for this action.'],
    [/network|failed to fetch/i, 'Network error. Check connection.'],
    [/timeout/i, 'Request timed out.'],
  ] as [RegExp, string][]) if (r.test(m)) return t;
  return (m.length >= 5 && m.length <= 200 && !m.includes('SQL'))
    ? m[0].toUpperCase() + m.slice(1) : 'An unexpected error occurred.';
};

// Auto-suggest name from dates: "FY 2028" or "FY 2028-29", with duplicate handling
const suggestName = (start: string, end: string, existing: string[]): string => {
  if (!start || !end) return '';
  const sy = new Date(start).getFullYear(), ey = new Date(end).getFullYear();
  const base = sy === ey ? `FY ${sy}` : `FY ${sy}-${String(ey).slice(2)}`;
  if (!existing.includes(base)) return base;
  let i = 2; while (existing.includes(`${base} (${i})`)) i++;
  return `${base} (${i})`;
};

const inputCls = (err?: string) => cn(
  'w-full px-3 py-2.5 bg-white dark:bg-gray-900 border rounded-lg text-sm text-gray-900 dark:text-white',
  'placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:focus:ring-blue-600 focus:border-transparent transition-shadow',
  err ? 'border-red-400 dark:border-red-500 ring-1 ring-red-400 dark:ring-red-500' : 'border-gray-300 dark:border-gray-600'
);

/* ═══════ SMALL COMPONENTS ═══════ */
const Badge = ({ status }: { status: string }) => {
  const map: Record<string, { bg: string; tx: string; dot: string; l: string }> = {
    OPEN:         { bg: 'bg-emerald-50 dark:bg-emerald-900/20', tx: 'text-emerald-700 dark:text-emerald-400', dot: 'bg-emerald-500', l: 'Open' },
    SOFT_CLOSED:  { bg: 'bg-amber-50 dark:bg-amber-900/20',   tx: 'text-amber-700 dark:text-amber-400',   dot: 'bg-amber-500',   l: 'Soft Closed' },
    HARD_CLOSED:  { bg: 'bg-red-50 dark:bg-red-900/20',       tx: 'text-red-700 dark:text-red-400',       dot: 'bg-red-500',     l: 'Hard Closed' },
  };
  const c = map[status] ?? { bg: 'bg-gray-50 dark:bg-gray-700', tx: 'text-gray-600 dark:text-gray-300', dot: '', l: status.replace(/_/g, ' ') };
  return (
    <span className={cn('inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold', c.bg, c.tx)}>
      {c.dot && <span className={cn('w-1.5 h-1.5 rounded-full mr-1.5', c.dot, status === 'OPEN' && 'animate-pulse')} />}
      {c.l}
    </span>
  );
};

const Field = ({ label, req, err, children }: { label: string; req?: boolean; err?: string; children: React.ReactNode }) => (
  <div>
    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
      {label}{req && <span className="text-red-500">*</span>}
    </label>
    {children}
    {err && <p className="mt-1.5 text-xs text-red-600 dark:text-red-400 flex items-center gap-1"><AlertCircle className="w-3 h-3" />{err}</p>}
  </div>
);

// Reusable modal shell — eliminates ~120 lines of repeated HTML
const Modal = ({ open, onClose, error, onClearError, children, footer }: {
  open: boolean; onClose: () => void; error?: string | null;
  onClearError?: () => void; children: React.ReactNode; footer?: React.ReactNode;
}) => {
  if (!open) return null;
  return (
    <div className="fixed inset-0 bg-black/40 dark:bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white dark:bg-gray-800 rounded-xl w-full max-w-md shadow-2xl border border-gray-200 dark:border-gray-700" onClick={e => e.stopPropagation()}>
        <div className="p-5 space-y-4">
          {error && (
            <div className="flex items-start gap-2.5 p-3 bg-red-50 dark:bg-red-900/15 border border-red-200 dark:border-red-800/60 rounded-lg">
              <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
              <p className="text-sm text-red-700 dark:text-red-400 flex-1">{error}</p>
              {onClearError && <button onClick={onClearError} className="text-red-400 hover:text-red-600"><X className="w-3.5 h-3.5" /></button>}
            </div>
          )}
          {children}
        </div>
        {footer && <div className="flex items-center justify-end gap-3 p-5 border-t border-gray-200 dark:border-gray-700 bg-gray-50/50 dark:bg-gray-900/30 rounded-b-xl">{footer}</div>}
      </div>
    </div>
  );
};

const Spin = (p: { cls?: string }) => (
  <svg className={cn('animate-spin', p.cls ?? 'w-4 h-4')} viewBox="0 0 24 24" fill="none">
    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
  </svg>
);

const ModalHeader = ({ icon, title, subtitle, onClose }: { icon: React.ReactNode; title: string; subtitle?: string; onClose: () => void }) => (
  <div className="flex items-center justify-between">
    <div className="flex items-center gap-3">{icon}<div><h2 className="text-lg font-semibold text-gray-900 dark:text-white">{title}</h2>{subtitle && <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{subtitle}</p>}</div></div>
    <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-400"><X className="w-5 h-5" /></button>
  </div>
);

/* ═══════ MAIN ═══════ */
export default function FiscalCalendarPage() {
  const [fys, setFys] = useState<FiscalYearSummary[]>([]);
  const [pMap, setPMap] = useState<Record<string, AccountingPeriod[]>>({});
  const [exp, setExp] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toasts, setToasts] = useState<{ id: string; type: 'success' | 'error'; msg: string }[]>([]);

  // Create modal
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState<CreateFiscalYearInput>({ name: '', start_date: '', end_date: '', description: '' });
  const [fErrs, setFErrs] = useState<Record<string, string>>({});
  const [cErr, setCErr] = useState<string | null>(null);
  const nameEdited = useRef(false);

  // Close period modal
  const [showCP, setShowCP] = useState(false);
  const [cpTgt, setCpTgt] = useState<{ id: string; name: string; fyId: string } | null>(null);
  const [cpType, setCpType] = useState<'SOFT_CLOSED' | 'HARD_CLOSED'>('SOFT_CLOSED');
  const [cpReason, setCpReason] = useState('');
  const [cpErr, setCpErr] = useState<string | null>(null);

  // Reopen modal
  const [showRO, setShowRO] = useState(false);
  const [roTgt, setRoTgt] = useState<{ id: string; name: string; fyId: string } | null>(null);
  const [roReason, setRoReason] = useState('');
  const [roErr, setRoErr] = useState<string | null>(null);

  // Close FY modal
  const [showCFY, setShowCFY] = useState(false);
  const [cfyTgt, setCfyTgt] = useState<{ id: string; name: string } | null>(null);
  const [cfyType, setCfyType] = useState<'soft' | 'hard'>('soft');
  const [cfyReason, setCfyReason] = useState('');
  const [cfyErr, setCfyErr] = useState<string | null>(null);

  const toast = (type: 'success' | 'error', msg: string) => {
    const id = Date.now() + '' + Math.random();
    setToasts(p => [...p, { id, type, msg }]);
    setTimeout(() => setToasts(p => p.filter(t => t.id !== id)), 4500);
  };

  /* ─── Data ─── */
  const loadFYs = async () => {
    try {
      setLoading(true);
      const data = await getFiscalYears();
      setFys(data);
      if (data.length > 0) setExp(new Set([data[0].id]));
    } catch (e) { toast('error', parseError(e)); }
    finally { setLoading(false); }
  };

  useEffect(() => { loadFYs(); }, []);

const loadPeriods = async (fyId: string) => {
  if (pMap[fyId]) return;
  try {
    const data = await getPeriods(fyId); 
    setPMap(p => ({ ...p, [fyId]: data })); 
  }
  catch (e) { toast('error', `Periods: ${parseError(e)}`); }
};

  const toggleFY = (fyId: string) => setExp(p => {
    const n = new Set(p); n.has(fyId) ? n.delete(fyId) : (n.add(fyId), loadPeriods(fyId)); return n;
  });

  /* ─── Auto-naming from dates ─── */
  useEffect(() => {
    if (!nameEdited.current && form.start_date && form.end_date) {
      setForm(f => ({ ...f, name: suggestName(f.start_date, f.end_date, fys.map(x => x.name)) }));
    }
  }, [form.start_date, form.end_date, fys]);

  /* ─── Validation ─── */
  const validate = (): boolean => {
    const e: Record<string, string> = {};
    if (!form.name.trim()) e.name = 'Name is required.';
    if (!form.start_date) e.start_date = 'Start date is required.';
    if (!form.end_date) e.end_date = 'End date is required.';
    if (form.start_date && form.end_date) {
      const s = new Date(form.start_date), d = new Date(form.end_date);
      if (d <= s) e.end_date = 'End date must be after start date.';
      else {
        const m = (d.getFullYear() - s.getFullYear()) * 12 + d.getMonth() - s.getMonth();
        if (m < 1) e.end_date = 'Must be at least 1 month.';
        if (m > 24) e.end_date = 'Cannot exceed 24 months.';
        if (m >= 1 && m <= 24 && fys.some(fy => s < new Date(fy.end_date) && d > new Date(fy.start_date)))
          e.end_date = 'Overlaps with an existing fiscal year.';
      }
    }
    setFErrs(e); return !Object.keys(e).length;
  };

  /* ─── Actions ─── */
  const handleCreate = async () => {
    if (!validate()) return;
    try {
      setSaving(true); setCErr(null);
      const name = form.name;
      await createFiscalYear(form);
      setShowCreate(false);
      setForm({ name: '', start_date: '', end_date: '', description: '' });
      setFErrs({}); nameEdited.current = false;
      toast('success', `"${name}" created successfully.`);
      await loadFYs();
    } catch (e) { setCErr(parseError(e)); } finally { setSaving(false); }
  };

  const handleClosePeriod = async () => {
    if (!cpTgt || !cpReason.trim()) return;
    try {
      setSaving(true); setCpErr(null);
      await closePeriod({ period_id: cpTgt.id, reason: cpReason.trim(), status: cpType });
      setPMap(p => { const n = { ...p }; delete n[cpTgt.fyId]; return n; });
      setShowCP(false); setCpReason('');
      toast('success', `"${cpTgt.name}" ${cpType === 'SOFT_CLOSED' ? 'soft' : 'hard'} closed.`);
      await loadFYs();
    } catch (e) { setCpErr(parseError(e)); } finally { setSaving(false); }
  };

  const handleReopen = async () => {
    if (!roTgt || !roReason.trim()) return;
    try {
      setSaving(true); setRoErr(null);
      await reopenPeriod({ period_id: roTgt.id, reason: roReason.trim() });
      setPMap(p => { const n = { ...p }; delete n[roTgt.fyId]; return n; });
      setShowRO(false); setRoReason('');
      toast('success', `"${roTgt.name}" reopened.`);
      await loadFYs();
    } catch (e) { setRoErr(parseError(e)); } finally { setSaving(false); }
  };

  const handleCloseFY = async () => {
    if (!cfyTgt || !cfyReason.trim()) return;
    try {
      setSaving(true); setCfyErr(null);
      cfyType === 'soft'
        ? await softCloseFiscalYear(cfyTgt.id, cfyReason.trim())
        : await hardCloseFiscalYear(cfyTgt.id, cfyReason.trim());
      setShowCFY(false); setCfyReason('');
      toast('success', `"${cfyTgt.name}" ${cfyType === 'soft' ? 'soft' : 'hard'} closed.`);
      await loadFYs();
    } catch (e) { setCfyErr(parseError(e)); } finally { setSaving(false); }
  };

  const fmtDate = (d: string, style: 'full' | 'short' = 'full') =>
    new Date(d).toLocaleDateString('en-PK', style === 'full'
      ? { day: 'numeric', month: 'short', year: 'numeric' }
      : { day: '2-digit', month: 'short' });

  const btnCls = (color: string) => `px-2.5 py-1.5 text-xs font-medium rounded-lg transition-colors border ${color}`;

  /* ═══════ RENDER ═══════ */
  return (
    <div className="p-6 max-w-5xl mx-auto relative">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Fiscal Calendar</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">Manage fiscal years and accounting periods</p>
        </div>
        <button onClick={() => { setShowCreate(true); setFErrs({}); setCErr(null); nameEdited.current = false; }}
          className="flex items-center gap-2 px-4 py-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 dark:hover:bg-blue-800 transition-colors shadow-sm">
          <Plus className="w-4 h-4" /> New Fiscal Year
        </button>
      </div>

      {/* List */}
      {loading ? (
        <div className="flex flex-col items-center justify-center py-20 gap-3">
          <Spin cls="w-8 h-8 text-blue-500" />
          <span className="text-sm text-gray-500 dark:text-gray-400">Loading fiscal years...</span>
        </div>
      ) : !fys.length ? (
        <div className="text-center py-20">
          <Calendar className="w-12 h-12 text-gray-300 dark:text-gray-600 mx-auto mb-4" />
          <p className="text-gray-500 dark:text-gray-400 font-medium">No fiscal years configured</p>
        </div>
      ) : (
        <div className="space-y-4">
          {fys.map(fy => {
            const open = exp.has(fy.id);
            const per = pMap[fy.id] || [];
            return (
              <div key={fy.id} className="border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden bg-white dark:bg-gray-800 shadow-sm">
                {/* FY Row */}
                <div className="flex items-center justify-between p-4 bg-gray-50 dark:bg-gray-900/50 cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-800/50 transition-colors"
                  onClick={() => toggleFY(fy.id)}>
                  <div className="flex items-center gap-3">
                    {open ? <ChevronUp className="w-5 h-5 text-gray-400" /> : <ChevronDown className="w-5 h-5 text-gray-400" />}
                    <Calendar className="w-5 h-5 text-blue-500 dark:text-blue-400" />
                    <div>
                      <div className="font-semibold text-gray-900 dark:text-white">{fy.name}</div>
                      <div className="text-sm text-gray-500 dark:text-gray-400">{fmtDate(fy.start_date)} — {fmtDate(fy.end_date)}</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="text-xs text-gray-500 dark:text-gray-400 hidden sm:block">
                      <span className="text-emerald-600 dark:text-emerald-400 font-medium">{fy.open_periods} open</span> /{' '}
                      <span className="text-amber-600 dark:text-amber-400">{fy.soft_closed_periods} soft</span> /{' '}
                      <span className="text-red-600 dark:text-red-400">{fy.hard_closed_periods} hard</span>
                    </div>
                    <Badge status={fy.status} />
                    {fy.status === 'OPEN' && (
                      <div className="flex items-center gap-1.5 ml-2" onClick={e => e.stopPropagation()}>
                        <button onClick={() => { setCfyTgt({ id: fy.id, name: fy.name }); setCfyType('soft'); setCfyReason(''); setCfyErr(null); setShowCFY(true); }}
                          className={btnCls('bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-400 border-amber-200 dark:border-amber-800/40 hover:bg-amber-100 dark:hover:bg-amber-900/40')}>
                          <Lock className="w-3 h-3 inline mr-1" />Soft Close
                        </button>
                        <button onClick={() => { setCfyTgt({ id: fy.id, name: fy.name }); setCfyType('hard'); setCfyReason(''); setCfyErr(null); setShowCFY(true); }}
                          className={btnCls('bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-400 border-red-200 dark:border-red-800/40 hover:bg-red-100 dark:hover:bg-red-900/40')}>
                          <ShieldCheck className="w-3 h-3 inline mr-1" />Hard Close
                        </button>
                      </div>
                    )}
                  </div>
                </div>
                {/* Periods Table */}
                {open && (
                  <div className="border-t border-gray-200 dark:border-gray-700">
                    <table className="w-full">
                      <thead>
                        <tr className="bg-gray-50 dark:bg-gray-900/50 text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                          <th className="text-left px-4 py-2.5 w-16">Period</th>
                          <th className="text-left px-4 py-2.5">Name</th>
                          <th className="text-left px-4 py-2.5 hidden md:table-cell">Dates</th>
                          <th className="text-left px-4 py-2.5 w-28">Status</th>
                          <th className="text-right px-4 py-2.5 w-44">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {!per.length ? (
                          <tr><td colSpan={5} className="text-center py-10 text-gray-400 dark:text-gray-500"><Spin cls="w-5 h-5 mx-auto mb-2" />Loading periods...</td></tr>
                        ) : per.map(p => (
                          <tr key={p.id} className="border-t border-gray-100 dark:border-gray-700/50 hover:bg-gray-50/50 dark:hover:bg-gray-700/20 bg-white dark:bg-gray-800 transition-colors">
                            <td className="px-4 py-3 text-sm font-medium text-gray-600 dark:text-gray-300">{p.period_number}</td>
                            <td className="px-4 py-3 text-sm text-gray-900 dark:text-white font-medium">{p.name}</td>
                            <td className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400 hidden md:table-cell">{fmtDate(p.start_date, 'short')} – {fmtDate(p.end_date, 'short')}</td>
                            <td className="px-4 py-3"><Badge status={p.status} /></td>
                            <td className="px-4 py-3 text-right">
                              {p.status === 'OPEN' ? (
                                <div className="flex items-center justify-end gap-1.5">
                                  <button onClick={() => { setCpTgt({ id: p.id, name: p.name, fyId: fy.id }); setCpType('SOFT_CLOSED'); setCpReason(''); setCpErr(null); setShowCP(true); }}
                                    className={btnCls('bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-400 border-amber-200 dark:border-amber-800/40 hover:bg-amber-100 dark:hover:bg-amber-900/40')}>
                                    <Lock className="w-3 h-3 inline mr-1" />Soft
                                  </button>
                                  <button onClick={() => { setCpTgt({ id: p.id, name: p.name, fyId: fy.id }); setCpType('HARD_CLOSED'); setCpReason(''); setCpErr(null); setShowCP(true); }}
                                    className={btnCls('bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-400 border-red-200 dark:border-red-800/40 hover:bg-red-100 dark:hover:bg-red-900/40')}>
                                    Hard
                                  </button>
                                </div>
                              ) : (
                                <button onClick={() => { setRoTgt({ id: p.id, name: p.name, fyId: fy.id }); setRoReason(''); setRoErr(null); setShowRO(true); }}
                                  className={btnCls('bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800/40 hover:bg-emerald-100 dark:hover:bg-emerald-900/40')}>
                                  <Unlock className="w-3 h-3 inline mr-1" />Reopen
                                </button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ═══ TOASTS ═══ */}
      <div className="fixed bottom-6 right-6 z-[100] flex flex-col gap-2 max-w-sm">
        {toasts.map(t => (
          <div key={t.id}
            className={`flex items-start gap-3 px-4 py-3 rounded-xl shadow-lg border ${t.type === 'success'
              ? 'bg-emerald-50/95 dark:bg-emerald-900/30 border-emerald-200 dark:border-emerald-800/60'
              : 'bg-red-50/95 dark:bg-red-900/30 border-red-200 dark:border-red-800/60'}`}
            style={{ animation: 'slideIn .3s ease-out' }}>
            {t.type === 'success'
              ? <CheckCircle2 className="w-5 h-5 text-emerald-500 dark:text-emerald-400 flex-shrink-0 mt-0.5" />
              : <AlertCircle className="w-5 h-5 text-red-500 dark:text-red-400 flex-shrink-0 mt-0.5" />}
            <p className={`text-sm flex-1 ${t.type === 'success' ? 'text-emerald-800 dark:text-emerald-300' : 'text-red-800 dark:text-red-300'}`}>{t.msg}</p>
            <button onClick={() => setToasts(p => p.filter(x => x.id !== t.id))} className="text-gray-400 hover:text-gray-600"><X className="w-4 h-4" /></button>
          </div>
        ))}
      </div>
      <style jsx>{`@keyframes slideIn{from{opacity:0;transform:translateX(100%)}to{opacity:1;transform:translateX(0)}}`}</style>

      {/* ═══ CREATE MODAL ═══ */}
      <Modal open={showCreate} onClose={() => setShowCreate(false)} error={cErr} onClearError={() => setCErr(null)}
        footer={
          <>
            <button onClick={() => setShowCreate(false)} className="px-4 py-2.5 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg">Cancel</button>
            <button onClick={handleCreate} disabled={saving || !form.name || !form.start_date || !form.end_date}
              className="px-5 py-2.5 text-sm font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm flex items-center gap-2">
              {saving ? <><Spin />Creating...</> : 'Create Fiscal Year'}
            </button>
          </>
        }>
        <ModalHeader icon={<div className="p-2 rounded-lg bg-blue-50 dark:bg-blue-900/20"><Plus className="w-5 h-5 text-blue-600 dark:text-blue-400" /></div>}
          title="Create Fiscal Year" subtitle="Define date range — name auto-suggests" onClose={() => setShowCreate(false)} />

        <Field label="Fiscal Year Name" req err={fErrs.name}>
          <div className="relative">
            <input type="text" value={form.name} onChange={e => { setForm(f => ({ ...f, name: e.target.value })); nameEdited.current = true; if (fErrs.name) setFErrs(p => { const n = { ...p }; delete n.name; return n; }); if (cErr) setCErr(null); }}
              className={inputCls(fErrs.name)} placeholder="e.g., FY 2028-29" autoFocus />
            {!nameEdited.current && form.name && (
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-blue-400" title="Auto-suggested from dates">
                <Sparkles className="w-4 h-4" />
              </span>
            )}
          </div>
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Start Date" req err={fErrs.start_date}>
            <input type="date" value={form.start_date} onChange={e => { setForm(f => ({ ...f, start_date: e.target.value })); if (fErrs.start_date) setFErrs(p => { const n = { ...p }; delete n.start_date; return n; }); }}
              className={inputCls(fErrs.start_date)} />
          </Field>
          <Field label="End Date" req err={fErrs.end_date}>
            <input type="date" value={form.end_date} onChange={e => { setForm(f => ({ ...f, end_date: e.target.value })); if (fErrs.end_date) setFErrs(p => { const n = { ...p }; delete n.end_date; return n; }); }}
              className={inputCls(fErrs.end_date)} />
          </Field>
        </div>

        {form.start_date && form.end_date && new Date(form.end_date) > new Date(form.start_date) && !fErrs.end_date && (() => {
          const s = new Date(form.start_date), d = new Date(form.end_date);
          return (d.getFullYear() - s.getFullYear()) * 12 + d.getMonth() - s.getMonth();
        })() >= 1 && (
          <div className="flex items-center gap-2.5 p-3 bg-blue-50 dark:bg-blue-900/15 border border-blue-200 dark:border-blue-800/60 rounded-lg text-sm text-blue-700 dark:text-blue-400">
            <Calendar className="w-4 h-4 flex-shrink-0" />
            <span>Duration: <strong>{(() => { const s = new Date(form.start_date), d = new Date(form.end_date); const m = (d.getFullYear() - s.getFullYear()) * 12 + d.getMonth() - s.getMonth(); return `${m} month${m > 1 ? 's' : ''}`; })()}</strong> → {(() => { const s = new Date(form.start_date), d = new Date(form.end_date); const m = (d.getFullYear() - s.getFullYear()) * 12 + d.getMonth() - s.getMonth(); return `${m} period${m > 1 ? 's' : ''}`; })()} will be created</span>
          </div>
        )}

        <Field label="Description">
          <textarea value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} rows={2}
            className={inputCls()} placeholder="Optional..." />
        </Field>
      </Modal>

      {/* ═══ CLOSE PERIOD MODAL ═══ */}
      <Modal open={showCP} onClose={() => { setShowCP(false); setCpReason(''); }} error={cpErr} onClearError={() => setCpErr(null)}
        footer={
          <>
            <button onClick={() => { setShowCP(false); setCpReason(''); }} className="px-4 py-2.5 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg">Cancel</button>
            <button onClick={handleClosePeriod} disabled={saving || !cpReason.trim()}
              className={`px-5 py-2.5 text-sm font-medium text-white rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm flex items-center gap-2 ${cpType === 'SOFT_CLOSED' ? 'bg-amber-600 hover:bg-amber-700' : 'bg-red-600 hover:bg-red-700'}`}>
              {saving ? <><Spin />Closing...</> : `Confirm ${cpType === 'SOFT_CLOSED' ? 'Soft' : 'Hard'} Close`}
            </button>
          </>
        }>
        <ModalHeader
          icon={<div className={`p-2 rounded-lg ${cpType === 'SOFT_CLOSED' ? 'bg-amber-50 dark:bg-amber-900/20' : 'bg-red-50 dark:bg-red-900/20'}`}>
            <Lock className={`w-5 h-5 ${cpType === 'SOFT_CLOSED' ? 'text-amber-600 dark:text-amber-400' : 'text-red-600 dark:text-red-400'}`} />
          </div>}
          title={`${cpType === 'SOFT_CLOSED' ? 'Soft' : 'Hard'} Close Period`}
          subtitle={cpType === 'SOFT_CLOSED' ? 'Can be reopened later' : 'This action is irreversible'}
          onClose={() => { setShowCP(false); setCpReason(''); }} />

        <div className="p-3 bg-gray-50 dark:bg-gray-900/50 rounded-lg border border-gray-200 dark:border-gray-700">
          <p className="text-sm text-gray-600 dark:text-gray-300">You are about to {cpType === 'SOFT_CLOSED' ? 'soft close' : 'hard close'}:</p>
          <p className="text-sm font-semibold text-gray-900 dark:text-white mt-1">&quot;{cpTgt?.name}&quot;</p>
        </div>

        {cpType === 'HARD_CLOSED' && (
          <div className="flex items-start gap-2.5 p-3 bg-red-50 dark:bg-red-900/15 border border-red-200 dark:border-red-800/60 rounded-lg">
            <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
            <p className="text-sm text-red-700 dark:text-red-400"><strong>Warning:</strong> Hard closed periods cannot be modified or reopened.</p>
          </div>
        )}

        <Field label="Reason for Closing" req>
          <textarea value={cpReason} onChange={e => { setCpReason(e.target.value); if (cpErr) setCpErr(null); }} rows={3}
            className={inputCls()} placeholder="e.g., All entries verified and approved..." autoFocus />
        </Field>
      </Modal>

      {/* ═══ REOPEN MODAL ═══ */}
      <Modal open={showRO} onClose={() => { setShowRO(false); setRoReason(''); }} error={roErr} onClearError={() => setRoErr(null)}
        footer={
          <>
            <button onClick={() => { setShowRO(false); setRoReason(''); }} className="px-4 py-2.5 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg">Cancel</button>
            <button onClick={handleReopen} disabled={saving || !roReason.trim()}
              className="px-5 py-2.5 text-sm font-medium bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm flex items-center gap-2">
              {saving ? <><Spin />Reopening...</> : 'Confirm Reopen'}
            </button>
          </>
        }>
        <ModalHeader
          icon={<div className="p-2 rounded-lg bg-emerald-50 dark:bg-emerald-900/20"><Unlock className="w-5 h-5 text-emerald-600 dark:text-emerald-400" /></div>}
          title="Reopen Period" subtitle="Allow new entries in this period"
          onClose={() => { setShowRO(false); setRoReason(''); }} />

        <div className="p-3 bg-gray-50 dark:bg-gray-900/50 rounded-lg border border-gray-200 dark:border-gray-700">
          <p className="text-sm text-gray-600 dark:text-gray-300">Reopening period:</p>
          <p className="text-sm font-semibold text-gray-900 dark:text-white mt-1">&quot;{roTgt?.name}&quot;</p>
        </div>

        <div className="flex items-start gap-2.5 p-3 bg-amber-50 dark:bg-amber-900/15 border border-amber-200 dark:border-amber-800/60 rounded-lg">
          <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" />
          <p className="text-sm text-amber-700 dark:text-amber-400"><strong>Note:</strong> Requires CEO approval and will be logged for audit.</p>
        </div>

        <Field label="Reason for Reopening" req>
          <textarea value={roReason} onChange={e => { setRoReason(e.target.value); if (roErr) setRoErr(null); }} rows={3}
            className={inputCls()} placeholder="e.g., Correction needed for Q3 reconciliation..." autoFocus />
        </Field>
      </Modal>

      {/* ═══ CLOSE FY MODAL ═══ */}
      <Modal open={showCFY} onClose={() => { setShowCFY(false); setCfyReason(''); }} error={cfyErr} onClearError={() => setCfyErr(null)}
        footer={
          <>
            <button onClick={() => { setShowCFY(false); setCfyReason(''); }} className="px-4 py-2.5 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg">Cancel</button>
            <button onClick={handleCloseFY} disabled={saving || !cfyReason.trim()}
              className={`px-5 py-2.5 text-sm font-medium text-white rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm flex items-center gap-2 ${cfyType === 'soft' ? 'bg-amber-600 hover:bg-amber-700' : 'bg-red-600 hover:bg-red-700'}`}>
              {saving ? <><Spin />Closing...</> : `Confirm ${cfyType === 'soft' ? 'Soft' : 'Hard'} Close`}
            </button>
          </>
        }>
        <ModalHeader
          icon={<div className={`p-2 rounded-lg ${cfyType === 'soft' ? 'bg-amber-50 dark:bg-amber-900/20' : 'bg-red-50 dark:bg-red-900/20'}`}>
            {cfyType === 'soft'
              ? <Lock className="w-5 h-5 text-amber-600 dark:text-amber-400" />
              : <ShieldCheck className="w-5 h-5 text-red-600 dark:text-red-400" />}
          </div>}
          title={`${cfyType === 'soft' ? 'Soft' : 'Hard'} Close Fiscal Year`}
          subtitle={cfyType === 'soft' ? 'Can be reopened if needed' : 'Permanent and irreversible'}
          onClose={() => { setShowCFY(false); setCfyReason(''); }} />

        <div className="p-3 bg-gray-50 dark:bg-gray-900/50 rounded-lg border border-gray-200 dark:border-gray-700">
          <p className="text-sm text-gray-600 dark:text-gray-300">You are about to {cfyType === 'soft' ? 'soft close' : 'hard close'}:</p>
          <p className="text-base font-semibold text-gray-900 dark:text-white mt-1">&quot;{cfyTgt?.name}&quot;</p>
        </div>

        <div className={`flex items-start gap-2.5 p-3 rounded-lg border ${cfyType === 'hard'
          ? 'bg-red-50 dark:bg-red-900/15 border-red-200 dark:border-red-800/60'
          : 'bg-amber-50 dark:bg-amber-900/15 border-amber-200 dark:border-amber-800/60'}`}>
          <AlertTriangle className={`w-4 h-4 flex-shrink-0 mt-0.5 ${cfyType === 'hard' ? 'text-red-500' : 'text-amber-500'}`} />
          <p className={`text-sm ${cfyType === 'hard' ? 'text-red-700 dark:text-red-400' : 'text-amber-700 dark:text-amber-400'}`}>
            <strong>{cfyType === 'hard' ? 'Critical:' : 'Note:'}</strong>{' '}
            {cfyType === 'hard'
              ? 'This is permanent. All periods must be closed first. Cannot be undone.'
              : 'All periods must be closed before soft closing the year.'}
          </p>
        </div>

        <Field label={`Reason for ${cfyType === 'soft' ? 'Soft' : 'Hard'} Closing`} req>
          <textarea value={cfyReason} onChange={e => { setCfyReason(e.target.value); if (cfyErr) setCfyErr(null); }} rows={3}
            className={inputCls()} placeholder={cfyType === 'soft' ? 'e.g., All periods closed, year-end complete...' : 'e.g., Annual audit completed, all verified...'} autoFocus />
        </Field>
      </Modal>
    </div>
  );
}
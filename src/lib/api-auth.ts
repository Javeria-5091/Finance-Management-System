/ =============================================================================
// API AUTH MIDDLEWARE — Server-side authentication + permission check for all API routes
// =============================================================================

import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
// FIX: the published libpg-query package exports "parse" (and "parseSync"),
// NOT "parseQuery". Importing parseQuery caused
// "Module '\"libpg-query\"' has no exported member 'parseQuery'".
import { parse } from 'libpg-query';

// ---------- Types ----------
export interface AuthResult {
  userId: string;
  email: string | null;
  role: string;
  orgId: string | null;
}

// ---------- Blocklist: SQL keywords that must NEVER appear in AI-generated queries ----------
// NOTE: kept for defense-in-depth / fast-fail, but isSqlSafe() below no longer
// relies on this list alone — real validation now happens via AST parsing.
export const DANGEROUS_SQL_KEYWORDS = [
  'DROP', 'ALTER', 'CREATE', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE',
  'GRANT', 'REVOKE', 'EXECUTE', 'COPY', 'REFRESH MATERIALIZED',
  'CREATEUSER', 'CREATEROLE', 'ALTER USER', 'SET PASSWORD',
  'pg_read_file', 'pg_write_file', 'pg_ls_dir', 'lo_import', 'lo_export',
];

// ---------- Role hierarchy for approval checks ----------
const APPROVAL_ROLES: Record<string, number> = {
  CEO: 100,
  FINANCE_HEAD: 80,
  ACCOUNTANT: 60,
  AUDITOR: 55,
  HOD: 40,
  PROJECT_MANAGER: 20,
  TECHNICAL_ADMIN: 15,
  EMPLOYEE: 10,
  VIEWER: 0,
  Admin: 100,
};

// ---------- Core: get authenticated user from session ----------
export async function getAuthUser(): Promise<AuthResult | NextResponse> {
  const cookieStore = await cookies();

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // Server Component — read-only cookies
          }
        },
      },
    }
  );

  const { data: { session }, error } = await supabase.auth.getSession();

  if (error || !session?.user) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  }

  // Fetch role from profiles (fallback chain)
  let role = 'VIEWER';
  let orgId: string | null = null;

  // Method 1: RPC
  try {
    const { data: rpcData } = await supabase.rpc('get_my_user_roles');
    const arr = Array.isArray(rpcData) ? rpcData : rpcData ? [rpcData] : [];
    const today = new Date().toISOString().split('T')[0];
    const active = arr
      .filter((r: any) => r.is_active !== false && r.effective_from <= today && (!r.effective_to || r.effective_to >= today))
      .sort((a: any, b: any) => (b.effective_from || '').localeCompare(a.effective_from || ''))[0];
    if (active) role = active.role || active.role_name || role;
  } catch {}

  // Method 2: Profile fallback
  // NOTE: 'profiles' is confirmed to live in the PUBLIC schema — keep unqualified.
  if (role === 'VIEWER') {
    const { data: profile } = await supabase
      .from('profiles')
      .select('role, organization_id')
      .eq('user_id', session.user.id)
      .maybeSingle();
    if (profile?.role) role = profile.role;
    orgId = profile?.organization_id || null;
  }

  return { userId: session.user.id, email: session.user.email ?? null, role, orgId };
}

// ---------- Unified auth for API routes: Cookie session + Bearer token fallback ----------
// Fixes "Unauthorized" for logged-in users whose browser client stores session in localStorage
export async function getAuthSupabase(req?: Request) {
  const cookieStore = await cookies();
  const header = req?.headers.get('authorization');
  const bearer = header?.startsWith('Bearer ') ? header.slice(7) : null;

  // FIX Bug 7.5: Proper setAll implementation for bearer token refresh.
  // Previously setAll: () => {} meant refreshed tokens were never persisted.
  const setAllCookies = (cookiesToSet: any[]) => {
    try {
      cookiesToSet.forEach(({ name, value, options }: any) =>
        cookieStore.set(name, value, options)
      );
    } catch {
      // Server Component — read-only cookies
    }
  };

  const supabase = bearer
    ? createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
        global: { headers: { Authorization: `Bearer ${bearer}` } },
      })
    : createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
        cookies: { getAll: () => cookieStore.getAll(), setAll: setAllCookies },
      });

  const { data, error } = await supabase.auth.getUser();
  return { supabase, user: data.user ?? null, authError: error };
}

// ---------- Require specific permission ----------
// NOTE (merge fix): one of the two source versions of this function referenced
// `cookieStore` inside its own createServerClient() call without ever
// declaring `const cookieStore = await cookies();` in this function's scope —
// that would throw "cookieStore is not defined" at runtime. Using the
// working version here.
export async function requirePermission(requiredPerm: string): Promise<AuthResult | NextResponse> {
  const auth = await getAuthUser();
  if (auth instanceof NextResponse) return auth; // 401

  // ─── SECURITY FIX (BUG-002 / Spec Appendix A) ───
  // Only CEO has an unconditional permission bypass. Technical Admin ("Admin")
  // is NOT a finance role — per Appendix A it has "None" for finance-data
  // resources and only "Read security" for audit logs. Admin must go through
  // the same permission-table lookup as every other non-CEO role below, so
  // that its actual rights are whatever is granted (config-driven) rather
  // than hardcoded full access. Previously `auth.role === 'Admin'` was
  // treated identically to CEO here, letting a technical administrator
  // create/approve/post financial transactions with no configured permission.
  if (auth.role === 'CEO') return auth;

  // Check against permission table via RPC
  try {
    const cookieStore = await cookies();
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll: () => cookieStore.getAll(),
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

    // Try RPC first
    const { data: perms } = await supabase.rpc('get_my_permissions');
    if (perms) {
      const permObj = !Array.isArray(perms) && typeof perms === 'object' ? perms : null;
      if (permObj && permObj[requiredPerm] === true) return auth;
      if (Array.isArray(perms) && perms.some((p: any) => (p.permission_code || p.perm_code || p.code) === requiredPerm)) return auth;
    }
  } catch {}

  return NextResponse.json({ error: 'Insufficient permissions' }, { status: 403 });
}

// ---------- Maker-Checker: ensure approver is NOT the creator ----------
export function enforceMakerChecker(creatorId: string, approverId: string): boolean {
  return creatorId !== approverId;
}

// ---------- Approval amount limit check ----------
// SECURITY FIX (BUG-009 / Spec Appendix A): AUDITOR must have "No create,
// edit, approve, or post" authority — it is a read-only role. The previous
// AUDITOR: 500000 entry granted auditors a real approval limit, letting them
// approve transactions up to that amount. AUDITOR is intentionally absent
// from this table now, so it falls through to the `?? 0` default below and
// no amount can be approved by an auditor. (This is defense-in-depth on top
// of the permission-table check in requirePermission()/workflow route,
// which should already deny AUDITOR the APPROVE_* permission in the first
// place — but an approval-limit table that still granted 500k was a real
// bypass if that permission check were ever misconfigured.)
export function checkApprovalLimit(userRole: string, amount: number): { allowed: boolean; reason: string } {
  const LIMITS: Record<string, number> = {
    CEO: Infinity,
    FINANCE_HEAD: 500000,
    ACCOUNTANT: 100000,
    HOD: 100000,
    PROJECT_MANAGER: 25000,
  };

  const limit = LIMITS[userRole] ?? 0;
  if (amount <= limit) return { allowed: true, reason: '' };
  return {
    allowed: false,
    reason: `Amount PKR ${amount.toLocaleString()} exceeds your approval limit of PKR ${limit.toLocaleString()}. Requires ${getNextApproverRole(userRole)} approval.`,
  };
}

function getNextApproverRole(currentRole: string): string {
 const level = APPROVAL_ROLES[currentRole] ?? 0;
 for (const [role, lvl] of Object.entries(APPROVAL_ROLES)) {
    if (lvl > level && lvl !== 100) return role;
  }
  return 'CEO';
}

// =============================================================================
// AI SQL SAFETY — Spec 9.5
// =============================================================================

// ---------- Schemas the AI is ever allowed to touch ----------
// NOTE: 'finance' was intentionally removed from the allowlist. After running
// migration P1_007_ai_security_hardening.sql, the DB role that actually
// executes these queries (ai_readonly_role) has ZERO grants on finance.*
// tables — so any query touching finance.* now fails closed at the database
// layer too. This app-level list just gives a clean error earlier, before
// the request even reaches Postgres.
const ALLOWED_SCHEMAS = new Set(['reporting', 'public']);
const BLOCKED_SCHEMAS = new Set(['core', 'auth', 'storage', 'audit', 'ai', 'pg_catalog', 'information_schema']);

// Functions that must never appear in an AI-generated query, regardless of
// which schema they're called from.
const DANGEROUS_FUNCTIONS = [
  'pg_read_file', 'pg_read_binary_file', 'pg_write_file', 'pg_ls_dir',
  'lo_import', 'lo_export', 'dblink', 'dblink_exec', 'dblink_connect',
  'pg_terminate_backend', 'pg_reload_conf', 'pg_sleep', 'set_config',
];

// Statement node types that must never appear anywhere in the parsed tree —
// including nested inside a CTE, which a regex-based check cannot see.
const FORBIDDEN_NODE_TYPES = [
  'InsertStmt', 'UpdateStmt', 'DeleteStmt', 'TruncateStmt',
  'CreateStmt', 'DropStmt', 'AlterTableStmt', 'GrantStmt', 'GrantRoleStmt',
  'CopyStmt', 'DoStmt', 'CreateFunctionStmt', 'CreateRoleStmt',
  'AlterRoleStmt', 'VacuumStmt', 'ExecuteStmt', 'PrepareStmt',
  'ViewStmt', 'IndexStmt', 'CreateSchemaStmt', 'TransactionStmt',
];

// Recursively collect every table reference (RangeVar) and function call
// (FuncCall) node in a parsed statement, and throw immediately if any
// data-modifying / DDL statement node is found anywhere in the tree.
function walkAstNode(node: any, rangeVars: any[], funcCalls: string[]): void {
  if (!node || typeof node !== 'object') return;

  if (Array.isArray(node)) {
    for (const item of node) walkAstNode(item, rangeVars, funcCalls);
    return;
  }

  for (const forbidden of FORBIDDEN_NODE_TYPES) {
    if (node[forbidden]) {
      throw new Error(`Disallowed statement type detected: ${forbidden}`);
    }
  }

  if (node.RangeVar) rangeVars.push(node.RangeVar);

  if (node.FuncCall) {
    const nameParts = (node.FuncCall.funcname || [])
      .map((n: any) => n?.String?.sval ?? n?.String?.str)
      .filter(Boolean);
    if (nameParts.length) funcCalls.push(nameParts.join('.').toLowerCase());
  }

  for (const key of Object.keys(node)) {
    walkAstNode(node[key], rangeVars, funcCalls);
  }
}

// ---------- SQL safety check for AI (Spec 9.5) — real AST parsing ----------
// Replaces the old regex/keyword-based check, which could be bypassed by
// comment obfuscation, unusual whitespace, or nested/CTE-hidden writes.
// This parses the query with Postgres's own grammar (via libpg-query), so
// it sees the query the exact same way the database will.
export async function isSqlSafe(sql: string): Promise<{ safe: boolean; reason: string }> {
  let parsed: any;
  try {
    // ✅ FIX: use parse(), not parseQuery() — see import comment above.
    parsed = await parse(sql);
  } catch {
    return { safe: false, reason: 'Query failed to parse as valid SQL.' };
  }

  const stmts = parsed?.stmts ?? [];
  if (stmts.length !== 1) {
    return { safe: false, reason: 'Only a single SELECT statement is allowed.' };
  }

  const topStmt = stmts[0]?.stmt;
  if (!topStmt?.SelectStmt) {
    return { safe: false, reason: 'Only SELECT (or WITH ... SELECT) statements are allowed.' };
  }

  const rangeVars: any[] = [];
  const funcCalls: string[] = [];
  try {
    walkAstNode(topStmt, rangeVars, funcCalls);
  } catch (err: any) {
    return { safe: false, reason: err.message };
  }

  // Every table/view reference must be schema-qualified and allowlisted.
  for (const rv of rangeVars) {
    const schema = rv.schemaname;
    if (!schema) {
      return {
        safe: false,
        reason: `Table "${rv.relname}" must be schema-qualified, e.g. reporting.${rv.relname}.`,
      };
    }
    if (BLOCKED_SCHEMAS.has(schema) || !ALLOWED_SCHEMAS.has(schema)) {
      return { safe: false, reason: `Access to schema "${schema}" is not permitted.` };
    }
  }

  // No dangerous system/file/superuser functions anywhere in the tree.
  for (const fn of funcCalls) {
    if (DANGEROUS_FUNCTIONS.some((d) => fn.includes(d))) {
      return { safe: false, reason: `Function "${fn}" is not permitted.` };
    }
  }

  return { safe: true, reason: '' };
}

// ---------- Spec 9.5: Inject Scope Programmatically ----------
// ⚠️ MERGE NOTE: one source version removed this block entirely, claiming it
// was dead code and that scope-wrapping had fully moved into a DB function
// (execute_ai_readonly_query, per P1_006_ai_function.sql v2). That may be
// true going forward — but it was kept here because we don't know whether
// any OTHER route file in this codebase still imports injectScope/
// validateUuid from this module. Deleting it blind is exactly what broke
// your build. Recommended next step: grep the codebase for
// `injectScope(` and `validateUuid(` — if nothing outside this file calls
// them anymore, it's then safe to delete this whole block and rely purely
// on the DB function.
function isValidUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function sqlUuid(value: string): string {
  if (!isValidUuid(value)) {
    throw new Error(`Invalid UUID detected: ${value.slice(0, 8)}...`);
  }
  return `'${value}'`;
}

export function validateUuid(value: string): boolean {
  return isValidUuid(value);
}

export function injectScope(sql: string, orgId: string, userId: string, enforceUserScope: boolean): string {
  const safeOrgId = sqlUuid(orgId);
  const safeUserId = sqlUuid(userId);

  const cleanSql = sql.replace(/;\s*$/, '').trim();

  return `
    SELECT COALESCE(jsonb_agg(t), '[]'::jsonb) FROM (
      WITH llm_query AS (
        ${cleanSql}
      )
      SELECT * FROM llm_query
      WHERE 1=1
        AND organization_id = ${safeOrgId}
        ${enforceUserScope ? `AND user_id = ${safeUserId}` : ''}
      LIMIT 200
    ) t;
  `;
}

// ---------- AI Daily Limit Check (Spec 9.11) ----------
export async function checkAiDailyLimit(
  supabase: any,
  userId: string,
  orgId: string,
  maxRequests: number = 200,
  maxCost: number = 2.0
): Promise<{ allowed: boolean; reason: string }> {
  try {
    const today = new Date().toISOString().split('T')[0];
    // ✅ FIX: ai_user_cost_tracking lives in the 'ai' schema.
    // .from('ai.ai_user_cost_tracking') is invalid supabase-js syntax — must use
    // .schema('ai').from('ai_user_cost_tracking').
    const { data: existing, error } = await supabase
      .schema('ai')
      .from('ai_user_cost_tracking')
      .select('request_count, estimated_cost')
      .eq('user_id', userId)
      .eq('organization_id', orgId)
      .eq('period_date', today)
      .maybeSingle();

    if (error) {
      console.error('checkAiDailyLimit fetch error:', error.message);
    }

    const requests = existing?.request_count || 0;
    const cost = parseFloat(existing?.estimated_cost || '0');

    if (requests >= maxRequests) {
      return { allowed: false, reason: `Daily AI request limit (${maxRequests}) reached.` };
    }
    if (cost >= maxCost) {
      return { allowed: false, reason: 'Daily AI cost limit reached. Contact administrator.' };
    }
    return { allowed: true, reason: '' };
  } catch (err: any) {
    console.error('checkAiDailyLimit unexpected error:', err.message);
    // SECURITY FIX: On error, DENY access instead of allowing.
    return { allowed: false, reason: 'Rate limit check failed. Please try again later.' };
  }
}

// ---------- Org-wide AI Daily Limit Check (Spec 9.11: "Per-user AND company limits") ----------
// checkAiDailyLimit() above only checks the individual user's usage. Spec
// 9.11 requires a company-wide ceiling too — otherwise many users each
// under their own limit can still exhaust the org's AI budget.
export async function checkOrgAiDailyLimit(
  supabase: any,
  orgId: string,
  maxOrgRequests: number = 2000,
  maxOrgCost: number = 30.0
): Promise<{ allowed: boolean; reason: string }> {
  try {
    const today = new Date().toISOString().split('T')[0];
    const { data, error } = await supabase
      .schema('ai')
      .from('ai_user_cost_tracking')
      .select('request_count, estimated_cost')
      .eq('organization_id', orgId)
      .eq('period_date', today);

    if (error) {
      console.error('checkOrgAiDailyLimit fetch error:', error.message);
      return { allowed: false, reason: 'Org rate limit check failed. Please try again later.' };
    }

    const rows = data || [];
    const totalRequests = rows.reduce((sum: number, r: any) => sum + (r.request_count || 0), 0);
    const totalCost = rows.reduce((sum: number, r: any) => sum + parseFloat(r.estimated_cost || '0'), 0);

    if (totalRequests >= maxOrgRequests) {
      return { allowed: false, reason: 'Organization-wide daily AI request limit reached. Contact administrator.' };
    }
    if (totalCost >= maxOrgCost) {
      return { allowed: false, reason: 'Organization-wide daily AI cost limit reached. Contact administrator.' };
    }
    return { allowed: true, reason: '' };
  } catch (err: any) {
    console.error('checkOrgAiDailyLimit unexpected error:', err.message);
    return { allowed: false, reason: 'Org rate limit check failed. Please try again later.' };
  }
}

// ---------- recordAiUsage — Spec 9.11 cost control ----------
// checkAiDailyLimit()/checkOrgAiDailyLimit() only ever READ
// ai.ai_user_cost_tracking. Something must WRITE to it too, or
// request_count/estimated_cost stay at 0 forever and the limits never
// trigger. Calls the atomic ai.increment_usage() Postgres function
// (P1_008_ai_hardening_fixes.sql) once per AI request, after the model
// call(s) complete, so concurrent requests can't race/undercount.
//
// Call this from the AI gateway route exactly once per request, on every
// exit path (success, refused, clarify, denied, blocked, error) — every
// path still consumes at least one model call and should count against
// the daily limit.
const DEFAULT_COST_PER_1K_TOKENS = 0.0006; // rough Groq Llama 3.3 70B blended rate; override with actual cost_per_1k_tokens from ai_model_registry where known

export async function recordAiUsage(
  supabase: any,
  userId: string,
  orgId: string,
  tokens: number,
  costUsd?: number
): Promise<void> {
  try {
    const estimatedCost = costUsd ?? (Math.max(tokens, 0) / 1000) * DEFAULT_COST_PER_1K_TOKENS;

    const { error } = await supabase.schema('ai').rpc('increment_usage', {
      p_user_id: userId,
      p_organization_id: orgId,
      p_tokens: Math.max(Math.round(tokens), 0),
      p_cost: estimatedCost,
    });

    if (error) {
      console.error('recordAiUsage RPC error:', error.message);
    }
  } catch (err: any) {
    console.error('recordAiUsage unexpected error:', err.message);
  }
}
FILE 2 — src/app/api/admin/users/route.ts
typescript
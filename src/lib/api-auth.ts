// =============================================================================
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
  let role: string | null = null;
  let orgId: string | null = null;
  let roleRpcError: unknown = null;

  // Method 1: resolve the active role from the RPC. Retry once for transient
  // failures, but NEVER silently convert an unresolved role into VIEWER.
  let rpcData: any = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const result = await supabase.rpc('get_my_user_roles');
      rpcData = result.data;
      roleRpcError = result.error ?? null;
    } catch (thrown) {
      roleRpcError = thrown;
    }

    if (!roleRpcError) break;
    if (attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }

  if (roleRpcError) {
    console.error('[api-auth] get_my_user_roles failed after retry', {
      userId: session.user.id,
      error: roleRpcError,
    });
  } else {
    const arr = Array.isArray(rpcData) ? rpcData : rpcData ? [rpcData] : [];
    const today = new Date().toISOString().split('T')[0];
    const active = arr
      .filter((r: any) =>
        r?.is_active !== false &&
        r?.effective_from <= today &&
        (!r?.effective_to || r.effective_to >= today)
      )
      .sort((a: any, b: any) =>
        (b?.effective_from || '').localeCompare(a?.effective_from || '')
      )[0];

    if (active) {
      role = active.role || active.role_name || null;
    }
  }

  // Always fetch the profile for tenant context and as an explicit role
  // recovery source. This is NOT a silent VIEWER fallback: if both the role
  // RPC and profile role are unavailable, the request fails closed with 503.
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('role, organization_id')
    .eq('user_id', session.user.id)
    .maybeSingle();

  if (profileError) {
    console.error('[api-auth] profile lookup failed', {
      userId: session.user.id,
      error: profileError,
    });
  }

  if (!role && profile?.role) {
    role = profile.role === 'Admin' ? 'CEO' : profile.role;
    console.warn('[api-auth] using explicit profiles.role fallback because role RPC was unavailable', {
      userId: session.user.id,
      role,
    });
  }

  orgId = profile?.organization_id || null;

  if (!role) {
    console.error('[api-auth] role resolution failed closed', {
      userId: session.user.id,
      rpcError: roleRpcError,
      profileError,
    });
    return NextResponse.json(
      { error: 'Unable to resolve user role. Please try again.' },
      { status: 503 }
    );
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

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      global: bearer ? { headers: { Authorization: `Bearer ${bearer}` } } : undefined,
      cookies: { getAll: () => cookieStore.getAll(), setAll: setAllCookies },
    }
  );

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


  if (auth.role === 'CEO') return auth;

  // Use the same authenticated request client and fail closed on permission
  // lookup errors. Do not swallow RPC failures because that makes RBAC
  // incidents invisible during outages or migrations.
  const { supabase } = await getAuthSupabase();
  try {
    const { data: perms, error: permissionError } = await supabase.rpc('get_my_permissions');

    if (permissionError) {
      console.error('[api-auth] get_my_permissions failed', {
        userId: auth.userId,
        requiredPerm,
        error: permissionError,
      });
      return NextResponse.json(
        { error: 'Permission service temporarily unavailable' },
        { status: 503 }
      );
    }

    if (perms) {
      const permObj = !Array.isArray(perms) && typeof perms === 'object' ? perms : null;
      if (permObj && permObj[requiredPerm] === true) return auth;
      if (Array.isArray(perms) && perms.some((p: any) =>
        (p?.permission_code || p?.perm_code || p?.code) === requiredPerm
      )) return auth;
    }
  } catch (error) {
    console.error('[api-auth] get_my_permissions exception', {
      userId: auth.userId,
      requiredPerm,
      error,
    });
    return NextResponse.json(
      { error: 'Permission service temporarily unavailable' },
      { status: 503 }
    );
  }

  return NextResponse.json({ error: 'Insufficient permissions' }, { status: 403 });
}

// ---------- Maker-Checker: ensure approver is NOT the creator ----------
export function enforceMakerChecker(creatorId: string, approverId: string): boolean {
  return creatorId !== approverId;
}

// AL-01 FIX (root cause shared by AP-06, RBAC-02, AR-06): this used to query
// core.approval_limits directly with the request-scoped (RLS) client and
// fall back to hardcoded PKR constants when the query came back empty.
// RLS policy approval_limits_select_own only exposes a row when
// `user_id = auth.uid()` OR the caller holds ADMIN_USERS, so every
// role-based limit (user_id IS NULL) was invisible to the approver it was
// actually meant to constrain (CEO, FINANCE_HEAD, ACCOUNTANT, HOD,
// PROJECT_MANAGER) -- the lookup always came back empty for them, and the
// code silently fell through to source-compiled defaults that an admin had
// no way to tighten, and that ignored currency entirely (a USD amount was
// compared straight against a PKR ceiling).
//
// core.can_approve_amount(...) (schema.sql ~1017) is SECURITY DEFINER, so it
// evaluates the full spec 7.2/7.3 cascade -- per-user DENY override, then
// ALLOW override/base permission, then per-user limit, then per-role limit,
// then role_permissions.amount_limit as the org-configured (not hardcoded)
// default -- against the real rows in core.approval_limits regardless of
// what RLS would let this request-scoped client see directly. Currency is
// passed straight through so a foreign-currency transaction is matched
// against a limit configured in that same currency instead of a PKR one.
export async function checkApprovalLimitAsync(
  supabase: any,
  orgId: string | null,
  userId: string,
  userRole: string,
  transactionType: string,
  amount: number,
  currency: string = 'PKR',
  // AL-01 FIX: the permission code gating "approve" is NOT uniform
  // `${transactionType}_APPROVE` across modules -- e.g. journal_entry uses
  // 'APPROVE_JOURNAL' and credit_note uses 'APPROVE_INVOICE' (see
  // workflow/route.ts MODULES). Deriving the code from transactionType
  // would silently deny every legitimate approver for those modules
  // (core.has_permission would look up a code that was never granted).
  // Callers should pass the exact same permission code they already used
  // to gate the action; this only falls back to the `${transactionType}_APPROVE`
  // convention when a caller doesn't supply one (true for VENDOR_PAYMENT).
  permissionCode?: string
): Promise<{ allowed: boolean; reason: string }> {
  const permCode = permissionCode || `${transactionType}_APPROVE`;

  const { data: allowed, error } = await supabase
    .schema('core')
    .rpc('can_approve_amount', {
      p_user_id: userId,
      p_permission_code: permCode,
      p_transaction_type: transactionType,
      p_amount: amount,
      p_currency: currency,
    });

  if (error) {
    // Fail closed: the caller has already passed a permission check to get
    // here, so if the authoritative DB-side cascade can't be evaluated
    // (transient DB error, etc.) we must not silently approve on a
    // hardcoded default -- that's exactly the bug this replaces.
    console.error('checkApprovalLimitAsync: core.can_approve_amount RPC failed:', error.message);
    return {
      allowed: false,
      reason: 'Unable to verify your approval limit right now. Please try again shortly or contact an administrator.',
    };
  }

  if (allowed) return { allowed: true, reason: '' };

  return {
    allowed: false,
    reason: `Amount ${currency} ${amount.toLocaleString()} exceeds your configured ${userRole} approval limit for this transaction type. Requires ${getNextApproverRole(userRole)} approval.`,
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
    // FIX: use parse(), not parseQuery() — see import comment above.
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
    // FIX: ai_user_cost_tracking lives in the 'ai' schema.
    // .from('ai.ai_user_cost_tracking') is invalid supabase-js syntax — must use
    // .schema('ai').from('ai_user_cost_tracking').
    const { data: existing, error } = await supabase
      .schema('ai')
      .from('ai_user_cost_tracking')
      .select('request_count, estimated_cost')
      .eq('user_id', userId)
      
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
    // AI-01 FIX: a raw `.from('ai_user_cost_tracking').eq('organization_id', orgId)`
    // query here looks org-wide, but this `supabase` client is request-scoped
    // (runs as the "authenticated" role under RLS). The only policy on this
    // table, "users_own_cost", forces `user_id = auth.uid()` onto every row
    // regardless of any organization_id filter the app applies — so a raw
    // SELECT could only ever see the CALLING USER'S OWN row, never the rest
    // of the org's usage, silently neutering the company-wide cost ceiling.
    // ai.get_org_daily_ai_usage() is a SECURITY DEFINER RPC that computes the
    // SUM() across every user in the org, bypassing that per-row restriction
    // the same way ai.increment_usage() already does for writes.
    const { data, error } = await supabase
      .schema('ai')
      .rpc('get_org_daily_ai_usage', { p_organization_id: orgId, p_period_date: today })
      .maybeSingle();

    if (error) {
      console.error('checkOrgAiDailyLimit fetch error:', error.message);
      return { allowed: false, reason: 'Org rate limit check failed. Please try again later.' };
    }

    const totalRequests = Number(data?.total_requests || 0);
    const totalCost = parseFloat(data?.total_cost || '0');

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

// AI gateway hard limit helper. Every AI route should call this before invoking
// a model; it fails closed when usage exceeds either user or organization caps.
export async function enforceAiRequestLimits(supabase: any, userId: string, orgId: string, userRequests = 100, userCost = 1.5, orgRequests = 2000, orgCost = 30) {
  const userLimit = await checkAiDailyLimit(supabase, userId, orgId, userRequests, userCost);
  if (!userLimit.allowed) return NextResponse.json({ error: userLimit.reason || 'Daily AI user limit exceeded' }, { status: 429 });
  const orgLimit = await checkOrgAiDailyLimit(supabase, orgId, orgRequests, orgCost);
  if (!orgLimit.allowed) return NextResponse.json({ error: orgLimit.reason || 'Daily AI organization limit exceeded' }, { status: 429 });
  return null;
}
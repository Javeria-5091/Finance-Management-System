declare const Deno: {
  env: {
    get: (key: string) => string | undefined;
  };
  serve: (handler: (req: Request) => Promise<Response>) => void;
};

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Privileged client — used ONLY after the caller has been positively
// identified and authorized below. Never used to make authorization
// decisions itself (it has no notion of "who is calling").
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ─────────────────────────────────────────────────────────────────────────
// SEC-01 FIX (P1, Spec 7.1/7.5): this function previously had ZERO identity
// or role checks of its own — it relied entirely on the platform's default
// `verify_jwt` gateway setting, which only proves "some valid JWT was
// presented", not "this caller is allowed to post GL journals for this
// organization". Any authenticated EMPLOYEE could POST a mapping and have
// it posted with service-role privileges across ANY organization, and if
// verify_jwt were ever disabled this escalates to fully unauthenticated GL
// posting (P0). Per spec: "technical access alone is not sufficient" —
// privileged actions must re-check identity/role/org server-side, inside
// the privileged code path itself, not just at the platform boundary.
//
// requireAuthorizedCaller() builds a second client scoped to the caller's
// own bearer token (anon key + Authorization header, exactly like
// src/lib/api-auth.ts does for Next.js routes) and:
//   1. Calls auth.getUser() to cryptographically re-verify the JWT — this
//      is an independent check that does not depend on verify_jwt being
//      enabled at the gateway.
//   2. Resolves the caller's profile role + organization_id.
//   3. Requires CEO or the ADMIN_MIGRATION permission (core.has_permission)
//      — the dedicated permission code the frontend already declares for
//      this exact feature. Mere ADMIN_AUDIT (read-only audit access) is
//      NOT sufficient to post journals.
//   4. Fails closed (403/401/400) on any missing identity, permission, or
//      organization context.
// The caller's own organization_id is then used to scope every read/write
// below — it is never accepted from the request body.
// ─────────────────────────────────────────────────────────────────────────
interface AuthorizedCaller {
  userId: string;
  orgId: string;
}

async function requireAuthorizedCaller(
  req: Request,
): Promise<AuthorizedCaller | Response> {
  const authHeader = req.headers.get("Authorization");
  const bearer = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!bearer) {
    return new Response(
      JSON.stringify({ error: "Authentication required" }),
      { status: 401, headers: JSON_HEADERS },
    );
  }

  // Scoped to the caller's own JWT — this client can never see or touch
  // data outside what RLS allows for this specific user.
  const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${bearer}` } },
    auth: { persistSession: false },
  });

  const { data: userData, error: userError } = await callerClient.auth.getUser();
  if (userError || !userData?.user) {
    return new Response(
      JSON.stringify({ error: "Authentication required" }),
      { status: 401, headers: JSON_HEADERS },
    );
  }
  const userId = userData.user.id;

  const { data: profile, error: profileError } = await callerClient
    .from("profiles")
    .select("role, organization_id")
    .eq("user_id", userId)
    .maybeSingle();

  if (profileError) {
    return new Response(
      JSON.stringify({ error: "Unable to resolve caller profile" }),
      { status: 503, headers: JSON_HEADERS },
    );
  }

  const orgId: string | null = profile?.organization_id ?? null;
  if (!orgId) {
    return new Response(
      JSON.stringify({ error: "Organization context missing" }),
      { status: 400, headers: JSON_HEADERS },
    );
  }

  // CEO is treated as a superuser, mirroring requirePermission() in
  // src/lib/api-auth.ts. Every other role must explicitly hold
  // ADMIN_MIGRATION — the dedicated permission code the frontend already
  // uses to gate this exact feature (src/components/sections/Sidebar.tsx,
  // src/context/PermissionContext.tsx), now seeded/granted by migration
  // P1_101_seed_admin_migration_permission.sql. ADMIN_AUDIT (read-only
  // audit-log access, used only to gate entry to the /dashboard/admin
  // section in the dashboard layout) does NOT grant the right to post
  // journals — using it here would still leave this destructive action
  // reachable by auditors who should only ever read data.
  const role = profile?.role === "Admin" ? "CEO" : profile?.role;
  if (role !== "CEO") {
    const { data: allowed, error: permError } = await callerClient
      .schema("core")
      .rpc("has_permission", { p_user_id: userId, p_permission_code: "ADMIN_MIGRATION" });

    if (permError) {
      return new Response(
        JSON.stringify({ error: "Permission service temporarily unavailable" }),
        { status: 503, headers: JSON_HEADERS },
      );
    }
    if (!allowed) {
      return new Response(
        JSON.stringify({ error: "Insufficient permissions" }),
        { status: 403, headers: JSON_HEADERS },
      );
    }
  }

  return { userId, orgId };
}

interface MapItem {
  category: string;
  type: "income" | "expense";
  target_account_id: string;
  default_cash_account_id: string;
}

interface MigrateRequest {
  mapping: MapItem[];
}

interface MigrateResponse {
  success: boolean;
  migrated: number;
  failed: number;
  error?: string;
}

const JSON_HEADERS = { "Content-Type": "application/json" };

Deno.serve(async (req: Request) => {
  // ── Method guard ──
  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ error: "Method not allowed" }),
      { status: 405, headers: JSON_HEADERS },
    );
  }

  // ── SEC-01 FIX: identity + role + org re-check happens BEFORE any request
  // body is trusted or any privileged query runs. ──
  const authResult = await requireAuthorizedCaller(req);
  if (authResult instanceof Response) return authResult;
  const { orgId, userId: callerId } = authResult;

  try {
    const { mapping }: MigrateRequest = await req.json();

    if (!mapping?.length) {
      return new Response(
        JSON.stringify({ error: "Mapping array is required" }),
        { status: 400, headers: JSON_HEADERS },
      );
    }

    let migrated = 0;
    let failed = 0;
    const db = supabase.schema("finance");

    // SEC-01 FIX: only chart-of-accounts rows that actually belong to the
    // caller's own organization may be used as posting targets. Without
    // this, a caller could supply account ids belonging to a DIFFERENT
    // organization's chart of accounts and corrupt that org's GL even
    // though the income/expense records themselves are correctly scoped.
    const requestedAccountIds = Array.from(
      new Set(
        mapping.flatMap((m) => [m.target_account_id, m.default_cash_account_id])
          .filter(Boolean),
      ),
    );
    const { data: ownAccounts } = requestedAccountIds.length
      ? await db
        .from("chart_of_accounts")
        .select("id")
        .eq("organization_id", orgId)
        .in("id", requestedAccountIds)
      : { data: [] as { id: string }[] };
    const ownAccountIds = new Set((ownAccounts || []).map((a) => a.id));
    const orgSafeMapping = mapping.filter(
      (m) =>
        ownAccountIds.has(m.target_account_id) &&
        ownAccountIds.has(m.default_cash_account_id),
    );

    // ── Fetch unmigrated old records — SEC-01 FIX: scoped to the caller's
    // own organization only. Previously this had no org filter at all and
    // would pull (and post journals for) every organization's data. ──
    const { data: oldIncomes } = await supabase
      .from("incomes")
      .select("id, category, description, date, amount, created_by, status")
      .eq("organization_id", orgId)
      .is("journal_entry_id", null);

    const { data: oldExpenses } = await supabase
      .from("expenses")
      .select("id, category, description, date, amount, created_by, status")
      .eq("organization_id", orgId)
      .is("journal_entry_id", null);

    // ════════════════════════════════════
    //  Process Incomes
    //  Correct: Debit Cash, Credit Income
    // ════════════════════════════════════
    for (const rec of oldIncomes || []) {
      const map = orgSafeMapping.find(
        (m) => m.category === rec.category && m.type === "income",
      );

      if (!map) {
        failed++;
        continue;
      }

      // Find accounting period for this date — SEC-01 FIX: scoped to the
      // caller's own organization so income cannot be posted into a period
      // (and thus fiscal year / journal) belonging to another organization.
      const { data: period } = await db
        .from("accounting_periods")
        .select("id, fiscal_year_id")
        .eq("organization_id", orgId)
        .lte("start_date", rec.date)
        .gte("end_date", rec.date)
        .limit(1)
        .single();

      if (!period) {
        failed++;
        continue;
      }

      // Insert journal entry header
      const { data: je, error: jeError } = await db
        .from("journal_entries")
        .insert({
          description: `Migrated: ${rec.description}`,
          transaction_date: rec.date,
          period_id: period.id,
          fiscal_year_id: period.fiscal_year_id,
          status: "POSTED",
          currency: "PKR",
          exchange_rate: 1,
          total_debit: rec.amount,
          total_credit: rec.amount,
          source_type: "MIGRATED_INCOME",
          source_id: rec.id,
          created_by: rec.created_by,
          // SEC-01 FIX: stamp the caller's own organization on every
          // posted journal — previously omitted entirely.
          organization_id: orgId,
        })
        .select("id")
        .single();

      if (jeError || !je) {
        failed++;
        continue;
      }

      // Debit Cash (asset ↑), Credit Income Account (revenue ↑)
      const { error: linesError } = await db.from("journal_lines").insert([
        {
          journal_entry_id: je.id,
          line_number: 1,
          account_id: map.default_cash_account_id,
          debit_amount: rec.amount,
          credit_amount: 0,
          base_debit: rec.amount,
          base_credit: 0,
        },
        {
          journal_entry_id: je.id,
          line_number: 2,
          account_id: map.target_account_id,
          debit_amount: 0,
          credit_amount: rec.amount,
          base_debit: 0,
          base_credit: rec.amount,
        },
      ]);

      if (linesError) {
        failed++;
        continue;
      }

      // Link back — never delete old data
      await supabase
        .from("incomes")
        .update({ journal_entry_id: je.id, status: "POSTED" })
        .eq("id", rec.id);

      migrated++;
    }

    // ════════════════════════════════════
    //  Process Expenses
    //  Correct: Debit Expense, Credit Cash
    // ════════════════════════════════════
    for (const rec of oldExpenses || []) {
      const map = orgSafeMapping.find(
        (m) => m.category === rec.category && m.type === "expense",
      );

      if (!map) {
        failed++;
        continue;
      }

      // SEC-01 FIX: same organization scoping as the income branch above.
      const { data: period } = await db
        .from("accounting_periods")
        .select("id, fiscal_year_id")
        .eq("organization_id", orgId)
        .lte("start_date", rec.date)
        .gte("end_date", rec.date)
        .limit(1)
        .single();

      if (!period) {
        failed++;
        continue;
      }

      const { data: je, error: jeError } = await db
        .from("journal_entries")
        .insert({
          description: `Migrated: ${rec.description}`,
          transaction_date: rec.date,
          period_id: period.id,
          fiscal_year_id: period.fiscal_year_id,
          status: "POSTED",
          currency: "PKR",
          exchange_rate: 1,
          total_debit: rec.amount,
          total_credit: rec.amount,
          source_type: "MIGRATED_EXPENSE",
          source_id: rec.id,
          created_by: rec.created_by,
          // SEC-01 FIX: stamp the caller's own organization on every
          // posted journal — previously omitted entirely.
          organization_id: orgId,
        })
        .select("id")
        .single();

      if (jeError || !je) {
        failed++;
        continue;
      }

      // Debit Expense Account (expense ↑), Credit Cash (asset ↓)
      const { error: linesError } = await db.from("journal_lines").insert([
        {
          journal_entry_id: je.id,
          line_number: 1,
          account_id: map.target_account_id,
          debit_amount: rec.amount,
          credit_amount: 0,
          base_debit: rec.amount,
          base_credit: 0,
        },
        {
          journal_entry_id: je.id,
          line_number: 2,
          account_id: map.default_cash_account_id,
          debit_amount: 0,
          credit_amount: rec.amount,
          base_debit: 0,
          base_credit: rec.amount,
        },
      ]);

      if (linesError) {
        failed++;
        continue;
      }

      await supabase
        .from("expenses")
        .update({ journal_entry_id: je.id, status: "POSTED" })
        .eq("id", rec.id);

      migrated++;
    }

    // Audit trail for this privileged, GL-posting action (Spec 7.5).
    try {
      await supabase.schema("audit").rpc("log_action", {
        p_user_id: callerId,
        p_action: "HISTORICAL_DATA_MIGRATED",
        p_entity_type: "journal_entry",
        p_entity_id: null,
        p_description: `Historical data migration run for organization ${orgId}: ${migrated} posted, ${failed} failed`,
        p_previous_status: null,
        p_new_status: "POSTED",
        p_source_module: "data-processing",
        p_severity: "high",
        p_new_values: { organization_id: orgId, migrated, failed },
      });
    } catch (auditErr) {
      console.error("Audit log failed:", auditErr);
    }

    return new Response(
      JSON.stringify({ success: true, migrated, failed }),
      { headers: JSON_HEADERS },
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: JSON_HEADERS },
    );
  }
});
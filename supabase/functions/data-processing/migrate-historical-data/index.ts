import { createClient } from "@supabase/supabase-js";

interface MapItem {
  category: string;
  type: "income" | "expense";
  target_account_id: string;
  default_cash_account_id: string;
}

interface MigrateRequest { mapping: MapItem[]; }
const JSON_HEADERS = { "Content-Type": "application/json" };

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: JSON_HEADERS });

  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return new Response(JSON.stringify({ error: "Authentication required" }), { status: 401, headers: JSON_HEADERS });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } },
  );

  try {
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) return new Response(JSON.stringify({ error: "Authentication required" }), { status: 401, headers: JSON_HEADERS });

    const { data: profile } = await supabase.from("profiles").select("organization_id").eq("user_id", user.id).maybeSingle();
    const orgId = profile?.organization_id;
    if (!orgId) return new Response(JSON.stringify({ error: "Organization context missing" }), { status: 400, headers: JSON_HEADERS });

    const { data: allowed } = await supabase.schema("core").rpc("has_permission", { p_user_id: user.id, p_permission_code: "ADMIN_MIGRATION" });
    if (!allowed) return new Response(JSON.stringify({ error: "ADMIN_MIGRATION permission required" }), { status: 403, headers: JSON_HEADERS });

    const body: MigrateRequest = await req.json();
    if (!body.mapping?.length) return new Response(JSON.stringify({ error: "Mapping array is required" }), { status: 400, headers: JSON_HEADERS });

    const finance = supabase.schema("finance");
    let migrated = 0, failed = 0;

    const validateAccount = async (id: string) => {
      const { data } = await finance.from("chart_of_accounts").select("id").eq("id", id).eq("organization_id", orgId).eq("is_active", true).eq("posting_allowed", true).maybeSingle();
      return !!data;
    };

    const migrateRecord = async (rec: any, type: "income" | "expense", map: MapItem) => {
      if (!(await validateAccount(map.target_account_id)) || !(await validateAccount(map.default_cash_account_id))) return false;

      const sourceType = type === "income" ? "MIGRATED_INCOME" : "MIGRATED_EXPENSE";
      const { data: existing } = await finance.from("journal_entries").select("id").eq("organization_id", orgId).eq("source_type", sourceType).eq("source_id", rec.id).maybeSingle();
      if (existing?.id) {
        await supabase.from(type === "income" ? "incomes" : "expenses").update({ journal_entry_id: existing.id, status: "POSTED" }).eq("id", rec.id).eq("organization_id", orgId);
        return true;
      }

      const { data: period } = await finance.from("accounting_periods").select("id, fiscal_year_id").eq("organization_id", orgId).lte("start_date", rec.date).gte("end_date", rec.date).limit(1).maybeSingle();
      if (!period) return false;

      const lines = type === "income"
        ? [
            { account_id: map.default_cash_account_id, debit_amount: rec.amount, credit_amount: 0, description: `Migrated cash: ${rec.description}` },
            { account_id: map.target_account_id, debit_amount: 0, credit_amount: rec.amount, description: `Migrated income: ${rec.description}` },
          ]
        : [
            { account_id: map.target_account_id, debit_amount: rec.amount, credit_amount: 0, description: `Migrated expense: ${rec.description}` },
            { account_id: map.default_cash_account_id, debit_amount: 0, credit_amount: rec.amount, description: `Migrated cash: ${rec.description}` },
          ];

      const { data: journalId, error: postError } = await finance.rpc("post_journal_entry", {
        p_description: `Migrated: ${rec.description}`,
        p_transaction_date: rec.date,
        p_period_id: period.id,
        p_lines: lines,
        p_currency: "PKR",
        p_exchange_rate: 1,
        p_source_type: sourceType,
        p_source_id: rec.id,
      });
      if (postError || !journalId) return false;

      const table = type === "income" ? "incomes" : "expenses";
      const { error: linkError } = await supabase.from(table).update({ journal_entry_id: journalId, status: "POSTED" }).eq("id", rec.id).eq("organization_id", orgId);
      if (linkError) return false;

      await supabase.schema("audit").rpc("log_action", {
        p_user_id: user.id,
        p_action: "HISTORICAL_MIGRATION",
        p_entity_type: type,
        p_entity_id: rec.id,
        p_description: `Historical ${type} migrated to journal ${journalId}`,
        p_source_module: "data-processing",
        p_severity: "high",
        p_related_journal_id: journalId,
      });
      return true;
    };

    const { data: incomes } = await supabase.from("incomes").select("id, category, description, date, amount, created_by, status").eq("organization_id", orgId).is("journal_entry_id", null);
    for (const rec of incomes || []) {
      const map = body.mapping.find(m => m.category === rec.category && m.type === "income");
      if (!map || !(await migrateRecord(rec, "income", map))) failed++; else migrated++;
    }

    const { data: expenses } = await supabase.from("expenses").select("id, category, description, date, amount, created_by, status").eq("organization_id", orgId).is("journal_entry_id", null);
    for (const rec of expenses || []) {
      const map = body.mapping.find(m => m.category === rec.category && m.type === "expense");
      if (!map || !(await migrateRecord(rec, "expense", map))) failed++; else migrated++;
    }

    return new Response(JSON.stringify({ success: true, migrated, failed }), { headers: JSON_HEADERS });
  } catch (err) {
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : "Unknown error" }), { status: 500, headers: JSON_HEADERS });
  }
});

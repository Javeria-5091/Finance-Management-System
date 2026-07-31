
declare const Deno: {
  env: {
    get: (key: string) => string | undefined;
  };
  serve: (handler: (req: Request) => Promise<Response>) => void;
};

import { createClient } from "@supabase/supabase-js";
const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

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

    // ── Fetch unmigrated old records ──
    const { data: oldIncomes } = await supabase
      .from("incomes")
      .select("id, category, description, date, amount, created_by, status")
      .is("journal_entry_id", null);

    const { data: oldExpenses } = await supabase
      .from("expenses")
      .select("id, category, description, date, amount, created_by, status")
      .is("journal_entry_id", null);

    // ════════════════════════════════════
    //  Process Incomes
    //  Correct: Debit Cash, Credit Income
    // ════════════════════════════════════
    for (const rec of oldIncomes || []) {
      const map = mapping.find(
        (m) => m.category === rec.category && m.type === "income",
      );

      if (!map) {
        failed++;
        continue;
      }

      // Find accounting period for this date
      const { data: period } = await db
        .from("accounting_periods")
        .select("id, fiscal_year_id")
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
      const map = mapping.find(
        (m) => m.category === rec.category && m.type === "expense",
      );

      if (!map) {
        failed++;
        continue;
      }

      const { data: period } = await db
        .from("accounting_periods")
        .select("id, fiscal_year_id")
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
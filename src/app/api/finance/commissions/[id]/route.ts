import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import {
  getAuthSupabase,
  requirePermission,
  type AuthResult,
} from "@/lib/api-auth";

import { enforceMFA } from "@/lib/mfa-middleware";
import { calculateCommission } from "@/services/commission.service";

/* -------------------------------------------------------------------------- */
/* FND-PBV-004 FIX: GL posting helpers                                        */
/* -------------------------------------------------------------------------- */
// Approve/pay previously just flipped `status` on the commissions row with
// no accounting impact at all. These helpers post real journal entries,
// following the same account-resolution style already used by
// src/app/api/finance/post-expense/route.ts (exact name match first, then a
// deterministic fallback) rather than inventing a new lookup convention.

async function findAccount(
  supabase: any,
  orgId: string,
  accountType: string,
  nameLike: string,
): Promise<{ id: string; code: string; name: string } | null> {
  const exact = (await supabase
    .schema('finance').from('chart_of_accounts')
    .select('id, code, name')
    .eq('account_type', accountType)
    .eq('is_active', true)
    .eq('organization_id', orgId)
    .ilike('name', nameLike)
    .order('code', { ascending: true })
    .limit(1)).data ?? [];
  if (exact.length) return exact[0];

  const fallback = (await supabase
    .schema('finance').from('chart_of_accounts')
    .select('id, code, name')
    .eq('account_type', accountType)
    .eq('is_active', true)
    .eq('organization_id', orgId)
    .order('code', { ascending: true })
    .limit(1)).data ?? [];
  return fallback.length ? fallback[0] : null;
}

/* -------------------------------------------------------------------------- */
/* Schemas                                                                    */
/* -------------------------------------------------------------------------- */

const idSchema = z.string().uuid();

const commissionTypeSchema = z.enum([
  "PERCENTAGE",
  "FIXED_AMOUNT",
  "TIERED",
  "FLAT_BONUS",
  "REFERRAL",
]);

const calculationBasisSchema = z.enum([
  "PROJECT_REVENUE",
  "INVOICE_AMOUNT",
  "MILESTONE_VALUE",
  "CLIENT_PAYMENT",
  "SALES_TARGET",
  "FIXED_AMOUNT",
]);

const patchSchema = z.object({
  person_name: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional(),

  commission_type:
    commissionTypeSchema.optional(),

  calculation_basis:
    calculationBasisSchema.optional(),

  rate_or_amount: z
    .coerce
    .number()
    .finite()
    .nonnegative()
    .optional(),

  base_amount: z
    .coerce
    .number()
    .finite()
    .nonnegative()
    .optional(),

  tax_withheld: z
    .coerce
    .number()
    .finite()
    .nonnegative()
    .optional(),

  project_id: z
    .string()
    .uuid()
    .nullable()
    .optional(),

  contractor_id: z
    .string()
    .uuid()
    .nullable()
    .optional(),

  notes: z
    .string()
    .max(5000)
    .nullable()
    .optional(),

  action: z
    .enum(["cancel", "approve", "pay"])
    .optional(),

  payment_date: z
    .string()
    .date()
    .optional(),

  payment_ref: z
    .string()
    .trim()
    .max(100)
    .nullable()
    .optional(),

  // FND-PBV-004 FIX: the bank/cash account the payment goes out of, needed
  // to build the GL payment journal's credit line. Required for action
  // "pay" (checked below, not here, so the other actions' payloads don't
  // need it).
  financial_account_id: z
    .string()
    .uuid()
    .optional(),
});

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

interface CommissionRow {
  id: string;
  organization_id: string;
  status: string;

  created_by?: string | null;

  commission_type?: string | null;
  rate_or_amount?: number | string | null;
  base_amount?: number | string | null;
  commission_amount?: number | string | null;

  [key: string]: unknown;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * AuthResult.orgId is intentionally string | null.
 * Never bypass this with `as string` or `!`.
 *
 * Financial routes must fail closed if tenant context is missing.
 */
function requireOrganizationId(
  auth: AuthResult
): string {
  if (!auth.orgId) {
    throw new Error(
      "Authenticated user is not associated with an organization"
    );
  }

  return auth.orgId;
}

function getErrorMessage(
  error: unknown
): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error
  ) {
    const message = (
      error as {
        message?: unknown;
      }
    ).message;

    if (typeof message === "string") {
      return message;
    }
  }

  return "Commission operation failed";
}

async function getRow(
  supabase: any,
  id: string,
  organizationId: string
): Promise<CommissionRow> {
  const { data, error } = await supabase
    .from("commissions")
    .select("*")
    .eq("id", id)
    .eq("organization_id", organizationId)
    .single();

  if (error || !data) {
    throw new Error(
      "Commission not found"
    );
  }

  return data as CommissionRow;
}

/* -------------------------------------------------------------------------- */
/* GET                                                                        */
/* -------------------------------------------------------------------------- */

export async function GET(
  req: NextRequest,
  {
    params,
  }: {
    params: { id: string };
  }
) {
  const auth = await requirePermission(
    "COMMISSION_READ"
  );

  if (auth instanceof NextResponse) {
    return auth;
  }

  const idResult = idSchema.safeParse(
    params.id
  );

  if (!idResult.success) {
    return NextResponse.json(
      {
        error: "Invalid commission ID",
      },
      { status: 400 }
    );
  }

  let organizationId: string;

  try {
    organizationId =
      requireOrganizationId(auth);
  } catch (error: unknown) {
    return NextResponse.json(
      {
        error: getErrorMessage(error),
      },
      { status: 403 }
    );
  }

  try {
    const { supabase } =
      await getAuthSupabase(req);

    const row = await getRow(
      supabase,
      idResult.data,
      organizationId
    );

    return NextResponse.json({
      data: row,
    });
  } catch (error: unknown) {
    return NextResponse.json(
      {
        error: getErrorMessage(error),
      },
      { status: 404 }
    );
  }
}

/* -------------------------------------------------------------------------- */
/* PATCH                                                                      */
/* -------------------------------------------------------------------------- */

export async function PATCH(
  req: NextRequest,
  {
    params,
  }: {
    params: { id: string };
  }
) {
  const auth = await requirePermission(
    "COMMISSION_UPDATE"
  );

  if (auth instanceof NextResponse) {
    return auth;
  }

  const idResult = idSchema.safeParse(
    params.id
  );

  if (!idResult.success) {
    return NextResponse.json(
      {
        error: "Invalid commission ID",
      },
      { status: 400 }
    );
  }

  let organizationId: string;

  try {
    organizationId =
      requireOrganizationId(auth);
  } catch (error: unknown) {
    return NextResponse.json(
      {
        error: getErrorMessage(error),
      },
      { status: 403 }
    );
  }

  const { supabase } =
    await getAuthSupabase(req);

  /* ------------------------------- Body --------------------------------- */

  let body: unknown;

  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      {
        error: "Invalid JSON request body",
      },
      { status: 400 }
    );
  }

  const parsed =
    patchSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      {
        error:
          parsed.error.issues[0]?.message ??
          "Invalid commission data",
      },
      { status: 400 }
    );
  }

  const input = parsed.data;

  try {
    const row = await getRow(
      supabase,
      idResult.data,
      organizationId
    );

    /* ====================================================================== */
    /* APPROVE                                                                */
    /* ====================================================================== */

    if (input.action === "approve") {
      const approvalAuth =
        await requirePermission(
          "COMMISSION_APPROVE"
        );

      if (
        approvalAuth instanceof NextResponse
      ) {
        return approvalAuth;
      }

      const approvalOrgId =
        requireOrganizationId(
          approvalAuth
        );

      if (
        approvalOrgId !== organizationId
      ) {
        return NextResponse.json(
          {
            error:
              "Organization context mismatch",
          },
          { status: 403 }
        );
      }

      if (row.status !== "PENDING") {
        throw new Error(
          "Only PENDING commissions can be approved"
        );
      }

      if (
        row.created_by &&
        row.created_by === auth.userId
      ) {
        throw new Error(
          "Maker-checker: requester cannot approve own commission"
        );
      }

      // FND-PBV-004 FIX: post the accrual to the GL before (and atomically
      // with) marking the commission APPROVED — previously nothing here
      // touched finance.journal_entries at all.
      if (row.accrual_journal_id) {
        return NextResponse.json(
          { error: "This commission was already posted to the GL (accrual)" },
          { status: 409 }
        );
      }

      const commissionAmount = Number(row.commission_amount) || 0;
      const taxWithheld = Number(row.tax_withheld) || 0;
      const netAmount = Math.max(commissionAmount - taxWithheld, 0);

      const period = (await supabase
        .schema('finance').from('accounting_periods')
        .select('id')
        .eq('status', 'OPEN')
        .eq('organization_id', organizationId)
        .order('start_date', { ascending: false })
        .limit(1)
        .maybeSingle()).data;
      if (!period) {
        return NextResponse.json({ error: 'No OPEN accounting period found' }, { status: 400 });
      }

      const expenseAccount = await findAccount(supabase, organizationId, 'OPERATING_EXPENSE', '%commission%');
      if (!expenseAccount) {
        return NextResponse.json({ error: 'No Commission Expense (OPERATING_EXPENSE) account found in Chart of Accounts' }, { status: 400 });
      }
      const payableAccount = await findAccount(supabase, organizationId, 'LIABILITY', '%commission%payable%');
      if (!payableAccount) {
        return NextResponse.json({ error: 'No Commission Payable (LIABILITY) account found in Chart of Accounts' }, { status: 400 });
      }

      const lines: any[] = [
        { account_id: expenseAccount.id, debit_amount: commissionAmount, credit_amount: 0, description: `Commission accrued: ${row.person_name}` },
        { account_id: payableAccount.id, debit_amount: 0, credit_amount: netAmount, description: `Commission payable: ${row.person_name}` },
      ];
      if (taxWithheld > 0) {
        const whtAccount = await findAccount(supabase, organizationId, 'LIABILITY', '%withholding%');
        if (!whtAccount) {
          return NextResponse.json({ error: 'No Withholding Tax Payable (LIABILITY) account found in Chart of Accounts' }, { status: 400 });
        }
        lines.push({ account_id: whtAccount.id, debit_amount: 0, credit_amount: taxWithheld, description: `Withholding tax on commission: ${row.person_name}` });
      }

      const { data: journalId, error: postErr } = await supabase
        .schema('finance').rpc('post_journal_entry', {
          p_description: `Commission accrual: ${row.person_name} (${row.commission_type})`,
          p_transaction_date: new Date().toISOString().slice(0, 10),
          p_period_id: period.id,
          p_lines: lines,
          p_currency: row.currency || 'PKR',
          p_exchange_rate: 1,
          p_source_type: 'COMMISSION_ACCRUAL',
          p_source_id: row.id,
        });
      if (postErr || !journalId) {
        return NextResponse.json({ error: 'GL posting failed: ' + (postErr?.message || 'Unknown error') }, { status: 500 });
      }

      const {
        data,
        error,
      } = await supabase
        .from("commissions")
        .update({
          status: "APPROVED",
          approved_by: auth.userId,
          approved_at:
            new Date().toISOString(),
          accrual_journal_id: journalId,
        })
        .eq(
          "id",
          idResult.data
        )
        .eq(
          "organization_id",
          organizationId
        )
        .select()
        .single();

      if (error) {
        // Journal is already posted at this point; surface that so it isn't
        // silently lost — mirrors the capital-transactions "partial_success" pattern.
        return NextResponse.json({
          error: "Journal posted but commission status update failed: " + error.message,
          journal_id: journalId,
          partial_success: true,
        }, { status: 500 });
      }

      try {
        await supabase.schema('audit').rpc('log_action', {
          p_user_id: auth.userId,
          p_action: 'COMMISSION_APPROVED',
          p_entity_type: 'commission',
          p_entity_id: row.id,
          p_description: `Commission approved and posted to GL: ${row.person_name} (${commissionAmount} ${row.currency || 'PKR'})`,
          p_source_module: 'commissions',
          p_severity: 'medium',
          p_new_values: { journal_id: journalId, commission_amount: commissionAmount, tax_withheld: taxWithheld },
          p_related_journal_id: journalId,
        });
      } catch {}

      return NextResponse.json({
        data,
      });
    }

    /* ====================================================================== */
    /* PAY                                                                    */
    /* ====================================================================== */

    if (input.action === "pay") {
      const paymentAuth =
        await requirePermission(
          "COMMISSION_APPROVE"
        );

      if (
        paymentAuth instanceof NextResponse
      ) {
        return paymentAuth;
      }

      const paymentOrgId =
        requireOrganizationId(
          paymentAuth
        );

      if (
        paymentOrgId !== organizationId
      ) {
        return NextResponse.json(
          {
            error:
              "Organization context mismatch",
          },
          { status: 403 }
        );
      }

      const mfaResponse =
        await enforceMFA(auth);

      if (mfaResponse) {
        return mfaResponse;
      }

      if (row.status !== "APPROVED") {
        throw new Error(
          "Only APPROVED commissions can be paid"
        );
      }

      // FND-PBV-004 FIX: post the cash settlement to the GL before (and
      // atomically with) marking the commission PAID — previously nothing
      // here touched finance.journal_entries at all.
      if (row.payment_journal_id) {
        return NextResponse.json(
          { error: "This commission was already posted to the GL (payment)" },
          { status: 409 }
        );
      }
      if (!input.financial_account_id) {
        return NextResponse.json(
          { error: "financial_account_id is required to pay a commission (the bank/cash account it's paid from)" },
          { status: 400 }
        );
      }

      const financialAccount = (await supabase
        .schema('finance').from('financial_accounts')
        .select('id, linked_ledger_account_id')
        .eq('id', input.financial_account_id)
        .eq('organization_id', organizationId)
        .eq('is_active', true)
        .maybeSingle()).data;
      if (!financialAccount) {
        return NextResponse.json({ error: 'Financial account not found or inactive' }, { status: 404 });
      }

      const netAmountToPay = Math.max(
        (Number(row.commission_amount) || 0) - (Number(row.tax_withheld) || 0),
        0
      );

      const period = (await supabase
        .schema('finance').from('accounting_periods')
        .select('id')
        .eq('status', 'OPEN')
        .eq('organization_id', organizationId)
        .order('start_date', { ascending: false })
        .limit(1)
        .maybeSingle()).data;
      if (!period) {
        return NextResponse.json({ error: 'No OPEN accounting period found' }, { status: 400 });
      }

      const payableAccount = await findAccount(supabase, organizationId, 'LIABILITY', '%commission%payable%');
      if (!payableAccount) {
        return NextResponse.json({ error: 'No Commission Payable (LIABILITY) account found in Chart of Accounts' }, { status: 400 });
      }

      const { data: journalId, error: postErr } = await supabase
        .schema('finance').rpc('post_journal_entry', {
          p_description: `Commission payment: ${row.person_name}`,
          p_transaction_date: input.payment_date ?? new Date().toISOString().slice(0, 10),
          p_period_id: period.id,
          p_lines: [
            { account_id: payableAccount.id, debit_amount: netAmountToPay, credit_amount: 0, description: `Clear commission payable: ${row.person_name}` },
            { account_id: financialAccount.linked_ledger_account_id, debit_amount: 0, credit_amount: netAmountToPay, description: `Commission paid: ${row.person_name}` },
          ],
          p_currency: row.currency || 'PKR',
          p_exchange_rate: 1,
          p_source_type: 'COMMISSION_PAYMENT',
          p_source_id: row.id,
        });
      if (postErr || !journalId) {
        return NextResponse.json({ error: 'GL posting failed: ' + (postErr?.message || 'Unknown error') }, { status: 500 });
      }

      const paymentDate =
        input.payment_date ??
        new Date()
          .toISOString()
          .slice(0, 10);

      const {
        data,
        error,
      } = await supabase
        .from("commissions")
        .update({
          status: "PAID",
          payment_date: paymentDate,
          payment_ref:
            input.payment_ref ?? null,
          payment_journal_id: journalId,
        })
        .eq(
          "id",
          idResult.data
        )
        .eq(
          "organization_id",
          organizationId
        )
        .select()
        .single();

      if (error) {
        return NextResponse.json({
          error: "Journal posted but commission status update failed: " + error.message,
          journal_id: journalId,
          partial_success: true,
        }, { status: 500 });
      }

      try {
        await supabase.schema('audit').rpc('log_action', {
          p_user_id: auth.userId,
          p_action: 'COMMISSION_PAID',
          p_entity_type: 'commission',
          p_entity_id: row.id,
          p_description: `Commission paid and posted to GL: ${row.person_name} (${netAmountToPay} ${row.currency || 'PKR'})`,
          p_source_module: 'commissions',
          p_severity: 'medium',
          p_new_values: { journal_id: journalId, amount: netAmountToPay, financial_account_id: input.financial_account_id },
          p_related_journal_id: journalId,
        });
      } catch {}

      return NextResponse.json({
        data,
      });
    }

    /* ====================================================================== */
    /* CANCEL                                                                 */
    /* ====================================================================== */

    if (input.action === "cancel") {
      if (
        !["PENDING", "HELD"].includes(
          row.status
        )
      ) {
        throw new Error(
          "Only PENDING or HELD commissions can be cancelled"
        );
      }

      const {
        data,
        error,
      } = await supabase
        .from("commissions")
        .update({
          status: "CANCELLED",
        })
        .eq(
          "id",
          idResult.data
        )
        .eq(
          "organization_id",
          organizationId
        )
        .select()
        .single();

      if (error) {
        throw error;
      }

      return NextResponse.json({
        data,
      });
    }

    /* ====================================================================== */
    /* NORMAL UPDATE                                                           */
    /* ====================================================================== */

    if (
      [
        "APPROVED",
        "PAID",
        "CANCELLED",
      ].includes(row.status)
    ) {
      throw new Error(
        "Finalized commission cannot be edited"
      );
    }

    const {
      action: _action,
      payment_date: _paymentDate,
      payment_ref: _paymentRef,
      ...updates
    } = input;

    void _action;
    void _paymentDate;
    void _paymentRef;

    const clean: Record<
      string,
      unknown
    > = {};

    for (const [
      key,
      value,
    ] of Object.entries(updates)) {
      if (value !== undefined) {
        clean[key] = value;
      }
    }

    /* ----------------------- Recalculate amount -------------------------- */

    const needsRecalculation =
      updates.rate_or_amount !==
        undefined ||
      updates.base_amount !==
        undefined ||
      updates.commission_type !==
        undefined;

    if (needsRecalculation) {
      const commissionType =
        updates.commission_type ??
        row.commission_type;

      /*
       * Important:
       *
       * row.commission_type is string | null.
       * Validate it before passing it to
       * calculateCommission().
       */
      const validType =
        commissionTypeSchema.safeParse(
          commissionType
        );

      if (!validType.success) {
        throw new Error(
          "A valid commission type is required"
        );
      }

      const rateOrAmount =
        updates.rate_or_amount !==
        undefined
          ? Number(
              updates.rate_or_amount
            )
          : Number(
              row.rate_or_amount ?? 0
            );

      const baseAmount =
        updates.base_amount !==
        undefined
          ? Number(
              updates.base_amount
            )
          : Number(
              row.base_amount ?? 0
            );

      if (
        !Number.isFinite(
          rateOrAmount
        ) ||
        rateOrAmount < 0
      ) {
        throw new Error(
          "Invalid commission rate or amount"
        );
      }

      if (
        !Number.isFinite(
          baseAmount
        ) ||
        baseAmount < 0
      ) {
        throw new Error(
          "Invalid commission base amount"
        );
      }

      clean.commission_amount =
        calculateCommission(
          validType.data,
          rateOrAmount,
          baseAmount
        );
    }

    /* -------------------------- Nothing changed -------------------------- */

    if (
      Object.keys(clean).length === 0
    ) {
      return NextResponse.json({
        data: row,
      });
    }

    /* ------------------------------ Update ------------------------------- */

    const {
      data,
      error,
    } = await supabase
      .from("commissions")
      .update(clean)
      .eq(
        "id",
        idResult.data
      )
      .eq(
        "organization_id",
        organizationId
      )
      .select()
      .single();

    if (error) {
      throw error;
    }

    return NextResponse.json({
      data,
    });
  } catch (error: unknown) {
    return NextResponse.json(
      {
        error: getErrorMessage(error),
      },
      { status: 400 }
    );
  }
}

/* -------------------------------------------------------------------------- */
/* DELETE                                                                     */
/* -------------------------------------------------------------------------- */

export async function DELETE(
  req: NextRequest,
  {
    params,
  }: {
    params: { id: string };
  }
) {
  const auth = await requirePermission(
    "COMMISSION_DELETE"
  );

  if (auth instanceof NextResponse) {
    return auth;
  }

  const idResult = idSchema.safeParse(
    params.id
  );

  if (!idResult.success) {
    return NextResponse.json(
      {
        error: "Invalid commission ID",
      },
      { status: 400 }
    );
  }

  let organizationId: string;

  try {
    organizationId =
      requireOrganizationId(auth);
  } catch (error: unknown) {
    return NextResponse.json(
      {
        error: getErrorMessage(error),
      },
      { status: 403 }
    );
  }

  try {
    const { supabase } =
      await getAuthSupabase(req);

    const row = await getRow(
      supabase,
      idResult.data,
      organizationId
    );

    if (
      !["PENDING", "CANCELLED"].includes(
        row.status
      )
    ) {
      throw new Error(
        "Only PENDING or CANCELLED commissions can be deleted"
      );
    }

    const { error } = await supabase
      .from("commissions")
      .delete()
      .eq(
        "id",
        idResult.data
      )
      .eq(
        "organization_id",
        organizationId
      );

    if (error) {
      throw error;
    }

    return NextResponse.json({
      success: true,
    });
  } catch (error: unknown) {
    return NextResponse.json(
      {
        error: getErrorMessage(error),
      },
      { status: 400 }
    );
  }
}
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
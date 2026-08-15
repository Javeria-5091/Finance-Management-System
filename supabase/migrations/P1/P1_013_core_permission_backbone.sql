-- =============================================================================
-- Migration: 028_core_permission_backbone.sql
-- Purpose  : CRITICAL-1 remediation (spec Section 7.3, 10.1). Adds the five
--            minimum core tables the specification names explicitly and that
--            were entirely absent from schema.sql: approval_limits,
--            delegations, user_permission_overrides, organization_modules,
--            shared_people.
--
--            Note: core.role_permissions already carries a role-level
--            amount_limit + data_scope (a reasonable partial implementation
--            of 7.3 when permissions are already split by transaction type,
--            e.g. APPROVE_EXPENSE vs APPROVE_VENDOR_PAYMENT). This migration
--            does NOT remove or duplicate that mechanism. It adds what
--            role_permissions structurally cannot provide:
--              - a *currency-scoped*, *transaction-type-scoped* limit that
--                can differ from the blanket role/permission limit (7.3's
--                table shows PM/HOD/Finance Head/CEO limits varying BY
--                transaction type, not just by permission code)
--              - a *per-user* override/limit independent of role (7.2)
--              - formal *delegation* of authority with a reason, a bounded
--                validity window, and a specific permission subset (10.1),
--                distinct from user_roles.delegated_from (which only tags
--                which admin assigned a role, not a time-boxed grant of
--                someone else's authority)
--              - organization-level module/feature enablement (10.1)
--              - a stable cross-module person identity for the future
--                Employee Management System (10.1, Appendix D)
--
-- Safety   : All CREATE TABLE IF NOT EXISTS / additive. No existing table is
--            altered in this migration. RLS is enabled and locked to
--            service_role + explicit permission checks from creation, so
--            these new tables never pass through an insecure default state.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. approval_limits — monetary authority by role or user, transaction type,
--    and currency (spec 7.3, 10.1).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "core"."approval_limits" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "role_id" "uuid",
    "user_id" "uuid",
    "transaction_type" "text" NOT NULL,
    "currency" "text" NOT NULL DEFAULT 'PKR',
    "max_amount" numeric(18,2),
    "scope" "text" NOT NULL DEFAULT 'ALL',
    "effective_from" "date" NOT NULL DEFAULT CURRENT_DATE,
    "effective_to" "date",
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    CONSTRAINT "approval_limits_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "approval_limits_role_or_user_chk" CHECK (
        ("role_id" IS NOT NULL AND "user_id" IS NULL)
        OR ("role_id" IS NULL AND "user_id" IS NOT NULL)
    ),
    CONSTRAINT "approval_limits_transaction_type_chk" CHECK ("transaction_type" = ANY (ARRAY[
        'EXPENSE','PURCHASE','VENDOR_PAYMENT','BUDGET_REVISION','JOURNAL_ENTRY',
        'BANK_TRANSFER','SALARY_PAYROLL','OWNER_DISTRIBUTION','PERIOD_REOPEN',
        'INVOICE_CREDIT_NOTE','VENDOR_BILL','RESERVE_ALLOCATION'
    ])),
    CONSTRAINT "approval_limits_scope_chk" CHECK ("scope" = ANY (ARRAY['OWN','PROJECT','DEPARTMENT','ALL'])),
    CONSTRAINT "approval_limits_max_amount_chk" CHECK ("max_amount" IS NULL OR "max_amount" >= 0),
    CONSTRAINT "approval_limits_dates_chk" CHECK ("effective_to" IS NULL OR "effective_to" >= "effective_from"),
    CONSTRAINT "approval_limits_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "core"."roles"("id") ON DELETE CASCADE,
    CONSTRAINT "approval_limits_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE
);
ALTER TABLE "core"."approval_limits" OWNER TO "postgres";
COMMENT ON TABLE "core"."approval_limits" IS 'Configurable monetary approval ceilings by role or individual user, per transaction type and currency (spec 7.3). max_amount NULL = unlimited (e.g. CEO).';

CREATE INDEX IF NOT EXISTS "idx_approval_limits_role" ON "core"."approval_limits" ("role_id", "transaction_type") WHERE "role_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "idx_approval_limits_user" ON "core"."approval_limits" ("user_id", "transaction_type") WHERE "user_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "idx_approval_limits_effective" ON "core"."approval_limits" ("effective_from", "effective_to");

CREATE OR REPLACE TRIGGER "approval_limits_updated_at" BEFORE UPDATE ON "core"."approval_limits"
  FOR EACH ROW EXECUTE FUNCTION "core"."set_updated_at"();

CREATE OR REPLACE TRIGGER "approval_limits_audit" AFTER INSERT OR DELETE OR UPDATE ON "core"."approval_limits"
  FOR EACH ROW EXECUTE FUNCTION "audit"."trigger_audit_log"();

-- -----------------------------------------------------------------------------
-- 2. delegations — time-boxed delegation of a specific permission subset
--    from one user to another, with mandatory reason (spec 10.1).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "core"."delegations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "from_user_id" "uuid" NOT NULL,
    "to_user_id" "uuid" NOT NULL,
    "permission_ids" "uuid"[] NOT NULL,
    "reason" "text" NOT NULL,
    "effective_from" "date" NOT NULL DEFAULT CURRENT_DATE,
    "effective_to" "date" NOT NULL,
    "status" "text" NOT NULL DEFAULT 'ACTIVE',
    "revoked_by" "uuid",
    "revoked_at" timestamp with time zone,
    "revoke_reason" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    CONSTRAINT "delegations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "delegations_not_self_chk" CHECK ("from_user_id" <> "to_user_id"),
    CONSTRAINT "delegations_permission_ids_not_empty_chk" CHECK (array_length("permission_ids", 1) > 0),
    CONSTRAINT "delegations_reason_not_blank_chk" CHECK (btrim("reason") <> ''),
    CONSTRAINT "delegations_dates_chk" CHECK ("effective_to" >= "effective_from"),
    CONSTRAINT "delegations_status_chk" CHECK ("status" = ANY (ARRAY['ACTIVE','EXPIRED','REVOKED'])),
    CONSTRAINT "delegations_from_user_id_fkey" FOREIGN KEY ("from_user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE,
    CONSTRAINT "delegations_to_user_id_fkey" FOREIGN KEY ("to_user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE
);
ALTER TABLE "core"."delegations" OWNER TO "postgres";
COMMENT ON TABLE "core"."delegations" IS 'Time-limited delegation of specific permissions from one user to another with mandatory reason (spec 10.1, 7.2).';

CREATE INDEX IF NOT EXISTS "idx_delegations_from" ON "core"."delegations" ("from_user_id", "status");
CREATE INDEX IF NOT EXISTS "idx_delegations_to" ON "core"."delegations" ("to_user_id", "status");
CREATE INDEX IF NOT EXISTS "idx_delegations_effective" ON "core"."delegations" ("effective_from", "effective_to");

CREATE OR REPLACE TRIGGER "delegations_updated_at" BEFORE UPDATE ON "core"."delegations"
  FOR EACH ROW EXECUTE FUNCTION "core"."set_updated_at"();

CREATE OR REPLACE TRIGGER "delegations_audit" AFTER INSERT OR DELETE OR UPDATE ON "core"."delegations"
  FOR EACH ROW EXECUTE FUNCTION "audit"."trigger_audit_log"();

-- -----------------------------------------------------------------------------
-- 3. user_permission_overrides — specific allow/deny at the individual-user
--    level, independent of role (spec 7.2, 10.1).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "core"."user_permission_overrides" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "permission_id" "uuid" NOT NULL,
    "override_type" "text" NOT NULL,
    "data_scope" "text" DEFAULT 'ALL',
    "amount_limit" numeric(18,2),
    "reason" "text" NOT NULL,
    "effective_from" "date" NOT NULL DEFAULT CURRENT_DATE,
    "effective_to" "date",
    "approved_by" "uuid",
    "approved_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    CONSTRAINT "user_permission_overrides_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "upo_override_type_chk" CHECK ("override_type" = ANY (ARRAY['ALLOW','DENY'])),
    CONSTRAINT "upo_data_scope_chk" CHECK ("data_scope" = ANY (ARRAY['OWN','DEPARTMENT','PROJECT','ALL'])),
    CONSTRAINT "upo_reason_not_blank_chk" CHECK (btrim("reason") <> ''),
    CONSTRAINT "upo_dates_chk" CHECK ("effective_to" IS NULL OR "effective_to" >= "effective_from"),
    CONSTRAINT "user_permission_overrides_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE,
    CONSTRAINT "user_permission_overrides_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "core"."permissions"("id") ON DELETE CASCADE
);
ALTER TABLE "core"."user_permission_overrides" OWNER TO "postgres";
COMMENT ON TABLE "core"."user_permission_overrides" IS 'Per-user ALLOW/DENY override of a specific permission, independent of role assignment (spec 7.2).';

CREATE UNIQUE INDEX IF NOT EXISTS "uq_upo_active_user_permission"
  ON "core"."user_permission_overrides" ("user_id", "permission_id")
  WHERE "effective_to" IS NULL;

CREATE INDEX IF NOT EXISTS "idx_upo_user" ON "core"."user_permission_overrides" ("user_id");

CREATE OR REPLACE TRIGGER "upo_updated_at" BEFORE UPDATE ON "core"."user_permission_overrides"
  FOR EACH ROW EXECUTE FUNCTION "core"."set_updated_at"();

CREATE OR REPLACE TRIGGER "upo_audit" AFTER INSERT OR DELETE OR UPDATE ON "core"."user_permission_overrides"
  FOR EACH ROW EXECUTE FUNCTION "audit"."trigger_audit_log"();

-- -----------------------------------------------------------------------------
-- 4. organization_modules — enabled module / integration settings per
--    organization (spec 10.1, 3.2 "module-integration settings").
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "core"."organization_modules" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "module_key" "text" NOT NULL,
    "enabled" boolean NOT NULL DEFAULT false,
    "config" "jsonb" DEFAULT '{}'::"jsonb",
    "config_version" integer NOT NULL DEFAULT 1,
    "effective_from" "date" NOT NULL DEFAULT CURRENT_DATE,
    "effective_to" "date",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    CONSTRAINT "organization_modules_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "organization_modules_module_key_chk" CHECK ("module_key" = ANY (ARRAY[
        'FINANCE','HR','PAYROLL','ATTENDANCE','AI','REPORTING','INTEGRATION'
    ])),
    CONSTRAINT "organization_modules_org_fkey" FOREIGN KEY ("organization_id") REFERENCES "core"."organizations"("id") ON DELETE CASCADE
);
ALTER TABLE "core"."organization_modules" OWNER TO "postgres";
COMMENT ON TABLE "core"."organization_modules" IS 'Per-organization module enablement/config, e.g. gating the future HR/Payroll modules on the shared Supabase platform (spec 10.1, Appendix D).';

CREATE UNIQUE INDEX IF NOT EXISTS "uq_org_module_active"
  ON "core"."organization_modules" ("organization_id", "module_key")
  WHERE "effective_to" IS NULL;

CREATE OR REPLACE TRIGGER "organization_modules_updated_at" BEFORE UPDATE ON "core"."organization_modules"
  FOR EACH ROW EXECUTE FUNCTION "core"."set_updated_at"();

-- -----------------------------------------------------------------------------
-- 5. shared_people — stable cross-module person identity so the future
--    Employee Management System can reference the same person without a
--    second, conflicting identity model (spec 10.1, Appendix D.2).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "core"."shared_people" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "auth_user_id" "uuid",
    "display_name" "text" NOT NULL,
    "person_type" "text" NOT NULL DEFAULT 'EMPLOYEE',
    "status" "text" NOT NULL DEFAULT 'ACTIVE',
    "external_reference" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    CONSTRAINT "shared_people_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "shared_people_person_type_chk" CHECK ("person_type" = ANY (ARRAY['EMPLOYEE','CONTRACTOR','OWNER','OTHER'])),
    CONSTRAINT "shared_people_status_chk" CHECK ("status" = ANY (ARRAY['ACTIVE','INACTIVE','TERMINATED'])),
    CONSTRAINT "shared_people_org_fkey" FOREIGN KEY ("organization_id") REFERENCES "core"."organizations"("id") ON DELETE CASCADE,
    CONSTRAINT "shared_people_auth_user_fkey" FOREIGN KEY ("auth_user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL
);
ALTER TABLE "core"."shared_people" OWNER TO "postgres";
COMMENT ON TABLE "core"."shared_people" IS 'Stable cross-module person identity (spec Appendix D.2). Finance, and later HR/attendance/payroll, reference this ID rather than maintaining independent, conflicting identity records.';

CREATE UNIQUE INDEX IF NOT EXISTS "uq_shared_people_auth_user" ON "core"."shared_people" ("auth_user_id") WHERE "auth_user_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "idx_shared_people_org" ON "core"."shared_people" ("organization_id");

CREATE OR REPLACE TRIGGER "shared_people_updated_at" BEFORE UPDATE ON "core"."shared_people"
  FOR EACH ROW EXECUTE FUNCTION "core"."set_updated_at"();

CREATE OR REPLACE TRIGGER "shared_people_audit" AFTER INSERT OR DELETE OR UPDATE ON "core"."shared_people"
  FOR EACH ROW EXECUTE FUNCTION "audit"."trigger_audit_log"();

-- -----------------------------------------------------------------------------
-- RLS: deny-by-default on all five new tables. Only users with ADMIN_USERS /
-- ADMIN_CONFIG permission (existing codes used elsewhere in schema.sql) may
-- manage them; every authenticated user may read their own approval limits/
-- overrides/delegations so the frontend can render "what can I approve".
-- -----------------------------------------------------------------------------
ALTER TABLE "core"."approval_limits" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "core"."delegations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "core"."user_permission_overrides" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "core"."organization_modules" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "core"."shared_people" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "approval_limits_manage" ON "core"."approval_limits";
CREATE POLICY "approval_limits_manage" ON "core"."approval_limits"
  USING (core.has_permission(auth.uid(), 'ADMIN_USERS'))
  WITH CHECK (core.has_permission(auth.uid(), 'ADMIN_USERS'));

DROP POLICY IF EXISTS "approval_limits_select_own" ON "core"."approval_limits";
CREATE POLICY "approval_limits_select_own" ON "core"."approval_limits"
  FOR SELECT USING ("user_id" = auth.uid() OR core.has_permission(auth.uid(), 'ADMIN_USERS'));

DROP POLICY IF EXISTS "delegations_manage" ON "core"."delegations";
CREATE POLICY "delegations_manage" ON "core"."delegations"
  USING (core.has_permission(auth.uid(), 'ADMIN_USERS'))
  WITH CHECK (core.has_permission(auth.uid(), 'ADMIN_USERS'));

DROP POLICY IF EXISTS "delegations_select_own" ON "core"."delegations";
CREATE POLICY "delegations_select_own" ON "core"."delegations"
  FOR SELECT USING ("from_user_id" = auth.uid() OR "to_user_id" = auth.uid() OR core.has_permission(auth.uid(), 'ADMIN_USERS'));

DROP POLICY IF EXISTS "delegations_create_own" ON "core"."delegations";
CREATE POLICY "delegations_create_own" ON "core"."delegations"
  FOR INSERT WITH CHECK ("from_user_id" = auth.uid() OR core.has_permission(auth.uid(), 'ADMIN_USERS'));

DROP POLICY IF EXISTS "upo_manage" ON "core"."user_permission_overrides";
CREATE POLICY "upo_manage" ON "core"."user_permission_overrides"
  USING (core.has_permission(auth.uid(), 'ADMIN_USERS'))
  WITH CHECK (core.has_permission(auth.uid(), 'ADMIN_USERS'));

DROP POLICY IF EXISTS "upo_select_own" ON "core"."user_permission_overrides";
CREATE POLICY "upo_select_own" ON "core"."user_permission_overrides"
  FOR SELECT USING ("user_id" = auth.uid() OR core.has_permission(auth.uid(), 'ADMIN_USERS'));

DROP POLICY IF EXISTS "org_modules_manage" ON "core"."organization_modules";
CREATE POLICY "org_modules_manage" ON "core"."organization_modules"
  USING (core.has_permission(auth.uid(), 'ADMIN_CONFIG'))
  WITH CHECK (core.has_permission(auth.uid(), 'ADMIN_CONFIG'));

DROP POLICY IF EXISTS "org_modules_select" ON "core"."organization_modules";
CREATE POLICY "org_modules_select" ON "core"."organization_modules"
  FOR SELECT USING (auth.uid() IS NOT NULL);

DROP POLICY IF EXISTS "shared_people_manage" ON "core"."shared_people";
CREATE POLICY "shared_people_manage" ON "core"."shared_people"
  USING (core.has_permission(auth.uid(), 'ADMIN_USERS'))
  WITH CHECK (core.has_permission(auth.uid(), 'ADMIN_USERS'));

DROP POLICY IF EXISTS "shared_people_select_self" ON "core"."shared_people";
CREATE POLICY "shared_people_select_self" ON "core"."shared_people"
  FOR SELECT USING ("auth_user_id" = auth.uid() OR core.has_permission(auth.uid(), 'ADMIN_USERS'));

GRANT SELECT, INSERT, UPDATE, DELETE ON "core"."approval_limits" TO "authenticated";
GRANT SELECT, INSERT, UPDATE, DELETE ON "core"."delegations" TO "authenticated";
GRANT SELECT, INSERT, UPDATE, DELETE ON "core"."user_permission_overrides" TO "authenticated";
GRANT SELECT, INSERT, UPDATE, DELETE ON "core"."organization_modules" TO "authenticated";
GRANT SELECT, INSERT, UPDATE, DELETE ON "core"."shared_people" TO "authenticated";
GRANT ALL ON "core"."approval_limits", "core"."delegations", "core"."user_permission_overrides", "core"."organization_modules", "core"."shared_people" TO "service_role";

-- -----------------------------------------------------------------------------
-- Extend has_permission_with_limit-style checking to consult the new
-- per-user override and per-user/role approval_limits tables. This is an
-- additive, backward-compatible helper — existing calls to
-- core.has_permission / core.has_permission_with_limit are untouched, and
-- application/RLS code can adopt this richer function incrementally.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "core"."can_approve_amount"(
  "p_user_id" "uuid",
  "p_permission_code" "text",
  "p_transaction_type" "text",
  "p_amount" numeric,
  "p_currency" "text" DEFAULT 'PKR'
) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, core, public
AS $$
DECLARE
  v_denied boolean;
  v_user_limit numeric;
  v_role_limit numeric;
  v_base_ok boolean;
BEGIN
  -- 1. Explicit per-user DENY override always wins.
  SELECT EXISTS (
    SELECT 1 FROM core.user_permission_overrides upo
    JOIN core.permissions p ON p.id = upo.permission_id
    WHERE upo.user_id = p_user_id
      AND p.code = p_permission_code
      AND upo.override_type = 'DENY'
      AND CURRENT_DATE >= upo.effective_from
      AND (upo.effective_to IS NULL OR upo.effective_to >= CURRENT_DATE)
  ) INTO v_denied;

  IF v_denied THEN
    RETURN false;
  END IF;

  -- 2. Base permission (role-based or explicit per-user ALLOW override).
  v_base_ok := core.has_permission(p_user_id, p_permission_code);
  IF NOT v_base_ok THEN
    SELECT EXISTS (
      SELECT 1 FROM core.user_permission_overrides upo
      JOIN core.permissions p ON p.id = upo.permission_id
      WHERE upo.user_id = p_user_id
        AND p.code = p_permission_code
        AND upo.override_type = 'ALLOW'
        AND CURRENT_DATE >= upo.effective_from
        AND (upo.effective_to IS NULL OR upo.effective_to >= CURRENT_DATE)
    ) INTO v_base_ok;
  END IF;

  IF NOT v_base_ok THEN
    RETURN false;
  END IF;

  -- 3. Most specific applicable limit wins: per-user transaction-type limit,
  --    then role-level transaction-type limit, then role_permissions.amount_limit.
  SELECT MIN(al.max_amount) INTO v_user_limit
  FROM core.approval_limits al
  WHERE al.user_id = p_user_id
    AND al.transaction_type = p_transaction_type
    AND al.currency = p_currency
    AND CURRENT_DATE >= al.effective_from
    AND (al.effective_to IS NULL OR al.effective_to >= CURRENT_DATE);

  IF v_user_limit IS NOT NULL AND p_amount > v_user_limit THEN
    RETURN false;
  END IF;

  IF v_user_limit IS NULL THEN
    SELECT MIN(al.max_amount) INTO v_role_limit
    FROM core.approval_limits al
    JOIN core.user_roles ur ON ur.role_id = al.role_id
    WHERE ur.user_id = p_user_id
      AND ur.is_active = true
      AND al.transaction_type = p_transaction_type
      AND al.currency = p_currency
      AND CURRENT_DATE >= al.effective_from
      AND (al.effective_to IS NULL OR al.effective_to >= CURRENT_DATE);

    IF v_role_limit IS NOT NULL AND p_amount > v_role_limit THEN
      RETURN false;
    END IF;
  END IF;

  -- 4. Fall back to the existing role_permissions.amount_limit check so this
  --    function is a strict superset, never a regression, of the existing
  --    has_permission_with_limit.
  RETURN core.has_permission_with_limit(p_user_id, p_permission_code, p_amount);
END;
$$;

ALTER FUNCTION "core"."can_approve_amount"("uuid","text","text",numeric,"text") OWNER TO "postgres";
COMMENT ON FUNCTION "core"."can_approve_amount" IS 'Composite approval check: DENY override > ALLOW override/role permission > per-user limit > per-role transaction-type limit > role_permissions.amount_limit (spec 7.2, 7.3).';
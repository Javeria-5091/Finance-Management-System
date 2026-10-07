-- =============================================================================
-- Migration: P2_040_fix_rbac_overgrant_bug.sql
-- SECURITY FIX - found while investigating DEF-13/14/15 (permission issues
-- in the UAT report). This is a NEW, more serious defect than the three
-- being investigated: a missing-parentheses bug grants broad financial
-- permissions to EVERY role, not just the intended ones.
--
-- ROOT CAUSE
-- seed_data.sql (originating migration: grants for CEO / FINANCE_HEAD) runs:
--
--   WHERE r.name = 'CEO'
--     AND p.code LIKE 'INVOICE_%'
--     OR p.code LIKE 'VENDOR_%'
--     OR p.code LIKE 'PAYMENT_RECEIPT_%'
--     OR p.code LIKE 'CREDIT_NOTE_%'
--     OR p.code LIKE 'PROJECT_%'
--     OR p.code LIKE 'BUDGET_%'
--     OR p.code = 'BANK_TRANSFER'
--     OR p.code = 'BANK_TRANSFER_APPROVE'
--
-- In SQL, AND binds tighter than OR. Without parentheses this means:
--   (r.name='CEO' AND p.code LIKE 'INVOICE_%')
--    OR p.code LIKE 'VENDOR_%' OR p.code LIKE 'PAYMENT_RECEIPT_%' OR ... OR p.code = 'BANK_TRANSFER_APPROVE'
-- The 'CEO' condition only applies to the INVOICE_% clause. Every other
-- clause has no role condition at all, so it matches EVERY role in the
-- CROSS JOIN. The FINANCE_HEAD block directly below it has the identical bug.
--
-- CONFIRMED IMPACT: every role (including EMPLOYEE, VIEWER, AUDITOR, etc.)
-- was granted, at data_scope = 'ALL' (whole company, no restriction):
--   VENDOR_* (incl. VENDOR_PAYMENT_CREATE), PAYMENT_RECEIPT_* (incl. POST),
--   CREDIT_NOTE_* (incl. POST), PROJECT_* (incl. DELETE),
--   BUDGET_* (incl. APPROVE), BANK_TRANSFER, BANK_TRANSFER_APPROVE.
-- This also means a narrower, intentionally-scoped grant written later for
-- the SAME role/permission pair (e.g. PROJECT_MANAGER's BUDGET_READ, meant
-- to be scope='PROJECT') could have silently kept the wrong 'ALL' scope
-- instead, because the buggy block ran first and later INSERTs used
-- ON CONFLICT ... DO NOTHING.
--
-- This likely explains several "RBAC findings" in the UAT report that read
-- as inconsistent/unexplained access (Section 11), even though it is the
-- opposite problem from what DEF-13/14/15 described (too much access, not
-- too little) -- "budget_gl_actuals... denied for multiple roles" (DEF-13)
-- remains SEPARATE and unexplained; this fix does not close DEF-13/14/15.
--
-- FIX APPROACH: rather than try to reconstruct "which of these rows were
-- the bug and which were legitimate" (impossible to tell apart once merged
-- by ON CONFLICT DO NOTHING), this migration deletes every grant for the
-- affected permission codes for every role, then re-inserts exactly the
-- grants the seed script's own comments describe as intended, correctly
-- parenthesized this time. Roles not mentioned in the original blocks
-- (AUDITOR, VIEWER, TECHNICAL_ADMIN, CEO's HOD-style narrow reads, etc.)
-- intentionally get none of these permissions back -- if any of them
-- legitimately need one, that is a separate, explicit change request per
-- spec 5.1 ("change takes effect immediately with a complete audit record"),
-- not something to guess at here.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Remove every grant of the affected permission codes, for every role.
--    (effective_to IS NULL = the currently active grant; this does not
--    touch historical/expired rows, preserving the audit trail.)
-- ---------------------------------------------------------------------------
DELETE FROM core.role_permissions rp
USING core.permissions p
WHERE rp.permission_id = p.id
  AND rp.effective_to IS NULL
  AND (
       p.code LIKE 'VENDOR_%'
    OR p.code LIKE 'PAYMENT_RECEIPT_%'
    OR p.code LIKE 'CREDIT_NOTE_%'
    OR p.code LIKE 'PROJECT_%'
    OR p.code LIKE 'BUDGET_%'
    OR p.code = 'BANK_TRANSFER'
    OR p.code = 'BANK_TRANSFER_APPROVE'
    OR p.code LIKE 'INVOICE_%'
  );

-- ---------------------------------------------------------------------------
-- 2. CEO: all of the above (correctly parenthesized this time).
-- ---------------------------------------------------------------------------
INSERT INTO core.role_permissions (role_id, permission_id, data_scope, amount_limit)
SELECT r.id, p.id, 'ALL', NULL
FROM core.roles r CROSS JOIN core.permissions p
WHERE r.name = 'CEO'
  AND (
       p.code LIKE 'INVOICE_%'
    OR p.code LIKE 'VENDOR_%'
    OR p.code LIKE 'PAYMENT_RECEIPT_%'
    OR p.code LIKE 'CREDIT_NOTE_%'
    OR p.code LIKE 'PROJECT_%'
    OR p.code LIKE 'BUDGET_%'
    OR p.code = 'BANK_TRANSFER'
    OR p.code = 'BANK_TRANSFER_APPROVE'
  )
ON CONFLICT (role_id, permission_id, effective_from) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3. FINANCE_HEAD: same set as CEO (correctly parenthesized).
-- ---------------------------------------------------------------------------
INSERT INTO core.role_permissions (role_id, permission_id, data_scope, amount_limit)
SELECT r.id, p.id, 'ALL', NULL
FROM core.roles r CROSS JOIN core.permissions p
WHERE r.name = 'FINANCE_HEAD'
  AND (
       p.code LIKE 'INVOICE_%'
    OR p.code LIKE 'VENDOR_%'
    OR p.code LIKE 'PAYMENT_RECEIPT_%'
    OR p.code LIKE 'CREDIT_NOTE_%'
    OR p.code LIKE 'PROJECT_%'
    OR p.code LIKE 'BUDGET_%'
    OR p.code = 'BANK_TRANSFER'
    OR p.code = 'BANK_TRANSFER_APPROVE'
  )
ON CONFLICT (role_id, permission_id, effective_from) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 4. ACCOUNTANT: restore its originally-intended transactional subset
--    (this block in seed_data.sql was already correctly written with IN(),
--    but step 1 above removed it too, so it must be restored here).
-- ---------------------------------------------------------------------------
INSERT INTO core.role_permissions (role_id, permission_id, data_scope, amount_limit)
SELECT r.id, p.id, 'ALL', NULL
FROM core.roles r CROSS JOIN core.permissions p
WHERE r.name = 'ACCOUNTANT'
  AND p.code IN (
    'INVOICE_CREATE','INVOICE_READ','INVOICE_UPDATE','INVOICE_SUBMIT','INVOICE_VERIFY','INVOICE_POST',
    'VENDOR_CREATE','VENDOR_READ','VENDOR_UPDATE',
    'VENDOR_BILL_CREATE','VENDOR_BILL_READ','VENDOR_BILL_UPDATE','VENDOR_BILL_SUBMIT','VENDOR_BILL_VERIFY','VENDOR_BILL_POST',
    'VENDOR_PAYMENT_CREATE','VENDOR_PAYMENT_READ','VENDOR_PAYMENT_UPDATE',
    'PAYMENT_RECEIPT_CREATE','PAYMENT_RECEIPT_READ','PAYMENT_RECEIPT_UPDATE','PAYMENT_RECEIPT_POST',
    'CREDIT_NOTE_CREATE','CREDIT_NOTE_READ','CREDIT_NOTE_UPDATE','CREDIT_NOTE_POST',
    'PROJECT_READ','BUDGET_READ'
  )
ON CONFLICT (role_id, permission_id, effective_from) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 5. HOD: restore its originally-intended read-only subset.
-- ---------------------------------------------------------------------------
INSERT INTO core.role_permissions (role_id, permission_id, data_scope, amount_limit)
SELECT r.id, p.id, 'ALL', NULL
FROM core.roles r CROSS JOIN core.permissions p
WHERE r.name = 'HOD'
  AND p.code IN ('INVOICE_READ','VENDOR_BILL_READ','VENDOR_PAYMENT_READ','PROJECT_READ','BUDGET_READ')
ON CONFLICT (role_id, permission_id, effective_from) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 6. PROJECT_MANAGER: restore its originally-intended PROJECT-scoped subset
--    (this role is the clearest victim of the scope-corruption risk noted
--    above -- re-inserted here explicitly as scope='PROJECT').
-- ---------------------------------------------------------------------------
INSERT INTO core.role_permissions (role_id, permission_id, data_scope, amount_limit)
SELECT r.id, p.id, 'PROJECT', NULL
FROM core.roles r CROSS JOIN core.permissions p
WHERE r.name = 'PROJECT_MANAGER'
  AND p.code IN ('INVOICE_READ','VENDOR_BILL_READ','EXPENSE_READ','PROJECT_READ','BUDGET_READ')
ON CONFLICT (role_id, permission_id, effective_from) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 7. EMPLOYEE: restore its originally-intended own-record-only subset.
-- ---------------------------------------------------------------------------
INSERT INTO core.role_permissions (role_id, permission_id, data_scope, amount_limit)
SELECT r.id, p.id, 'OWN', NULL
FROM core.roles r CROSS JOIN core.permissions p
WHERE r.name = 'EMPLOYEE'
  AND p.code IN ('INVOICE_READ')
ON CONFLICT (role_id, permission_id, effective_from) DO NOTHING;

COMMIT;

-- ---------------------------------------------------------------------------
-- Run this AFTER the migration to see the corrected grant for every role,
-- so it can be checked against Appendix A of the spec before retest:
-- ---------------------------------------------------------------------------
-- SELECT r.name AS role, p.code AS permission, rp.data_scope
-- FROM core.role_permissions rp
-- JOIN core.roles r ON r.id = rp.role_id
-- JOIN core.permissions p ON p.id = rp.permission_id
-- WHERE rp.effective_to IS NULL
--   AND (p.code LIKE 'VENDOR_%' OR p.code LIKE 'PAYMENT_RECEIPT_%' OR p.code LIKE 'CREDIT_NOTE_%'
--        OR p.code LIKE 'PROJECT_%' OR p.code LIKE 'BUDGET_%' OR p.code LIKE 'INVOICE_%'
--        OR p.code IN ('BANK_TRANSFER','BANK_TRANSFER_APPROVE'))
-- ORDER BY r.name, p.code;
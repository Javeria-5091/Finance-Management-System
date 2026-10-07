-- =============================================================================
-- Migration: P2_042_expense_approval_limits.sql
-- Implements: CTO-approved escalation limits (decision received 7 Oct 2026)
--
-- Decision: keep the existing limit-based escalation model (not the stricter
-- "every level must approve" chain). Initial limits:
--   HOD            : up to  PKR  50,000
--   FINANCE_HEAD   : above  PKR  50,000, up to PKR 250,000
--   CEO            : above  PKR 250,000 (no cap)
--
-- These are inserted as DATA into core.approval_limits (role-level, EXPENSE,
-- PKR), not hardcoded into any workflow logic -- core.can_approve_amount()
-- already reads this table (see P2_038's reporting.my_pending_approvals(),
-- which already calls it). No application code changes needed for this.
--
-- CEO gets no row here: core.can_approve_amount() only rejects an amount
-- when a matching limit row EXISTS and is exceeded; with no row for CEO,
-- nothing caps them, which is the correct way to represent "no cap" in this
-- schema (consistent with how CEO's role_permissions.amount_limit is
-- already NULL elsewhere in the system).
--
-- Only HOD and FINANCE_HEAD limits were specified by the CTO; no other
-- role's limit is touched by this migration.
-- =============================================================================

BEGIN;

-- Supersede any existing active HOD / FINANCE_HEAD expense limit rather than
-- stacking a second row (core.can_approve_amount takes MIN(max_amount) across
-- all matching active rows, so a stray old row could silently out-cap this
-- one). Close out any currently-open row first.
UPDATE core.approval_limits al
SET effective_to = CURRENT_DATE - 1
FROM core.roles r
WHERE al.role_id = r.id
  AND r.name IN ('HOD', 'FINANCE_HEAD')
  AND al.transaction_type = 'EXPENSE'
  AND al.currency = 'PKR'
  AND al.effective_to IS NULL;

INSERT INTO core.approval_limits (role_id, transaction_type, currency, max_amount, scope, effective_from, notes)
SELECT r.id, 'EXPENSE', 'PKR', 50000.00, 'DEPARTMENT', CURRENT_DATE,
       'CTO-approved limit, 7 Oct 2026: HOD may approve expenses up to PKR 50,000 within their department; above this, the request escalates to Finance Head.'
FROM core.roles r WHERE r.name = 'HOD';

INSERT INTO core.approval_limits (role_id, transaction_type, currency, max_amount, scope, effective_from, notes)
SELECT r.id, 'EXPENSE', 'PKR', 250000.00, 'ALL', CURRENT_DATE,
       'CTO-approved limit, 7 Oct 2026: Finance Head may approve expenses up to PKR 250,000; above this, the request escalates to CEO.'
FROM core.roles r WHERE r.name = 'FINANCE_HEAD';

COMMIT;

-- ---------------------------------------------------------------------------
-- Run this after COMMIT to confirm the limits took effect:
-- ---------------------------------------------------------------------------
-- SELECT r.name AS role, al.max_amount, al.scope, al.effective_from, al.effective_to
-- FROM core.approval_limits al
-- JOIN core.roles r ON r.id = al.role_id
-- WHERE al.transaction_type = 'EXPENSE' AND al.currency = 'PKR'
-- ORDER BY r.name, al.effective_from DESC;
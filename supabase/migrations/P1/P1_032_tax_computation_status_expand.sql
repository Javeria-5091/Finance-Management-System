-- =============================================================================
-- Migration: 019_tax_computation_status_expand.sql
-- Purpose:   Fix compliance issue C-5 (Schema Compliance Audit, Critical
--            Findings). Spec ref: Section 5.12.1 required statuses "Draft,
--            Calculated, Under Review, Approved, Filed, Payment Pending,
--            Paid, Refund Pending, Amended, and Closed."
--
-- Problem:   finance.tax_computations.status currently only allows DRAFT,
--            REVIEWED, APPROVED, FILED, ADJUSTED via
--            tax_computations_status_check. Several spec-required states
--            (CALCULATED, UNDER_REVIEW, PAYMENT_PENDING, PAID,
--            REFUND_PENDING, CLOSED) have no allowed value to transition
--            into at the computation-header level.
--
--            Note: finance.tax_returns already has a broader, largely
--            overlapping status list (DRAFT/PREPARED/UNDER_REVIEW/APPROVED/
--            FILED/ACKNOWLEDGED/ASSESSED/ADJUSTED/CANCELLED) and
--            finance.tax_payments_and_refunds tracks payment/refund status
--            separately. This migration does not assume tax_computations is
--            the *only* place these states must exist -- it only ensures the
--            values spec explicitly ties to the computation itself
--            (Calculated, Under Review, Payment Pending, Paid, Refund
--            Pending, Closed) are not database-rejected if the application
--            needs to set them there. Confirm with the implementation team
--            whether the app in fact drives these states from
--            tax_computations, tax_returns, or a combination, and remove any
--            values here that are confirmed to belong exclusively elsewhere.
--
-- Fix:       Widen the CHECK constraint (additive; does not remove any
--            currently-allowed value, so no existing row can violate it).
--
-- Data safety: Purely additive to the allowed value set. Existing rows keep
--            their existing status values, all of which remain valid.
-- =============================================================================

BEGIN;

ALTER TABLE "finance"."tax_computations"
  DROP CONSTRAINT IF EXISTS "tax_computations_status_check";

ALTER TABLE "finance"."tax_computations"
  ADD CONSTRAINT "tax_computations_status_check"
  CHECK (("status" = ANY (ARRAY[
    'DRAFT'::text,
    'CALCULATED'::text,
    'REVIEWED'::text,
    'UNDER_REVIEW'::text,
    'APPROVED'::text,
    'FILED'::text,
    'PAYMENT_PENDING'::text,
    'PAID'::text,
    'REFUND_PENDING'::text,
    'ADJUSTED'::text,
    'CLOSED'::text
  ])));

COMMENT ON COLUMN "finance"."tax_computations"."status" IS
  'Spec Section 5.12.1 state set (Draft/Calculated/Under Review/Approved/'
  'Filed/Payment Pending/Paid/Refund Pending/Amended[=Adjusted]/Closed). '
  'REVIEWED is retained alongside UNDER_REVIEW for backward compatibility '
  'with existing rows/application code -- confirm with the implementation '
  'team whether one should be deprecated. See Migration 019 / compliance '
  'audit Section C-5.';

COMMIT;

-- -----------------------------------------------------------------------------
-- Verification (read-only)
-- -----------------------------------------------------------------------------
-- SELECT status, COUNT(*) FROM finance.tax_computations GROUP BY status;
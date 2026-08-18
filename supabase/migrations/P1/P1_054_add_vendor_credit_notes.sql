-- =====================================================================
-- Migration 035: Support vendor-side (AP) credit notes
-- =====================================================================
-- FINDING (confirmed from prior analysis, HIGH-1):
--   finance.credit_notes is hard-wired to the receivables side only:
--     "invoice_id" uuid NOT NULL
--   with no vendor-bill equivalent, and no separate vendor_credit_notes
--   table exists anywhere in the schema (confirmed: zero matches for
--   "vendor_credit" in schema.sql).
--
-- SPEC REQUIREMENT:
--   §5.7: "Support vendor bill entry, approval, due dates, partial
--   payment, credit note, withholding, and recurring bills."
--   §2.1 and §12.3 both list credit notes as in-scope for AP, not just
--   AR.
--
-- FIX APPROACH:
--   Rather than create a duplicate parallel table (which would fork
--   status/posting/audit logic and violate the "reusable business
--   rule, not a one-off" principle in spec §1 "How the development
--   team must use this document"), extend the existing, already fully
--   wired finance.credit_notes table to support either side:
--     - invoice_id becomes nullable
--     - vendor_bill_id is added (nullable)
--     - a CHECK constraint enforces exactly one of the two is set
--       (a credit note is against either a client invoice or a vendor
--       bill, never both, never neither)
--   All existing triggers (audit, prevent_closed_period_posting,
--   updated_at) are column-generic and require no change. All existing
--   RLS policies (fixed for organization isolation in Migration 032)
--   are unaffected because they do not reference invoice_id.
--
-- SAFE DATA MIGRATION:
--   invoice_id is being relaxed from NOT NULL to nullable, which is
--   always safe (loosening a constraint never invalidates existing
--   rows). No existing row has vendor_bill_id populated (new column,
--   default NULL), so the mutual-exclusivity CHECK is satisfied by
--   every existing row (invoice_id IS NOT NULL, vendor_bill_id IS
--   NULL) without any backfill.
-- =====================================================================

BEGIN;

ALTER TABLE finance.credit_notes
  ALTER COLUMN invoice_id DROP NOT NULL;

ALTER TABLE finance.credit_notes
  ADD COLUMN IF NOT EXISTS vendor_bill_id uuid;

ALTER TABLE finance.credit_notes
  ADD CONSTRAINT credit_notes_vendor_bill_id_fkey
  FOREIGN KEY (vendor_bill_id) REFERENCES finance.vendor_bills(id);

ALTER TABLE finance.credit_notes
  ADD CONSTRAINT credit_notes_exactly_one_source
  CHECK (
    (invoice_id IS NOT NULL AND vendor_bill_id IS NULL)
    OR (invoice_id IS NULL AND vendor_bill_id IS NOT NULL)
  );

-- Rename credit_note_number's implicit scope by adding a discriminator
-- column so reporting/aging views can distinguish AR credit notes from
-- AP (vendor) credit notes without inferring it from which FK is set.
ALTER TABLE finance.credit_notes
  ADD COLUMN IF NOT EXISTS credit_note_type text
  GENERATED ALWAYS AS (
    CASE WHEN invoice_id IS NOT NULL THEN 'AR' ELSE 'AP' END
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_credit_notes_vendor_bill_id
  ON finance.credit_notes USING btree (vendor_bill_id);

COMMENT ON TABLE finance.credit_notes IS
  'Credit notes against either a client invoice (AR, invoice_id set) or '
  'a vendor bill (AP, vendor_bill_id set) -- see credit_notes_exactly_one_source. '
  'Extended for AP support in Migration 035 (spec §5.7 / §2.1 / §12.3).';

COMMIT;

-- Validation:
--   -- AR credit note (existing behavior, must still work):
--   -- INSERT INTO finance.credit_notes (invoice_id, reason, amount, base_amount, created_by, organization_id)
--   --   VALUES ('<invoice-uuid>', 'Billing correction', 100, 100, '<user-uuid>', '<org-uuid>');
--   -- AP (vendor) credit note (new capability):
--   -- INSERT INTO finance.credit_notes (vendor_bill_id, reason, amount, base_amount, created_by, organization_id)
--   --   VALUES ('<vendor-bill-uuid>', 'Vendor overcharge', 50, 50, '<user-uuid>', '<org-uuid>');
--   -- Must be rejected (both set):
--   -- INSERT INTO finance.credit_notes (invoice_id, vendor_bill_id, reason, amount, base_amount, created_by, organization_id)
--   --   VALUES ('<invoice-uuid>', '<vendor-bill-uuid>', 'bad', 1, 1, '<user-uuid>', '<org-uuid>');
--   -- Must be rejected (neither set):
--   -- INSERT INTO finance.credit_notes (reason, amount, base_amount, created_by, organization_id)
--   --   VALUES ('bad', 1, 1, '<user-uuid>', '<org-uuid>');
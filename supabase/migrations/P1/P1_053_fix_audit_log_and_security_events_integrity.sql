-- =====================================================================
-- Migration 034: Audit trail integrity -- remove forgeable direct
-- writes to audit.audit_log and audit.security_events
-- =====================================================================
-- FINDING 1 (confirmed from prior analysis): audit.audit_log has
--   CREATE POLICY "audit_log_insert" ON audit.audit_log FOR INSERT
--     TO authenticated WITH CHECK ((auth.uid() = user_id) OR (auth.uid() = changed_by));
--   The legitimate audit trail is populated exclusively by
--   audit.trigger_audit_log(), which is SECURITY DEFINER and therefore
--   does not need -- and never uses -- this policy to do its job.
--   The policy's only effect is to let any authenticated user insert
--   arbitrary, self-attributed rows directly into the audit table
--   (action text, entity references, before/after JSON, reason, etc.),
--   undermining the append-only/tamper-evidence guarantee required by
--   spec §8 ("append-only from the application perspective... tamper
--   resistance") and §1.1 ("No person... is excluded from audit
--   logging" implies the log reflects only real actions).
--
-- FINDING 2 (newly discovered, NOT in the prior analysis): the
--   sibling table audit.security_events is WORSE:
--     CREATE POLICY "sec_events_insert" ON audit.security_events
--       FOR INSERT TO authenticated WITH CHECK (true);
--   This has no ownership check at all -- any authenticated user can
--   insert a security event row with ANY user_id, including someone
--   else's, and any event_type (LOGIN_FAILURE, LOCKOUT,
--   SUSPICIOUS_ACCESS, PERMISSION_CHANGE, ROLE_CHANGE...). A malicious
--   or compromised low-privilege account could fabricate a
--   "SUSPICIOUS_ACCESS" or "LOCKOUT" event against another user, or
--   forge a clean LOGIN_SUCCESS trail for themselves. This directly
--   contradicts spec §8.3 ("Audit events use a separate table/schema
--   with restricted insert-only service access") -- "restricted" is
--   not satisfied by WITH CHECK (true).
--
-- FIX:
--   - Drop the direct authenticated INSERT policy on audit.audit_log.
--     All writes continue to flow through audit.trigger_audit_log(),
--     which is SECURITY DEFINER and unaffected by this change.
--   - Tighten audit.security_events INSERT so a caller may only write
--     a row that claims their own auth.uid() as user_id (matching the
--     protection audit_log_insert already had, since a real login/MFA/
--     session event legitimately originates client-side before a
--     server-side audit trigger could fire). service_role retains full
--     access via the existing sec_events_service_all policy for
--     server-issued events (e.g. LOCKOUT issued by a backend job).
-- =====================================================================

BEGIN;

-- --- audit.audit_log: remove the unnecessary direct-insert surface ---
DROP POLICY IF EXISTS "audit_log_insert" ON "audit"."audit_log";

-- No replacement INSERT policy is created. With RLS enabled and no
-- INSERT policy for the "authenticated" role, ordinary users can no
-- longer insert into audit.audit_log at all; audit.trigger_audit_log()
-- is SECURITY DEFINER and bypasses RLS, so legitimate audit capture is
-- completely unaffected.

-- --- audit.security_events: close the forgery gap ---
DROP POLICY IF EXISTS "sec_events_insert" ON "audit"."security_events";

CREATE POLICY "sec_events_insert" ON "audit"."security_events" FOR INSERT
  TO "authenticated"
  WITH CHECK (
    "user_id" IS NULL           -- allow anonymous/pre-auth events (e.g. LOGIN_FAILURE before session exists)
    OR "auth"."uid"() = "user_id"
  );

COMMIT;

-- Validation:
--   -- As a non-privileged authenticated user, attempt to forge an
--   -- event against a different user_id: must be rejected.
--   -- INSERT INTO audit.security_events (user_id, event_type)
--   --   VALUES ('<someone-elses-uuid>', 'SUSPICIOUS_ACCESS'); -- expect permission denied / RLS violation
--   -- Confirm legitimate trigger-based audit_log writes still work by
--   -- performing any normal audited action (e.g. update a journal_entries
--   -- row) and confirming a corresponding audit.audit_log row appears.
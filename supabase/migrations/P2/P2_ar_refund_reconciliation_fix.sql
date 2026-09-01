-- =====================================================================
-- Finance Management System — Critical Fix
--   AR-05 (P1): Refund posting breaks AR subledger vs control-account
--               reconciliation.
--
--   finance.post_invoice_refund_atomic posts:
--     DR Revenue (4110)   refund.amount
--     CR Cash              refund.amount
--   -- correct: the invoice was already fully collected, so refunding
--   part of that cash is a straight revenue-reversal / cash-out event
--   that never touches Accounts Receivable (GL 1210). No receivable is
--   being recreated; the client isn't being asked to pay again.
--
--   But the SAME function then also directly rewrote the invoice's
--   subledger balance:
--     v_new_outstanding := greatest(0, outstanding_amount - refund.amount)
--   i.e. it reduced invoices.outstanding_amount (and
--   base_outstanding_amount) by the refund amount, with ZERO
--   corresponding posting to the AR control account (1210) in the GL
--   journal above.
--
--   That is precisely what breaks subledger-vs-control-account
--   reconciliation: AR subledger total = SUM(invoices.outstanding_amount)
--   for receivable-status invoices; AR control account balance = SUM of
--   everything ever posted to GL account 1210. Every legitimate change to
--   one must have a matching entry in the other (invoice issuance: DR
--   1210 + subledger up; payment: CR 1210 + subledger down). This refund
--   moved the subledger side with NO journal line on 1210 at all -- the
--   two permanently drift apart by the refund amount, every time a
--   refund is posted against a PARTIALLY_PAID invoice (an invoice
--   already fully PAID has outstanding_amount pinned at 0 by
--   greatest(0, ...), so the drift is silent there and only surfaces on
--   partially-paid invoices, making it easy to miss in testing).
--
--   (This function was previously touched by FND-FIN-006/FND-FIN-007,
--   which correctly stopped it from rewriting invoices.total_amount --
--   but left the outstanding_amount mutation in place. AR-05 finishes
--   that fix: since the GL journal legitimately never posts to the AR
--   control account for a refund, the subledger must not move either.
--   Reconciliation only holds when NEITHER side changes for this kind
--   of transaction.)
--
--   Fix:
--     1) Stop mutating invoices.amount_paid / outstanding_amount /
--        base_outstanding_amount entirely on refund posting. The GL
--        entry (Revenue/Cash) stays exactly as-is; the subledger now
--        genuinely stays untouched to match it.
--     2) invoices.status may still move to 'REFUNDED' (a lifecycle/
--        reporting marker excluded from reporting.receivable_aging,
--        same as VOID/CREDITED), but the trigger for that is now
--        cumulative POSTED refunds vs. amount_paid -- not the broken
--        outstanding-amount arithmetic.
--     3) Add the same cumulative-refund-vs-amount_paid guard that
--        src/app/api/finance/invoices/refunds/route.ts:82 already
--        enforces at DRAFT-creation time, but re-checked here at
--        POSTING time inside the same transaction as everything else.
--        The route-level check alone has a TOCTOU gap: two refunds for
--        the same invoice can each individually pass creation-time
--        validation and still be posted well after that check ran,
--        letting combined refunds exceed what was ever actually
--        collected -- itself a form of subledger/control-account
--        corruption (refunding cash that was never received). This
--        closes that gap at the only point that can't be raced.
--
-- Safe to run more than once (CREATE OR REPLACE).
-- =====================================================================

BEGIN;

CREATE OR REPLACE FUNCTION "finance"."post_invoice_refund_atomic"("p_refund_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'finance', 'public', 'core'
    AS $$
DECLARE
  v_org uuid := core.current_user_org_id();
  v_refund record;
  v_invoice record;
  v_cash uuid;
  v_revenue uuid;
  v_period uuid;
  v_journal_id uuid;
  v_reference text;
  v_already_refunded numeric(18,2);
  v_new_status text;
  v_lines jsonb;
BEGIN
  IF v_org IS NULL OR NOT (core.is_finance_head() OR core.has_role('ACCOUNTANT')) THEN
    RAISE EXCEPTION 'Access denied';
  END IF;

  SELECT * INTO v_refund
  FROM finance.invoice_refunds
  WHERE id=p_refund_id AND organization_id=v_org
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Refund not found or access denied'; END IF;
  IF v_refund.status <> 'APPROVED' THEN RAISE EXCEPTION 'Only APPROVED refunds can be posted'; END IF;

  SELECT id,total_amount,outstanding_amount,base_outstanding_amount,currency,exchange_rate,amount_paid,status,organization_id
    INTO v_invoice
  FROM public.invoices
  WHERE id=v_refund.invoice_id AND organization_id=v_org
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Linked invoice not found or access denied'; END IF;

  -- AR-05 FIX: cumulative check (not just this single refund) against
  -- amount already paid, re-verified here at posting time -- closes the
  -- TOCTOU gap the route-level check at refunds/route.ts:82 can't cover
  -- by itself (two refunds each individually valid at creation time can
  -- still combine to exceed amount_paid by the time both are posted).
  SELECT COALESCE(SUM(amount),0) INTO v_already_refunded
  FROM finance.invoice_refunds
  WHERE invoice_id=v_refund.invoice_id AND organization_id=v_org AND status='POSTED';

  IF v_already_refunded + v_refund.amount > coalesce(v_invoice.amount_paid,0) + 0.01 THEN
    RAISE EXCEPTION 'Cumulative refunds (%) would exceed amount already paid (%) for invoice %',
      v_already_refunded + v_refund.amount, v_invoice.amount_paid, v_invoice.id;
  END IF;

  SELECT id INTO v_period
  FROM finance.accounting_periods
  WHERE organization_id=v_org AND status='OPEN'
  ORDER BY start_date DESC LIMIT 1;
  IF v_period IS NULL THEN RAISE EXCEPTION 'No OPEN accounting period found'; END IF;

  SELECT linked_ledger_account_id INTO v_cash
  FROM finance.financial_accounts
  WHERE id=v_refund.financial_account_id AND organization_id=v_org AND is_active=true;
  IF v_cash IS NULL THEN RAISE EXCEPTION 'Refund financial account is missing, inactive, or not linked to a ledger account'; END IF;

  SELECT id INTO v_revenue FROM finance.chart_of_accounts
  WHERE code='4110' AND account_type='REVENUE' AND is_active=true AND organization_id=v_org LIMIT 1;
  IF v_revenue IS NULL THEN RAISE EXCEPTION 'Revenue account 4110 is not configured for this organization'; END IF;

  IF EXISTS (SELECT 1 FROM finance.journal_entries WHERE source_type='INVOICE_REFUND' AND source_id=p_refund_id AND organization_id=v_org) THEN
    RAISE EXCEPTION 'Refund is already posted';
  END IF;

  -- Cash already fully collected for this invoice; refunding part of it
  -- back out is a revenue reversal + cash outflow. This intentionally
  -- never touches the Accounts Receivable control account (1210) -- no
  -- new receivable is created, the client isn't being asked to pay
  -- again.
  v_lines := jsonb_build_array(
    jsonb_build_object('account_id',v_revenue,'debit_amount',v_refund.amount,'credit_amount',0,'description','Refund: '||v_refund.refund_number),
    jsonb_build_object('account_id',v_cash,'debit_amount',0,'credit_amount',v_refund.amount,'description','Cash refund: '||v_refund.refund_number)
  );

  v_journal_id := finance.post_journal_entry(
    'Invoice refund '||v_refund.refund_number,
    current_date,v_period,v_lines,v_refund.currency,coalesce(v_refund.exchange_rate,1),'INVOICE_REFUND',p_refund_id,NULL,NULL
  );

  -- AR-05 FIX: no longer touches amount_paid / outstanding_amount /
  -- base_outstanding_amount. The GL journal above never posts to the AR
  -- control account (1210), so the AR subledger must not move either --
  -- that symmetry is what keeps reporting.receivable_aging (subledger)
  -- and the 1210 GL balance (control account) reconciled. total_amount
  -- was already correctly left alone by the prior FND-FIN-006/007 fix.
  --
  -- status may still move to REFUNDED, purely as a lifecycle/reporting
  -- marker once cumulative POSTED refunds reach what was actually paid
  -- (same exclusion treatment as VOID/CREDITED in reporting.receivable_aging) --
  -- this does not change any dollar figure, only the status column.
  v_new_status := CASE
    WHEN (v_already_refunded + v_refund.amount) >= coalesce(v_invoice.amount_paid,0) - 0.01 THEN 'REFUNDED'
    ELSE v_invoice.status
  END;

  UPDATE public.invoices
  SET status=v_new_status
  WHERE id=v_invoice.id AND organization_id=v_org;

  UPDATE finance.invoice_refunds
  SET status='POSTED',journal_entry_id=v_journal_id,posted_at=now(),updated_at=now()
  WHERE id=p_refund_id AND organization_id=v_org AND status='APPROVED';
  IF NOT FOUND THEN RAISE EXCEPTION 'Refund status update failed'; END IF;

  SELECT reference INTO v_reference FROM finance.journal_entries WHERE id=v_journal_id;
  -- outstanding_amount echoed back unchanged (kept in the response shape
  -- for API/frontend compatibility) -- it is, by design, no longer
  -- affected by posting a refund.
  RETURN jsonb_build_object(
    'journal_id',v_journal_id,
    'reference',v_reference,
    'outstanding_amount',v_invoice.outstanding_amount,
    'invoice_status',v_new_status
  );
END;
$$;

ALTER FUNCTION "finance"."post_invoice_refund_atomic"("p_refund_id" "uuid") OWNER TO "postgres";

COMMENT ON FUNCTION "finance"."post_invoice_refund_atomic"("p_refund_id" "uuid") IS
  'AR-05 fix: stopped mutating invoices.amount_paid/outstanding_amount/base_outstanding_amount on refund posting -- the GL journal (DR Revenue / CR Cash) never posts to the AR control account (1210), so the subledger must stay untouched too, or the two permanently drift apart. status may still move to REFUNDED (lifecycle marker only, no dollar impact) once cumulative POSTED refunds reach amount_paid. Also added a cumulative-refund-vs-amount_paid guard at posting time, closing a TOCTOU gap the route-level check (refunds/route.ts) cannot cover alone. Supersedes the outstanding_amount-reduction behavior introduced by FND-FIN-006/FND-FIN-007, which correctly stopped total_amount from being rewritten but left this reconciliation break in place.';

COMMIT;

-- ---------------------------------------------------------------------
-- Verification (run manually):
--
-- 1) Take a PARTIALLY_PAID invoice: total_amount=1000, amount_paid=400,
--    outstanding_amount=600. Create+approve+post a refund of 150.
--    Confirm on public.invoices: amount_paid still 400,
--    outstanding_amount still 600 (UNCHANGED), status still
--    PARTIALLY_PAID. Confirm GL: journal has DR 4110 150 / CR cash-account
--    150, and finance.chart_of_accounts code 1210 balance is unaffected.
--
-- 2) Post a second refund of 250 against the same invoice (cumulative
--    150+250=400 == amount_paid). Confirm status flips to REFUNDED,
--    outstanding_amount is still untouched (600, unchanged throughout).
--    Confirm the invoice now no longer appears in
--    reporting.receivable_aging (REFUNDED is excluded there).
--
-- 3) Attempt a third refund that would push cumulative POSTED refunds
--    over amount_paid (e.g. another 50, taking cumulative to 450 > 400).
--    Expect: exception "Cumulative refunds (...) would exceed amount
--    already paid (...)" and no journal/refund/invoice changes.
--
-- 4) Confirm SUM(outstanding_amount) across reporting.receivable_aging
--    before and after step 1/2 above only changes because of the status
--    exclusion in step 2, never because of the refund dollar amount
--    itself -- i.e. GL 1210 balance and subledger total move together
--    (both unaffected by the refund's own journal, both only affected
--    by the invoice leaving the "payable" status set).
-- ---------------------------------------------------------------------
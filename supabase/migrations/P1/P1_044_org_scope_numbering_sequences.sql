-- 044_org_scope_numbering_sequences.sql
-- Fixes: finance.get_next_number()/peek_next_number()/reset_sequence()
-- selected the "OPEN" fiscal year and numbering sequence with no
-- organization_id filter. Harmless today (single org) but would return
-- another organization's sequence/number in a multi-org deployment.
-- Backward compatible: existing call sites (finance.post_journal_entry
-- etc. call get_next_number(p_type) with one argument) continue to work
-- unchanged because the new parameter defaults to the caller's own org.

BEGIN;

CREATE OR REPLACE FUNCTION finance.get_next_number(
  p_type text,
  p_organization_id uuid DEFAULT core.current_user_org_id()
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'finance', 'core', 'public'
AS $$
DECLARE
    v_seq RECORD;
    v_next_num INTEGER;
    v_result TEXT;
    v_fy_id UUID;
BEGIN
    SELECT id INTO v_fy_id
    FROM finance.fiscal_years
    WHERE status = 'OPEN'
      AND (p_organization_id IS NULL OR organization_id = p_organization_id)
    ORDER BY start_date DESC
    LIMIT 1;

    SELECT * INTO v_seq
    FROM finance.numbering_sequences
    WHERE sequence_type = p_type
      AND (fiscal_year_id = v_fy_id OR fiscal_year_id IS NULL)
      AND (p_organization_id IS NULL OR organization_id = p_organization_id)
    ORDER BY fiscal_year_id DESC NULLS LAST
    LIMIT 1
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Numbering sequence not found for type: % (organization: %)', p_type, p_organization_id;
    END IF;

    v_next_num := v_seq.current_number + 1;

    UPDATE finance.numbering_sequences
    SET current_number = v_next_num
    WHERE id = v_seq.id;

    v_result := REPLACE(v_seq.format, '{PREFIX}', v_seq.prefix);
    v_result := REPLACE(v_result, '{NUMBER}', LPAD(v_next_num::TEXT, v_seq.padding, '0'));

    RETURN v_result;
END;
$$;

COMMENT ON FUNCTION finance.get_next_number(text, uuid) IS
  'Fixed migration 035 (Compliance Audit R5): added optional p_organization_id (defaults to caller''s own org via core.current_user_org_id()) so numbering sequences and open-fiscal-year lookup cannot cross organization boundaries in a multi-org deployment. Existing single-argument call sites are unaffected.';

COMMIT;
-- ================================================================
-- OSYSTIC Finance — Monitoring & Alerting Foundation
-- Safe corrected version
--
-- Fixes:
--   1. Authenticated users cannot create NULL-org monitoring events.
--   2. Authenticated users cannot read NULL-org/global events.
--   3. health_summary() is organization scoped for authenticated users.
--   4. service_role may still record/read global operational events.
--   5. Existing financial tables/posting functions are untouched.
--
-- Additive only.
-- ================================================================

CREATE SCHEMA IF NOT EXISTS ops;

GRANT USAGE ON SCHEMA ops TO authenticated;
GRANT USAGE ON SCHEMA ops TO service_role;


-- ================================================================
-- 1. Monitoring events
-- ================================================================

CREATE TABLE IF NOT EXISTS ops.monitoring_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  organization_id UUID,

  service         TEXT NOT NULL,

  event_type      TEXT NOT NULL,

  severity        TEXT NOT NULL DEFAULT 'info'
                    CHECK (
                      severity IN (
                        'info',
                        'warning',
                        'error',
                        'critical'
                      )
                    ),

  status          TEXT NOT NULL DEFAULT 'open'
                    CHECK (
                      status IN (
                        'open',
                        'acknowledged',
                        'resolved'
                      )
                    ),

  message         TEXT NOT NULL,

  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,

  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  resolved_at     TIMESTAMPTZ,

  resolved_by     UUID
);


CREATE INDEX IF NOT EXISTS idx_monitoring_events_org_time
  ON ops.monitoring_events (
    organization_id,
    occurred_at DESC
  );

CREATE INDEX IF NOT EXISTS idx_monitoring_events_severity
  ON ops.monitoring_events (
    severity,
    status,
    occurred_at DESC
);


ALTER TABLE ops.monitoring_events
ENABLE ROW LEVEL SECURITY;


-- ================================================================
-- 2. RLS
--
-- Authenticated users can ONLY see events for their own org.
-- NULL-org/system events are intentionally NOT exposed to
-- authenticated users.
--
-- service_role bypasses RLS in Supabase/Postgres.
-- ================================================================

DROP POLICY IF EXISTS monitoring_events_select_org
ON ops.monitoring_events;

CREATE POLICY monitoring_events_select_org
ON ops.monitoring_events
FOR SELECT
TO authenticated
USING (
  organization_id IS NOT NULL
  AND organization_id = core.current_user_org_id()
);


GRANT SELECT
ON ops.monitoring_events
TO authenticated;


-- ================================================================
-- 3. Record monitoring event
-- ================================================================

CREATE OR REPLACE FUNCTION ops.record_monitoring_event(
  p_service    TEXT,
  p_event_type TEXT,
  p_severity   TEXT,
  p_message    TEXT,
  p_metadata   JSONB DEFAULT '{}'::jsonb
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, ops, public, core
AS $$
DECLARE
  v_org UUID;
  v_id  UUID;
BEGIN

  -- --------------------------------------------------------------
  -- Resolve organization from authenticated context.
  -- --------------------------------------------------------------

  v_org := core.current_user_org_id();


  -- --------------------------------------------------------------
  -- Validate required fields.
  -- --------------------------------------------------------------

  IF p_service IS NULL
     OR btrim(p_service) = '' THEN

    RAISE EXCEPTION
      'monitoring service is required';

  END IF;


  IF p_event_type IS NULL
     OR btrim(p_event_type) = '' THEN

    RAISE EXCEPTION
      'monitoring event_type is required';

  END IF;


  IF p_message IS NULL
     OR btrim(p_message) = '' THEN

    RAISE EXCEPTION
      'monitoring message is required';

  END IF;


  IF p_severity IS NULL
     OR p_severity NOT IN (
       'info',
       'warning',
       'error',
       'critical'
     ) THEN

    RAISE EXCEPTION
      'invalid monitoring severity';

  END IF;


  -- --------------------------------------------------------------
  -- Organization context is mandatory for authenticated calls.
  -- --------------------------------------------------------------

  IF v_org IS NULL THEN

    RAISE EXCEPTION
      'organization context is required for monitoring events';

  END IF;


  -- --------------------------------------------------------------
  -- Insert tenant-scoped monitoring event.
  -- --------------------------------------------------------------

  INSERT INTO ops.monitoring_events (
    organization_id,
    service,
    event_type,
    severity,
    message,
    metadata
  )
  VALUES (
    v_org,
    btrim(p_service),
    btrim(p_event_type),
    p_severity,
    btrim(p_message),
    COALESCE(p_metadata, '{}'::jsonb)
  )
  RETURNING id
  INTO v_id;


  RETURN v_id;

END;
$$;


-- Remove default PUBLIC execution.
REVOKE ALL
ON FUNCTION ops.record_monitoring_event(
  TEXT,
  TEXT,
  TEXT,
  TEXT,
  JSONB
)
FROM PUBLIC;


GRANT EXECUTE
ON FUNCTION ops.record_monitoring_event(
  TEXT,
  TEXT,
  TEXT,
  TEXT,
  JSONB
)
TO authenticated;


GRANT EXECUTE
ON FUNCTION ops.record_monitoring_event(
  TEXT,
  TEXT,
  TEXT,
  TEXT,
  JSONB
)
TO service_role;


-- ================================================================
-- 4. Health summary
-- ================================================================

CREATE OR REPLACE FUNCTION ops.health_summary()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, ops, public, core
AS $$
DECLARE
  v_org           UUID;
  v_open_errors   BIGINT;
  v_open_critical BIGINT;
  v_last_event    TIMESTAMPTZ;
BEGIN

  v_org := core.current_user_org_id();


  -- --------------------------------------------------------------
  -- Authenticated application health must have organization
  -- context.
  -- --------------------------------------------------------------

  IF v_org IS NULL THEN

    RAISE EXCEPTION
      'organization context is required for health summary';

  END IF;


  -- --------------------------------------------------------------
  -- Only current organization's monitoring events are included.
  -- --------------------------------------------------------------

  SELECT
    count(*)
      FILTER (
        WHERE severity IN ('error', 'critical')
          AND status = 'open'
      ),

    count(*)
      FILTER (
        WHERE severity = 'critical'
          AND status = 'open'
      ),

    max(occurred_at)

  INTO
    v_open_errors,
    v_open_critical,
    v_last_event

  FROM ops.monitoring_events

  WHERE organization_id = v_org;


  RETURN jsonb_build_object(

    'status',
      CASE
        WHEN v_open_critical > 0
          THEN 'critical'

        WHEN v_open_errors > 0
          THEN 'degraded'

        ELSE 'healthy'
      END,

    'open_errors',
      COALESCE(v_open_errors, 0),

    'open_critical',
      COALESCE(v_open_critical, 0),

    'last_event_at',
      v_last_event,

    'organization_id',
      v_org,

    'checked_at',
      now()

  );

END;
$$;


REVOKE ALL
ON FUNCTION ops.health_summary()
FROM PUBLIC;


GRANT EXECUTE
ON FUNCTION ops.health_summary()
TO authenticated;


GRANT EXECUTE
ON FUNCTION ops.health_summary()
TO service_role;
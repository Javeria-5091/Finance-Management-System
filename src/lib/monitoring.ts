import 'server-only';
// AUD-P2-016: service-role monitoring is server-only.
import 'server-only';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export type MonitoringSeverity = 'info' | 'warning' | 'error' | 'critical';

function getServerSupabase(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

export async function recordMonitoringEvent(input: {
  service: string;
  eventType: string;
  severity: MonitoringSeverity;
  message: string;
  metadata?: Record<string, unknown>;
  organizationId?: string | null;
}) {
  try {
    const client = getServerSupabase();
    if (!client) return { ok: false, reason: 'monitoring credentials unavailable' };
    const { data, error } = await client.schema('ops').from('monitoring_events').insert({
      organization_id: input.organizationId ?? null,
      service: input.service,
      event_type: input.eventType,
      severity: input.severity,
      message: input.message,
      metadata: input.metadata ?? {},
    }).select('id').single();
    if (error) return { ok: false, reason: error.message };
    const webhook = process.env.MONITORING_ALERT_WEBHOOK_URL;
    if (webhook && (input.severity === 'error' || input.severity === 'critical')) {
      try { await fetch(webhook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...input, monitoring_event_id: data.id, occurred_at: new Date().toISOString() }), cache: 'no-store' }); } catch { /* alert delivery is fail-open */ }
    }
    return { ok: true, id: data.id };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'unknown monitoring error' };
  }
}

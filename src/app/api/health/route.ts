import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';

export async function GET() {
  const started = Date.now();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return NextResponse.json({ status: 'degraded', checks: { configuration: 'missing_server_credentials' } }, { status: 503 });
  try {
    const db = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
    const [{ error: dbError }, { data: health, error: healthError }] = await Promise.all([
      db.schema('finance').from('accounting_periods').select('id').limit(1),
      db.schema('ops').rpc('health_summary'),
    ]);
    const healthy = !dbError && !healthError && health?.status === 'healthy';
    return NextResponse.json({ status: healthy ? 'ok' : 'degraded', latency_ms: Date.now() - started, checks: { database: dbError ? 'failed' : 'ok', monitoring: healthError ? 'failed' : health?.status ?? 'unknown' }, monitoring: health ?? null }, { status: healthy ? 200 : 503 });
  } catch (error) {
    return NextResponse.json({ status: 'down', latency_ms: Date.now() - started, error: error instanceof Error ? error.message : 'health check failed' }, { status: 503 });
  }
}

const base = process.env.APP_BASE_URL || 'http://localhost:3000';
const webhook = process.env.MONITORING_ALERT_WEBHOOK_URL;

const response = await fetch(`${base.replace(/\/$/, '')}/api/health`, { cache: 'no-store' });
const payload = await response.json().catch(() => ({ status: 'unknown' }));

console.log(JSON.stringify({ checked_at: new Date().toISOString(), http_status: response.status, ...payload }));

if (!response.ok && webhook) {
  try {
    await fetch(webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'osystic-health-monitor', ...payload }),
    });
  } catch (error) {
    console.error('Monitoring webhook delivery failed:', error instanceof Error ? error.message : error);
  }
}

if (!response.ok) process.exitCode = 1;

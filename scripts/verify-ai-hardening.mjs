#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const checks = [
  ['AI response contract helper exists', fs.existsSync(path.join(root, 'src/lib/ai-response.ts'))],
  ['Chat uses central AI tool registry', read('src/app/api/chat/route.ts').includes('AI_TOOL_REGISTRY')],
  ['Org AI limit is organization-scoped', /from\('ai_user_cost_tracking'\)[\s\S]*?\.eq\('organization_id', orgId\)/.test(read('src/lib/api-auth.ts'))],
  ['Transaction suggestion confidence is numeric', /confidence:\s*suggestion\.confidence === 'high' \? 0\.95/.test(read('src/app/api/ai/transaction-coding/route.ts'))],
  ['Duplicate suggestion confidence is numeric', /confidence:\s*overallRisk === 'high' \? 0\.95/.test(read('src/app/api/ai/duplicate-detection/route.ts'))],
  ['Reconciliation suggestion confidence is numeric', /confidence:\s*suggestions\[0\]\?\.match_confidence/.test(read('src/app/api/ai/reconciliation-suggestions/route.ts'))],
  ['Document extraction uses schema columns', /file_id:\s*null[\s\S]*reviewer_id:\s*null/.test(read('src/app/api/ai/document-extraction/route.ts'))],
  ['Feedback no longer writes conversation_id', !read('src/app/api/ai/feedback/route.ts').includes('conversation_id: conversation_id')],
  ['AI audit tables have INSERT policies', /insert_own_ai_query_audit/.test(read('schema.sql')) && /insert_own_ai_tool_calls/.test(read('schema.sql'))],
  ['AI audit RPC pins user to auth.uid()', /p_user_id IS DISTINCT FROM v_auth_user/.test(read('schema.sql'))],
  ['Forwarded IP is not trusted', /ipAddress:\s*null/.test(read('src/lib/ai-cost-tracking.ts'))],
  ['AI routes return the shared response contract', fs.readdirSync(path.join(root, 'src/app/api/ai')).filter(d => fs.existsSync(path.join(root, 'src/app/api/ai', d, 'route.ts'))).filter(d => ['transaction-coding','duplicate-detection','reconciliation-suggestions','document-extraction','feedback','fiscal-close-assistant','tax-assistant','budget-cash-alerts','policy-qa','report-narrative'].includes(d)).every(d => read(`src/app/api/ai/${d}/route.ts`).includes('buildAiResponse'))],
];
let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failed++;
}
if (failed) process.exit(1);
console.log(`\nAll ${checks.length} AI hardening checks passed.`);

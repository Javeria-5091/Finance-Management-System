// =============================================================================
// OSYSTIC Finance AI Gateway — Server-side permission-aware AI copilot
// Spec Reference: Section 9 (AI Finance Layer)
// =============================================================================

import { createGroq } from '@ai-sdk/groq';
import { generateText } from 'ai';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { getAuthUser, isSqlSafe } from '@/lib/api-auth';
import { randomUUID } from 'crypto';

// ─── Model Setup ───
const groq = createGroq({
  apiKey: process.env.GROQ_API_KEY,
});

// =============================================================================
// CONTROLLED TOOL REGISTRY — Spec 9.4 AI tool registry
// AI can ONLY use these tools. Each maps to a specific approved capability.
// =============================================================================
const AI_TOOLS: Record<string, {
  description: string;
  permission: string;
  dbFunction?: string;
  priority: 'P0' | 'P1' | 'P2';
  riskLevel: 'low' | 'medium' | 'high';
  rowLimit: number;
  timeoutMs: number;
  requiresParams?: string[];
}> = {
  // ─── P0: Natural-language finance Q&A ───
  get_finance_metric: {
    description: 'Retrieve an approved KPI by period and filters (e.g. cash position, total receivables, total payables)',
    permission: 'REPORT_READ',
    priority: 'P0',
    riskLevel: 'low',
    rowLimit: 100,
    timeoutMs: 10000,
  },
  run_saved_report: {
    description: 'Execute an approved report definition (P&L, Balance Sheet, Cash Flow, Trial Balance, Aging, etc.)',
    permission: 'REPORT_READ',
    dbFunction: 'reporting.get_profit_and_loss', // placeholder — dynamically selected
    priority: 'P0',
    riskLevel: 'low',
    rowLimit: 500,
    timeoutMs: 15000,
  },

  // ─── P0: Report narrative ───
  cash_position: {
    description: 'Show reconciled bank, wallet and cash balances with PKR consolidated total',
    permission: 'BANK_READ',
    dbFunction: 'reporting.get_cash_position',
    priority: 'P0',
    riskLevel: 'low',
    rowLimit: 50,
    timeoutMs: 10000,
  },
  profit_and_loss: {
    description: 'Show Profit & Loss statement for a given period',
    permission: 'REPORT_READ',
    dbFunction: 'reporting.get_profit_and_loss',
    priority: 'P0',
    riskLevel: 'low',
    rowLimit: 200,
    timeoutMs: 15000,
  },
  balance_sheet: {
    description: 'Show Balance Sheet as of a date',
    permission: 'REPORT_READ',
    dbFunction: 'reporting.get_balance_sheet',
    priority: 'P0',
    riskLevel: 'low',
    rowLimit: 200,
    timeoutMs: 15000,
  },
  cash_flow: {
    description: 'Show Cash Flow statement',
    permission: 'REPORT_READ',
    dbFunction: 'reporting.get_cash_flow',
    priority: 'P0',
    riskLevel: 'low',
    rowLimit: 200,
    timeoutMs: 15000,
  },
  accounts_receivable: {
    description: 'Show AR aging report by client',
    permission: 'INVOICE_READ',
    dbFunction: 'reporting.get_aging_report',
    priority: 'P0',
    riskLevel: 'low',
    rowLimit: 200,
    timeoutMs: 10000,
  },
  project_profitability: {
    description: 'Show profitability for assigned projects only',
    permission: 'PROJECT_READ',
    dbFunction: 'reporting.get_project_profitability',
    priority: 'P0',
    riskLevel: 'low',
    rowLimit: 100,
    timeoutMs: 10000,
  },

  // ─── P1: Invoice/receipt extraction ───
  extract_finance_document: {
    description: 'Parse invoice/receipt/statement fields into a draft extraction record (draft only, user reviews)',
    permission: 'EXPENSE_READ',
    priority: 'P1',
    riskLevel: 'medium',
    rowLimit: 1,
    timeoutMs: 30000,
  },

  // ─── P1: Transaction categorization ───
  suggest_transaction_coding: {
    description: 'Recommend ledger account, project, vendor, tax code, and description for a transaction. Shows confidence. Requires human approval.',
    permission: 'JOURNAL_READ',
    priority: 'P1',
    riskLevel: 'medium',
    rowLimit: 10,
    timeoutMs: 10000,
  },

  // ─── P1: Duplicate/anomaly detection ───
  find_possible_duplicates: {
    description: 'Return likely duplicate expense/invoice records. No automatic merge or delete — flag only.',
    permission: 'EXPENSE_READ',
    priority: 'P1',
    riskLevel: 'low',
    rowLimit: 20,
    timeoutMs: 10000,
  },

  // ─── P1: Reconciliation suggestion ───
  suggest_reconciliation_matches: {
    description: 'Rank bank-to-ledger candidate matches. User confirms match; no silent reconcile.',
    permission: 'BANK_RECONCILE',
    priority: 'P1',
    riskLevel: 'medium',
    rowLimit: 50,
    timeoutMs: 15000,
  },

  // ─── P1: Budget and cash alerts ───
  budget_status: {
    description: 'Show budget vs actual spending with variance explanation and upcoming obligations',
    permission: 'BUDGET_READ',
    priority: 'P1',
    riskLevel: 'low',
    rowLimit: 100,
    timeoutMs: 10000,
  },

  // ─── P1: Tax computation & reconciliation ───
  get_tax_computation_summary: {
    description: 'Retrieve approved/draft PBT, adjustments, taxable income, tax, credits, payable/refund, and filing status',
    permission: 'TAX_READ',
    dbFunction: 'reporting.get_tax_report',
    priority: 'P1',
    riskLevel: 'low',
    rowLimit: 100,
    timeoutMs: 15000,
  },
  explain_tax_reconciliation: {
    description: 'Explain ledger-to-tax adjustments and missing evidence in plain language. Read-only; no autonomous legal classification.',
    permission: 'TAX_READ',
    priority: 'P1',
    riskLevel: 'low',
    rowLimit: 50,
    timeoutMs: 10000,
  },
  prepare_tax_return_checklist: {
    description: 'Create an accountant review checklist from the tax computation and document register. Draft only.',
    permission: 'TAX_READ',
    priority: 'P1',
    riskLevel: 'low',
    rowLimit: 50,
    timeoutMs: 15000,
  },

  // ─── P1: FX and settlement assistant ───
  currency_position: {
    description: 'Show current foreign currency balances, approved rates, and consolidated PKR cash position',
    permission: 'BANK_READ',
    priority: 'P1',
    riskLevel: 'low',
    rowLimit: 50,
    timeoutMs: 10000,
  },

  // ─── P1: Policy/document Q&A ───
  search_finance_policies: {
    description: 'Permission-aware retrieval and source references from approved finance policies and procedures',
    permission: 'REPORT_READ',
    priority: 'P1',
    riskLevel: 'low',
    rowLimit: 10,
    timeoutMs: 10000,
  },

  // ─── P2: Cash-flow forecasting ───
  forecast_cash_flow: {
    description: 'Generate scenario forecast from approved dataset. Separate from actuals; confidence and assumptions required.',
    permission: 'REPORT_READ',
    priority: 'P2',
    riskLevel: 'medium',
    rowLimit: 100,
    timeoutMs: 20000,
  },

  // ─── Employee own data ───
  my_expense_claims: {
    description: 'Show status of own expense claims only',
    permission: 'EXPENSE_READ',
    priority: 'P0',
    riskLevel: 'low',
    rowLimit: 50,
    timeoutMs: 10000,
  },
  expense_summary: {
    description: 'Show expense totals by category for current period',
    permission: 'EXPENSE_READ',
    priority: 'P1',
    riskLevel: 'low',
    rowLimit: 100,
    timeoutMs: 10000,
  },
  trial_balance: {
    description: 'Show trial balance for a given period',
    permission: 'GL_READ',
    priority: 'P0',
    riskLevel: 'low',
    rowLimit: 500,
    timeoutMs: 15000,
  },
  tax_summary: {
    description: 'Show tax computation summary for a tax year',
    permission: 'TAX_READ',
    dbFunction: 'reporting.get_tax_report',
    priority: 'P1',
    riskLevel: 'low',
    rowLimit: 100,
    timeoutMs: 10000,
  },
};

// =============================================================================
// BLOCKED ACTIONS — Spec 9.2 + Appendix B.3
// AI must ALWAYS refuse these. Logged as security events.
// =============================================================================
const BLOCKED_PATTERNS = [
  /pay\s+(this|the|all|pending|now|vendor)/i,
  /approve\s+(all|this|the|pending|these|expense|journal|invoice|payroll)/i,
  /delete\s+(this|the|all|posted|transaction|record)/i,
  /drop\s+table/i,
  /alter\s+table/i,
  /alter\s+user/i,
  /update\s+.*\s+set/i,
  /insert\s+into/i,
  /grant\s+/i,
  /revoke\s+/i,
  /truncate\s+/i,
  /ignore\s+(your|all|the|previous|these)\s+(rules|restrictions|permissions|security|instructions)/i,
  /show\s+(me\s+)?(all\s+)?(salaries?|wages?|compensation|bank\s+details?|passwords?|secret|api\.?key|credential|token)/i,
  /change\s+(owner|percentage|reserve|role|permission)\s+/i,
  /reopen\s+(last\s+month|the\s+period|closed)/i,
  /calculate\s+distributable\s+profit\s+using\s+only/i,
  /run\s+(this|the)\s*(UPDATE|DROP|DELETE|INSERT|ALTER)/i,
  /show\s+me\s+salaries/i,
  /show\s+me\s+bank\s+details/i,
  /reveal\s+(system\s+prompt|hidden\s+instructions|other\s+projects?)/i,
  /expose\s+(system\s+prompt|hidden\s+instructions)/i,
  /what\s+are\s+your\s+(rules|instructions|restrictions|system\s+prompt)/i,
];

function isBlocked(prompt: string): { blocked: boolean; reason: string } {
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(prompt)) {
      return {
        blocked: true,
        reason: 'This request requires a controlled application workflow, not AI assistance. Please use the appropriate screen in the system.',
      };
    }
  }
  return { blocked: false, reason: '' };
}

// =============================================================================
// ROLE-BASED DATA SCOPE — Spec 9.4, Appendix B.1
// What each role can ask about through AI
// =============================================================================
const ROLE_SCOPE: Record<string, string[]> = {
  CEO: [
    'get_finance_metric', 'run_saved_report', 'cash_position', 'profit_and_loss',
    'balance_sheet', 'cash_flow', 'accounts_receivable', 'project_profitability',
    'budget_status', 'forecast_cash_flow', 'get_tax_computation_summary',
    'explain_tax_reconciliation', 'prepare_tax_return_checklist',
    'currency_position', 'search_finance_policies', 'expense_summary',
    'trial_balance', 'tax_summary',
  ],
  FINANCE_HEAD: [
    'get_finance_metric', 'run_saved_report', 'cash_position', 'profit_and_loss',
    'balance_sheet', 'cash_flow', 'accounts_receivable', 'project_profitability',
    'budget_status', 'find_possible_duplicates', 'suggest_reconciliation_matches',
    'suggest_transaction_coding', 'get_tax_computation_summary',
    'explain_tax_reconciliation', 'prepare_tax_return_checklist',
    'currency_position', 'search_finance_policies', 'expense_summary',
    'trial_balance', 'tax_summary',
  ],
  ACCOUNTANT: [
    'get_finance_metric', 'run_saved_report', 'cash_position', 'profit_and_loss',
    'balance_sheet', 'cash_flow', 'accounts_receivable', 'project_profitability',
    'budget_status', 'find_possible_duplicates', 'suggest_reconciliation_matches',
    'suggest_transaction_coding', 'get_tax_computation_summary',
    'explain_tax_reconciliation', 'prepare_tax_return_checklist',
    'currency_position', 'search_finance_policies', 'expense_summary',
    'trial_balance', 'tax_summary',
  ],
  AUDITOR: [
    'get_finance_metric', 'run_saved_report', 'cash_position', 'profit_and_loss',
    'balance_sheet', 'cash_flow', 'trial_balance', 'tax_summary',
    'search_finance_policies',
  ],
  HOD: ['expense_summary', 'budget_status', 'project_profitability', 'my_expense_claims'],
  PROJECT_MANAGER: ['project_profitability', 'budget_status', 'expense_summary', 'my_expense_claims'],
  EMPLOYEE: ['my_expense_claims'],
  VIEWER: [],
  Admin: [
    'get_finance_metric', 'run_saved_report', 'cash_position', 'profit_and_loss',
    'balance_sheet', 'cash_flow', 'accounts_receivable', 'project_profitability',
    'budget_status', 'trial_balance', 'tax_summary', 'search_finance_policies',
  ],
};

// =============================================================================
// AI SYSTEM PROMPTS — Version-controlled, not hardcoded in LLM call
// =============================================================================
const SYSTEM_PROMPTS = {
  tool_selection: `You are the OSYSTIC Finance AI tool selector. Given a user's question and the list of available tools, select the MOST appropriate tool.

RULES:
1. You can ONLY select from the listed available tools.
2. If no tool matches, respond with {"tool": null, "reason": "explanation"}
3. Consider the user's role and question intent.
4. For tax questions, prefer tax-specific tools.
5. For cash/bank questions, prefer cash_position or currency_position.
6. Respond with ONLY a JSON object: {"tool": "tool_name"} or {"tool": null, "reason": "..."}`,

  finance_qa: `You are OSYSTIC Finance AI Assistant — a professional, permission-aware, READ-ONLY finance copilot.

OPERATING RULE (Spec 9):
AI is a permission-aware copilot. It may read approved data, extract documents, suggest classifications,
detect anomalies, forecast, summarize, and explain. It may NOT independently approve, post, pay, delete,
change permissions, reopen periods, or declare owner distributions.

RULES:
1. You can ONLY provide information available through the system's authorized reports and tools.
2. You can NEVER execute SQL, write data, approve, pay, delete, or modify records.
3. Always use PKR as the default currency. Show original currency when relevant.
4. Always mention the period, data source, and any filters applied.
5. If the user asks for salaries, bank details, passwords, or data outside their role scope, REFUSE and explain why.
6. Keep responses CONCISE and PROFESSIONAL.
7. If no data is found, say "No records found for the specified period."
8. NEVER present forecasts, classifications, or anomaly scores as confirmed facts — always include uncertainty and source context.
9. For tax questions, clearly state this is NOT professional tax advice.
10. Default to PKR and the active 1 July to 30 June fiscal year unless the user specifies otherwise.`,

  report_narrative: `You are a senior finance analyst at OSYSTIC. Present data PROFESSIONALLY.

FORMAT RULES:
1. Use PKR for all amounts — format as "PKR 1,20,000"
2. Use clean tables for multiple records
3. NEVER make assumptions — only state what data shows
4. If no data, say "No records found"
5. Keep it CONCISE but thorough
6. Always clarify the period, filters, and source of data
7. The user's role limits what they can see — respect this
8. If this is a project query, only show ASSIGNED projects
9. Numbers come from the authorized system report — state the report name.
10. Show confidence level when applicable.
11. Include warnings if data is incomplete, period is not closed, or values are estimated.`,
};

// =============================================================================
// HELPER: Get or create conversation
// =============================================================================
async function getOrCreateConversation(
  supabase: any,
  userId: string,
  orgId: string,
  conversationId: string | null
): Promise<{ conversationId: string; isNew: boolean }> {
  if (conversationId) {
    // Verify the conversation belongs to this user
    const { data } = await supabase
      .from('ai.ai_conversations')
      .select('id')
      .eq('id', conversationId)
      .eq('user_id', userId)
      .maybeSingle();
    if (data) return { conversationId: data.id, isNew: false };
  }

  // Create new conversation
  const { data } = await supabase
    .from('ai.ai_conversations')
    .insert({ user_id: userId, organization_id: orgId })
    .select('id')
    .single();
  return { conversationId: data.id, isNew: true };
}

// =============================================================================
// HELPER: Save message to ai_messages
// =============================================================================
async function saveMessage(
  supabase: any,
  conversationId: string,
  role: 'user' | 'assistant' | 'system',
  content: string,
  contentType: 'text' | 'json' | 'error' = 'text',
  classification?: string,
  metadata?: any
) {
  await supabase.from('ai.ai_messages').insert({
    conversation_id: conversationId,
    role,
    content,
    content_type: contentType,
    classification,
    metadata: metadata || {},
  });
}

// =============================================================================
// HELPER: Log tool call
// =============================================================================
async function logToolCall(
  supabase: any,
  messageId: string,
  conversationId: string,
  userId: string,
  orgId: string,
  toolName: string,
  inputParams: any,
  permissionCheck: 'passed' | 'denied' | 'skipped',
  userRole: string,
  status: 'success' | 'error' | 'timeout' | 'blocked',
  resultRows: number | null,
  latencyMs: number,
  model: string,
  errorMessage?: string
) {
  await supabase.from('ai.ai_tool_calls').insert({
    message_id: messageId,
    conversation_id: conversationId,
    user_id: userId,
    organization_id: orgId,
    tool_name: toolName,
    input_params: inputParams,
    permission_check: permissionCheck,
    user_role: userRole,
    status,
    result_rows: resultRows,
    latency_ms: latencyMs,
    model,
    error_message: errorMessage,
  });
}

// =============================================================================
// HELPER: Log query audit
// =============================================================================
async function logQueryAudit(
  supabase: any,
  toolCallId: string,
  conversationId: string,
  userId: string,
  orgId: string,
  question: string,
  normalizedIntent: string,
  toolOrReport: string,
  sqlOrParams: any,
  rowCount: number,
  timedOut: boolean,
  resultHash: string,
  status: string
) {
  await supabase.from('ai.ai_query_audit').insert({
    tool_call_id: toolCallId,
    conversation_id: conversationId,
    user_id: userId,
    organization_id: orgId,
    question,
    normalized_intent: normalizedIntent,
    tool_or_report: toolOrReport,
    sql_or_params: sqlOrParams,
    row_count: rowCount,
    timed_out: timedOut,
    result_hash: resultHash,
    status,
  });
}

// =============================================================================
// HELPER: Track user cost
// =============================================================================
async function trackUserCost(
  supabase: any,
  userId: string,
  orgId: string,
  tokensUsed: number
) {
  const today = new Date().toISOString().split('T')[0];
  const estimatedCost = (tokensUsed / 1000) * 0.000059; // approximate Groq cost

  try {
    // Try the RPC first
    const { error: rpcError } = await supabase.rpc('upsert_ai_user_cost', {
      p_user_id: userId,
      p_organization_id: orgId,
      p_period_date: today,
      p_request_count: 1,
      p_total_tokens: tokensUsed,
      p_estimated_cost: estimatedCost,
    });

    if (rpcError) throw rpcError;
  } catch (err) {
    // Fallback: Fetch existing record or insert/update manually
    try {
      const { data: existing } = await supabase
        .from('ai_user_cost_tracking') // adjust schema/table name if needed
        .select('request_count, total_tokens, estimated_cost')
        .eq('user_id', userId)
        .eq('organization_id', orgId)
        .eq('period_date', today)
        .single();

      if (existing) {
        // Update existing row with incremented values
        await supabase
          .from('ai_user_cost_tracking')
          .update({
            request_count: existing.request_count + 1,
            total_tokens: existing.total_tokens + tokensUsed,
            estimated_cost: existing.estimated_cost + estimatedCost,
          })
          .eq('user_id', userId)
          .eq('organization_id', orgId)
          .eq('period_date', today);
      } else {
        // Insert new row for today
        await supabase
          .from('ai_user_cost_tracking')
          .insert({
            user_id: userId,
            organization_id: orgId,
            period_date: today,
            request_count: 1,
            total_tokens: tokensUsed,
            estimated_cost: estimatedCost,
          });
      }
    } catch (fallbackErr) {
      console.error('Failed to track user cost:', fallbackErr);
    }
  }
}


// =============================================================================
// MAIN API HANDLER
// =============================================================================
export async function POST(req: Request) {
  const requestId = randomUUID();
  const startTime = Date.now();

  try {
    // ─── 1. AUTHENTICATE ───
    const auth = await getAuthUser();
    if (auth instanceof Response) {
      return new Response(JSON.stringify({
        answer: 'Authentication required. Please log in.',
        error: 'AUTH_REQUIRED',
      }), {
        status: 401,
        headers: { 'Content-Type': 'application/json', 'X-Request-Id': requestId },
      });
    }

    const body = await req.json();
    const { messages, conversation_id } = body;

    if (!messages || messages.length === 0) {
      return new Response(JSON.stringify({
        answer: 'No question provided.',
        error: 'NO_QUESTION',
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'X-Request-Id': requestId },
      });
    }

    const userQuestion = typeof messages[messages.length - 1].content === 'string'
      ? messages[messages.length - 1].content
      : '';

    // ─── 2. CHECK FOR BLOCKED ACTIONS (Spec 9.2) ───
    const blockCheck = isBlocked(userQuestion);
    if (blockCheck.blocked) {
      // Log the blocked attempt as security event
      const supabase = createServerClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        { cookies: { getAll: async () => (await cookies()).getAll(), setAll: () => {} } }
      );
      await supabase.from('audit.audit_log').insert({
        user_id: auth.userId,
        action: 'AI_BLOCKED',
        module: 'AI',
        details: JSON.stringify({
          request_id: requestId,
          prompt: userQuestion,
          reason: blockCheck.reason,
          timestamp: new Date().toISOString(),
        }),
      });

      return new Response(JSON.stringify({
        answer: blockCheck.reason,
        error: 'BLOCKED',
        warnings: ['This type of request is not permitted through AI.'],
      }), {
        headers: { 'Content-Type': 'application/json', 'X-Request-Id': requestId },
      });
    }

    // ─── 3. CHECK ROLE SCOPE (Spec 9.4) ───
    const allowedTools = ROLE_SCOPE[auth.role] || ROLE_SCOPE['VIEWER'];
    if (allowedTools.length === 0) {
      return new Response(JSON.stringify({
        answer: 'Your role does not have access to finance data through AI. Please contact your administrator.',
        error: 'NO_ACCESS',
      }), {
        headers: { 'Content-Type': 'application/json', 'X-Request-Id': requestId },
      });
    }

    // ─── 4. INITIALIZE CONVERSATION (Spec 9.9) ───
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { cookies: { getAll: async () => (await cookies()).getAll(), setAll: () => {} } }
    );

    const { conversationId, isNew } = await getOrCreateConversation(
      supabase, auth.userId, auth.orgId || '', conversation_id || null
    );

    // Save user message
    await saveMessage(supabase, conversationId, 'user', userQuestion, 'text', 'finance_qa');

    // ─── 5. TOOL SELECTION — LLM decides which tool, NOT which SQL ───
    const toolList = allowedTools
      .filter(key => AI_TOOLS[key]?.priority !== 'P2' || ['CEO', 'FINANCE_HEAD', 'ACCOUNTANT'].includes(auth.role))
      .map(key => `- ${key}: ${AI_TOOLS[key].description}`)
      .join('\n');

    const toolSelectionStart = Date.now();
    const toolSelection = await generateText({
      model: groq('llama-3.3-70b-versatile'),
      system: SYSTEM_PROMPTS.tool_selection,
      messages,
    });
    const toolSelectionLatency = Date.now() - toolSelectionStart;

    let selectedTool: string | null = null;
    let selectionReason = '';
    try {
      const parsed = JSON.parse(
        toolSelection.text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
      );
      selectedTool = parsed.tool;
      selectionReason = parsed.reason || '';
      if (selectedTool && !allowedTools.includes(selectedTool)) {
        selectedTool = null; // Not in user's scope — permission enforcement
      }
    } catch {}

    // ─── 6. GENERAL RESPONSE (no tool needed) ───
    if (!selectedTool) {
      const generalResult = await generateText({
        model: groq('llama-3.3-70b-versatile'),
        system: SYSTEM_PROMPTS.finance_qa,
        messages,
      });

      const assistantContent = generalResult.text;
      const msgResult = await supabase
        .from('ai.ai_messages')
        .insert({
          conversation_id: conversationId,
          role: 'assistant',
          content: assistantContent,
          content_type: 'text',
          classification: 'general',
          metadata: { request_id: requestId, model: 'llama-3.3-70b-versatile' },
        })
        .select('id')
        .single();

      return new Response(JSON.stringify({
        answer: assistantContent,
        tool: null,
        conversation_id: conversationId,
        confidence: selectionReason ? 'low' : 'medium',
        source_rows_or_report: null,
        data_as_of: new Date().toISOString(),
        request_id: requestId,
      }), {
        headers: { 'Content-Type': 'application/json', 'X-Request-Id': requestId },
      });
    }

    // ─── 7. EXECUTE TOOL via DB function (Spec 9.5 — NOT raw SQL) ───
    const toolDef = AI_TOOLS[selectedTool];
    let data: any = null;
    let toolStatus: 'success' | 'error' | 'timeout' | 'blocked' = 'success';
    let toolError = '';
    let resultRowCount: number | null = null;

    const toolExecStart = Date.now();

    if (toolDef.dbFunction) {
      // Timeout wrapper
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('TIMEOUT')), toolDef.timeoutMs)
      );

      try {
        const today = new Date().toISOString().split('T')[0];
        const result = await Promise.race([
          supabase.rpc(toolDef.dbFunction.replace('reporting.', ''), {
            p_start_date: `${new Date().getFullYear()}-07-01`,
            p_end_date: today,
            p_organization_id: auth.orgId,
            p_user_id: auth.userId,
          }),
          timeoutPromise,
        ]);
        if (result.error) throw new Error(result.error.message);
        data = result.data;
        resultRowCount = Array.isArray(data) ? Math.min(data.length, toolDef.rowLimit) : (data ? 1 : 0);
      } catch (err: any) {
        if (err.message === 'TIMEOUT') {
          toolStatus = 'timeout';
          toolError = `Query exceeded ${toolDef.timeoutMs / 1000}s timeout`;
        } else {
          toolStatus = 'error';
          toolError = err.message;
        }
      }
    }

    const toolExecLatency = Date.now() - toolExecStart;

    // ─── 8. GENERATE STRUCTURED RESPONSE (Spec 9.10 — AI response contract) ───
    const today = new Date().toISOString().split('T')[0];
    const fiscalYearStart = `${new Date().getFullYear()}-07-01`;

    let responseAnswer = '';
    let confidence: 'high' | 'medium' | 'low' = 'medium';
    let warnings: string[] = [];

    if (toolStatus === 'success' && data) {
      const explainResult = await generateText({
        model: groq('llama-3.3-70b-versatile'),
        system: SYSTEM_PROMPTS.report_narrative,
        messages: [
          {
            role: 'user',
            content: `Question: ${userQuestion}\n\nTool: ${selectedTool}\nDescription: ${toolDef.description}\n\nData: ${JSON.stringify(data)}`,
          },
        ],
      });
      responseAnswer = explainResult.text;
      confidence = resultRowCount && resultRowCount > 0 ? 'high' : 'low';
    } else if (toolStatus === 'timeout') {
      responseAnswer = `The query took too long to complete. Please try a more specific question or a shorter time period.`;
      confidence = 'low';
      warnings.push('Query timed out — results may be incomplete');
    } else if (toolStatus === 'error') {
      responseAnswer = `I encountered an issue retrieving the data: ${toolError}. Please try again or contact support.`;
      confidence = 'low';
      warnings.push('Data retrieval error');
    } else {
      responseAnswer = 'No records found for the specified period and filters.';
      confidence = 'medium';
    }

    // ─── 9. BUILD AI RESPONSE CONTRACT (Spec 9.10) ───
    const aiResponse = {
      answer: responseAnswer,
      metric_or_report: selectedTool,
      period: { from: fiscalYearStart, to: today },
      currency: 'PKR',
      filters: [{ field: 'organization', value: auth.orgId }],
      data_as_of: new Date().toISOString(),
      confidence,
      warnings,
      source_rows_or_report: toolDef.dbFunction || selectedTool,
      suggested_safe_actions: [],
    };

    // ─── 10. PERSIST EVERYTHING (Spec 9.9) ───
    // Save assistant message
    const { data: assistantMsg } = await supabase
      .from('ai.ai_messages')
      .insert({
        conversation_id: conversationId,
        role: 'assistant',
        content: responseAnswer,
        content_type: 'text',
        classification: selectedTool,
        metadata: {
          request_id: requestId,
          tool: selectedTool,
          confidence,
          warnings,
          model: 'llama-3.3-70b-versatile',
        },
      })
      .select('id')
      .single();

    // Log tool call
    if (assistantMsg) {
      await logToolCall(
        supabase,
        assistantMsg.id,
        conversationId,
        auth.userId,
        auth.orgId || '',
        selectedTool,
        { question: userQuestion, period: { from: fiscalYearStart, to: today } },
        'passed',
        auth.role,
        toolStatus,
        resultRowCount,
        toolExecLatency,
        'llama-3.3-70b-versatile',
        toolError || undefined
      );

      // Log query audit
      await logQueryAudit(
        supabase,
        assistantMsg.id,
        conversationId,
        auth.userId,
        auth.orgId || '',
        userQuestion,
        selectedTool,  // normalized intent = tool name
        selectedTool,
        { period: { from: fiscalYearStart, to: today }, organization_id: auth.orgId },
        resultRowCount || 0,
        toolStatus === 'timeout',
        '',  // result hash — would need actual hashing in production
        toolStatus
      );
    }

    // Update conversation title if first message
    if (isNew) {
      const title = userQuestion.length > 80
        ? userQuestion.substring(0, 80) + '...'
        : userQuestion;
      await supabase
        .from('ai.ai_conversations')
        .update({ title })
        .eq('id', conversationId);
    }

    // Track cost (approximate)
    await trackUserCost(
      supabase,
      auth.userId,
      auth.orgId || '',
      500  // approximate total tokens for this request
    );

    // ─── 11. RETURN STRUCTURED RESPONSE ───
    return new Response(JSON.stringify({
      ...aiResponse,
      conversation_id: conversationId,
      request_id: requestId,
    }), {
      headers: { 'Content-Type': 'application/json', 'X-Request-Id': requestId },
    });

  } catch (error: any) {
    console.error('AI Gateway Error:', { requestId, error: error.message });

    // Log error to audit
    try {
      const supabase = createServerClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        { cookies: { getAll: async () => (await cookies()).getAll(), setAll: () => {} } }
      );
      await supabase.from('audit.audit_log').insert({
        action: 'AI_ERROR',
        module: 'AI',
        details: JSON.stringify({
          request_id: requestId,
          error: error.message,
          timestamp: new Date().toISOString(),
        }),
      });
    } catch {}

    return new Response(JSON.stringify({
      answer: 'I\'m experiencing a technical issue. Please try again in a moment.',
      error: 'AI_ERROR',
      request_id: requestId,
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'X-Request-Id': requestId },
    });
  }
}
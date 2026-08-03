import { createGroq } from '@ai-sdk/groq';
import { generateText } from 'ai';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { getAuthUser, isSqlSafe } from '@/lib/api-auth';

const groq = createGroq({
  apiKey: process.env.GROQ_API_KEY,
});

// ═════════════════════════════════════════════════════════════════════
// CONTROLLED TOOL REGISTRY — AI can ONLY use these read-only tools
// ═════════════════════════════════════════════════════════════════════
const AI_TOOLS: Record<string, { description: string; permission: string; dbFunction?: string }> = {
  cash_position: {
    description: 'Show reconciled bank, wallet and cash balances with PKR consolidated total',
    permission: 'BANK_READ',
    dbFunction: 'reporting.get_cash_position',
  },
  profit_and_loss: {
    description: 'Show Profit & Loss statement for a given period',
    permission: 'REPORT_READ',
    dbFunction: 'reporting.get_profit_and_loss',
  },
  balance_sheet: {
    description: 'Show Balance Sheet as of a date',
    permission: 'REPORT_READ',
    dbFunction: 'reporting.get_balance_sheet',
  },
  cash_flow: {
    description: 'Show Cash Flow statement',
    permission: 'REPORT_READ',
    dbFunction: 'reporting.get_cash_flow',
  },
  accounts_receivable: {
    description: 'Show AR aging report by client',
    permission: 'INVOICE_READ',
    dbFunction: 'reporting.get_aging_report',
  },
  project_profitability: {
    description: 'Show profitability for assigned projects only',
    permission: 'PROJECT_READ',
    dbFunction: 'reporting.get_project_profitability',
  },
  tax_summary: {
    description: 'Show tax computation summary for a tax year',
    permission: 'TAX_READ',
    dbFunction: 'reporting.get_tax_report',
  },
  expense_summary: {
    description: 'Show expense totals by category for current period',
    permission: 'EXPENSE_READ',
  },
  budget_status: {
    description: 'Show budget vs actual spending',
    permission: 'BUDGET_READ',
  },
  my_expense_claims: {
    description: 'Show status of own expense claims only',
    permission: 'EXPENSE_READ',
  },
};

// ═════════════════════════════════════════════════════════════════════
// BLOCKED ACTIONS — AI must ALWAYS refuse these
// ═════════════════════════════════════════════════════════════════════
const BLOCKED_PATTERNS = [
  /pay\s+(this|the|all|pending)/i,
  /approve\s+(all|this|the|pending|these)/i,
  /delete\s+(this|the|all|posted|transaction)/i,
  /drop\s+table/i,
  /alter\s+table/i,
  /update\s+.*set/i,
  /insert\s+into/i,
  /ignore\s+(your|all|the|previous|these)\s+(rules|restrictions|permissions|security)/i,
  /show\s+(me\s+)?(all\s+)?(salaries?|wages?|compensation|bank\s+details?|passwords?|secret|api.?key|credential)/i,
  /change\s+(owner|percentage|reserve|role|permission)/i,
  /reopen\s+(last\s+month|the\s+period|closed)/i,
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

// ═════════════════════════════════════════════════════════════════════
// ROLE-BASED DATA SCOPE — what each role can ask about
// ═════════════════════════════════════════════════════════════════════
const ROLE_SCOPE: Record<string, string[]> = {
  CEO: Object.keys(AI_TOOLS), // Full access
  FINANCE_HEAD: Object.keys(AI_TOOLS), // Full access
  ACCOUNTANT: ['cash_position', 'profit_and_loss', 'balance_sheet', 'cash_flow', 'accounts_receivable', 'project_profitability', 'tax_summary', 'expense_summary', 'budget_status'],
  HOD: ['expense_summary', 'budget_status', 'project_profitability'],
  PROJECT_MANAGER: ['project_profitability', 'budget_status', 'expense_summary'],
  EMPLOYEE: ['my_expense_claims'],
  VIEWER: [], // No finance data
};

export async function POST(req: Request) {
  try {
    // ─── 1. AUTHENTICATE ───
    const auth = await getAuthUser();
    if (auth instanceof Response) {
      return new Response(JSON.stringify({ answer: 'Authentication required. Please log in.' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const { messages } = await req.json();
    if (!messages || messages.length === 0) {
      return new Response(JSON.stringify({ answer: 'No question provided.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const userQuestion = messages[messages.length - 1].content;

    // ─── 2. CHECK FOR BLOCKED ACTIONS ───
    const blockCheck = isBlocked(userQuestion);
    if (blockCheck.blocked) {
      // Log the blocked attempt
      try {
        const supabase = createServerClient(
          process.env.NEXT_PUBLIC_SUPABASE_URL!,
          process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
          { cookies: { getAll: async () => (await cookies()).getAll(), setAll: () => {} } }
        );
        await supabase.from('audit.audit_log').insert({
          user_id: auth.userId,
          action: 'AI_BLOCKED',
          module: 'AI',
          details: JSON.stringify({ prompt: userQuestion, reason: blockCheck.reason }),
        });
      } catch {}
      return new Response(JSON.stringify({ answer: blockCheck.reason }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // ─── 3. CHECK ROLE SCOPE ───
    const allowedTools = ROLE_SCOPE[auth.role] || ROLE_SCOPE['VIEWER'];
    if (allowedTools.length === 0) {
      return new Response(JSON.stringify({ 
        answer: 'Your role does not have access to finance data through AI. Please contact your administrator.' 
      }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // ─── 4. TOOL SELECTION (LLM decides which tool, NOT which SQL) ───
    const toolList = allowedTools
      .map(key => `- ${key}: ${AI_TOOLS[key].description}`)
      .join('\n');

    const toolSelection = await generateText({
      model: groq('llama-3.3-70b-versatile'),
      system: `You are OSYSTIC Finance AI Assistant. You are a READ-ONLY assistant.

AVAILABLE TOOLS (you can ONLY use these):
${toolList}

RULES:
1. You can ONLY use the tools listed above.
2. You can NEVER execute SQL, write data, approve, pay, delete, or modify records.
3. If the user asks something not covered by these tools, explain that you cannot help with that specific request.
4. If the user asks for salaries, bank details, passwords, or data outside their role scope, REFUSE.
5. Always mention that values come from the authorized system reports.
6. Keep responses SHORT and PROFESSIONAL.
7. Use PKR for all amounts.

Respond with ONLY a JSON object: {"tool": "tool_name"} or {"tool": null, "general_response": "your text"}`,
      messages,
    });

    let selectedTool: string | null = null;
    try {
      const parsed = JSON.parse(toolSelection.text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim());
      selectedTool = parsed.tool;
      if (selectedTool && !allowedTools.includes(selectedTool)) {
        selectedTool = null; // Not in user's scope
      }
    } catch {}

    // ─── 5. GENERAL RESPONSE (no tool needed) ───
    if (!selectedTool) {
      const generalResult = await generateText({
        model: groq('llama-3.3-70b-versatile'),
        system: `You are OSYSTIC Finance Assistant — a professional READ-ONLY helper.
You can ONLY provide information available through the system's authorized reports.
You can NEVER execute writes, SQL, approvals, payments, or modifications.
Keep responses SHORT and PROFESSIONAL.
For finance questions you cannot answer, suggest using the appropriate dashboard screen.
Use PKR for all amounts.`,
        messages,
      });
      return new Response(JSON.stringify({ answer: generalResult.text, tool: null }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // ─── 6. EXECUTE TOOL via DB function (NOT raw SQL) ───
    const toolDef = AI_TOOLS[selectedTool];
    let data: any = null;

    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { cookies: { getAll: async () => (await cookies()).getAll(), setAll: () => {} } }
    );

    if (toolDef.dbFunction) {
      const today = new Date().toISOString().split('T')[0];
      const { data: result, error } = await supabase.rpc(toolDef.dbFunction.replace('reporting.', ''), {
        p_start_date: `${new Date().getFullYear()}-07-01`,
        p_end_date: today,
        p_organization_id: auth.orgId,
        p_user_id: auth.userId,
      });
      if (!error) data = result;
    }

    // ─── 7. GENERATE RESPONSE FROM TOOL DATA ───
    const explainResult = await generateText({
      model: groq('llama-3.3-70b-versatile'),
      system: `You are a senior finance analyst at OSYSTIC. Present data PROFESSIONALLY.

FORMAT RULES:
1. Use PKR for all amounts - format as "PKR 1,20,000"
2. Use clean tables for multiple records
3. NEVER make assumptions - only state what data shows
4. If no data, say "No records found"
5. Keep it CONCISE
6. Always clarify the period and source of data
7. The user's role is ${auth.role} — only show data appropriate for this role
8. If this is a project query, only show ASSIGNED projects

IMPORTANT: These values come from the authorized ${toolDef.description} report.`,
      messages: [
        {
          role: 'user',
          content: `Question: ${userQuestion}\n\nTool: ${selectedTool}\n\nData: ${JSON.stringify(data)}`,
        },
      ],
    });

    // ─── 8. LOG AI ACTIVITY ───
    try {
      await supabase.from('audit.audit_log').insert({
        user_id: auth.userId,
        action: 'AI_QUERY',
        module: 'AI',
        details: JSON.stringify({
          tool: selectedTool,
          question: userQuestion,
          role: auth.role,
          rowCount: Array.isArray(data) ? data.length : (data ? 1 : 0),
        }),
      });
    } catch {}

    return new Response(JSON.stringify({ answer: explainResult.text, tool: selectedTool }), {
      headers: { 'Content-Type': 'application/json' },
    });

  } catch (error: any) {
    console.error('Chat API Error:', error);
    return new Response(JSON.stringify({ 
      answer: 'I\'m experiencing a technical issue. Please try again in a moment.' 
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
import { createGroq } from '@ai-sdk/groq';
import { generateText } from 'ai';
import { createClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';
import { DATABASE_SCHEMA } from '@/lib/schema';

const groq = createGroq({
  apiKey: process.env.GROQ_API_KEY,
});

function needsDatabase(question: string): boolean {
  const dbKeywords = [
    'income', 'expense', 'budget', 'invoice', 'payment', 'project',
    'transaction', 'amount', 'total', 'sum', 'average', 'count',
    'how much', 'kitna', 'kitne', 'kaisa', 'report', 'analytics',
    'monthly', 'weekly', 'daily', 'this month', 'this week', 'today',
    'pending', 'paid', 'overdue', 'due', 'client', 'category',
    'finance', 'paisa', 'rupee', 'rs.', 'revenue', 'cost',
    'maheene', 'mahine', 'haftay', 'hafte', 'aaj', 'kal',
    'overbudget', 'zaida', 'kam', 'sab se', 'top', 'highest', 'lowest'
  ];
  
  const lowerQ = question.toLowerCase();
  return dbKeywords.some(kw => lowerQ.includes(kw));
}

export async function POST(req: Request) {
  try {
    const cookieStore = await cookies();

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        global: {
          headers: {
            Cookie: cookieStore.toString(),
          },
        },
      }
    );

    const { messages } = await req.json();
    const userQuestion = messages[messages.length - 1].content;

    // ─── GENERAL QUESTIONS ───
    if (!needsDatabase(userQuestion)) {
      const generalResult = await generateText({
        model: groq('llama-3.3-70b-versatile'),
        system: `You are OSYSTIC Finance Assistant - a professional corporate AI helper for OSYSTIC Finance Management System.
Keep responses SHORT and PROFESSIONAL.
You ONLY help with finance-related queries for the OSYSTIC system.
For non-finance questions, politely redirect to finance topics.`,
        messages,
      });

      return new Response(JSON.stringify({ answer: generalResult.text }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // ─── STEP 1: Generate SQL ───
    const sqlResult = await generateText({
      model: groq('llama-3.3-70b-versatile'),
      system: `You are a PostgreSQL expert for OSYSTIC Finance Management System.
Generate ONLY a valid SELECT query. No explanation, no markdown, no backticks.

Schema:
 ${DATABASE_SCHEMA}

Today: ${new Date().toISOString().split('T')[0]}

 CRITICAL RULES (MUST FOLLOW):
1. NEVER use = for text/string comparison. ALWAYS use ILIKE '%value%' for names, titles, categories
   - WRONG: WHERE name = 'website'
   - RIGHT: WHERE name ILIKE '%website%'
2. Use EXTRACT(MONTH FROM col) for month, EXTRACT(YEAR FROM col) for year
3. Use COALESCE(SUM(col), 0) to handle nulls in aggregations
4. For "overbudget": compare SUM(expenses.amount) > budgets.total_amount
5. For "highest/lowest budget": use ORDER BY budgets.total_amount DESC/ASC LIMIT 1
6. ALWAYS use LEFT JOIN to avoid missing data
7. For project expense totals: GROUP BY projects.id, projects.name
8. When user says "budget of X project", try BOTH:
   a) budgets.name ILIKE '%X%'
   b) JOIN projects WHERE projects.name ILIKE '%X%'
9. Keep queries simple and correct rather than complex and broken`,
      messages,
    });

    let sqlQuery = sqlResult.text
      .replace(/```sql\n?/g, '')
      .replace(/```\n?/g, '')
      .trim();

    sqlQuery = sqlQuery.replace(/^;+/, '').trim();

    if (!sqlQuery.toLowerCase().startsWith('select') && !sqlQuery.toLowerCase().startsWith('with')) {
      return new Response(JSON.stringify({ 
        answer: "I couldn't generate a valid query. Please try rephrasing your question." 
      }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    console.log(' Generated SQL:', sqlQuery);

    // ─── STEP 2: Execute SQL ───
    const { data, error } = await supabase.rpc('execute_sql_query', { 
      query_string: sqlQuery 
    });

    if (error) {
      console.error('SQL Error:', error.message);
      console.error('Failed SQL:', sqlQuery);
      
      // Retry once with simpler query
      const retryResult = await generateText({
        model: groq('llama-3.3-70b-versatile'),
        system: `The previous SQL query failed with error: "${error.message}"
Generate a SIMPLER correct SELECT query for:
"${userQuestion}"

Schema:
 ${DATABASE_SCHEMA}

MUST USE ILIKE for text comparison, NEVER use =
Return ONLY the SQL, nothing else`,
        messages: [],
      });

      const retrySql = retryResult.text.replace(/```sql\n?/g, '').replace(/```\n?/g, '').trim();
      console.log('Retry SQL:', retrySql);

      const retryExec = await supabase.rpc('execute_sql_query', { 
        query_string: retrySql 
      });

      if (retryExec.error) {
        console.error(' Retry also failed:', retryExec.error.message);
        return new Response(JSON.stringify({ 
          answer: "I couldn't process that specific query. Try asking in a simpler way, like:\n• 'Show all budgets'\n• 'Show total expenses per project'" 
        }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const explainResult = await generateText({
        model: groq('llama-3.3-70b-versatile'),
        system: `You are a senior finance analyst at OSYSTIC. Present data PROFESSIONALLY.

FORMAT RULES:
1. Use PKR for all amounts - format as "PKR 1,20,000"
2. Use clean tables for multiple records
3. NEVER make assumptions
4. If empty array, say "No records found"
5. Keep it CONCISE`,
        messages: [
          {
            role: 'user',
            content: `Question: ${userQuestion}\n\nData: ${JSON.stringify(retryExec.data)}`
          }
        ],
      });

      return new Response(JSON.stringify({ answer: explainResult.text }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    console.log(' Query Success, rows:', Array.isArray(data) ? data.length : 'unknown');

    // ─── STEP 3: Explain Results ───
    const explainResult = await generateText({
      model: groq('llama-3.3-70b-versatile'),
      system: `You are a senior finance analyst at OSYSTIC. Present data PROFESSIONALLY.

FORMAT RULES:
1. Use PKR for all amounts - format as "PKR 1,20,000" (Indian numbering system: 1,20,000 not 120,000)
2. Use clean tables for multiple records
3. Use bullet points for summaries
4. NEVER make assumptions - only state what data shows
5. If empty array, say "No records found for this query"
6. Keep it CONCISE - no fluff
7. Use professional business language

EXAMPLE FORMATS:

For single value:
┌─────────────────────────┐
│  Website Project Budget  │
├─────────────────────────┤
│  Total Budget: PKR 1,20,000 │
└─────────────────────────┘

For lists:
| Budget Name  | Total Amount  | Category   |
|--------------|---------------|------------|
| Website      | PKR 1,20,000  | Marketing  |
| Salaries     | PKR 2,00,000  | Operations |

For summaries:
• Total Budget: PKR 3,20,000
• Number of Budgets: 2`,
      messages: [
        {
          role: 'user',
          content: `Question: ${userQuestion}\n\nSQL: ${sqlQuery}\n\nData: ${JSON.stringify(data)}`
        }
      ],
    });

    return new Response(JSON.stringify({ answer: explainResult.text }), {
      headers: { 'Content-Type': 'application/json' },
    });

  } catch (error: any) {
    console.error("Chat API Error:", error);
    return new Response(JSON.stringify({ 
      answer: "I'm experiencing a technical issue. Please try again in a moment." 
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
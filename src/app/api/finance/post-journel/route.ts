import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/lib/api-auth';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

function db() {
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: { getAll: async () => (await cookies()).getAll(), setAll: () => {} } }
  );
}

// ═════════════════════════════════════════════════════════════════════
//  POST JOURNAL ENTRY — Calls DB posting engine, enforces server-side
//  ═════════════════════════════════════════════════════════════════════

export async function POST(req: NextRequest) {
  const supabase = db();

  // ─── 1. AUTHENTICATE ───
  const auth = await getAuthUser();
  if (auth instanceof NextResponse) return auth;

  // ─── 2. PERM CHECK ───
  if (auth.role !== 'CEO' && auth.role !== 'Admin') {
    const { data: perms } = await supabase.rpc('get_my_permissions');
    let hasPerm = false;
    if (perms) {
      if (!Array.isArray(perms) && typeof perms === 'object' && perms['JOURNAL_UPDATE'] === true) hasPerm = true;
      if (Array.isArray(perms) && perms.some((p: any) => (p.permission_code || p.code) === 'JOURNAL_UPDATE')) hasPerm = true;
    }
    if (!hasPerm) {
      return NextResponse.json({ error: 'Permission denied: JOURNAL_UPDATE required' }, { status: 403 });
    }
  }

  try {
    const { journalId } = await req.json();
    if (!journalId) {
      return NextResponse.json({ error: 'journalId required' }, { status: 400 });
    }

    // ─── 3. FETCH JOURNAL ───
    const { data: rawJournal, error: fetchErr } = await supabase
      .from('finance.journal_entries')
      .select('*, journal_lines:finance.journal_lines(*)')
      .eq('id', journalId)
      .single();

    if (fetchErr || !rawJournal) {
      return NextResponse.json({ error: 'Journal not found' }, { status: 404 });
    }

    // Cast to any to bypass Supabase nested-relation ParserError on generated types
    const journal = rawJournal as any;

    if (journal.status !== 'APPROVED') {
      return NextResponse.json({ error: 'Only APPROVED journals can be posted. Current: ' + journal.status }, { status: 400 });
    }

    // ─── 4. MAKER-CHECKER: creator cannot post ───
    if (journal.created_by === auth.userId) {
      return NextResponse.json({ error: 'Maker-checker: Creator cannot post. Another user must post.' }, { status: 403 });
    }

    // ─── 5. CHECK OPEN PERIOD ───
    const { data: period } = await supabase
      .from('finance.accounting_periods')
      .select('id')
      .eq('status', 'OPEN')
      .order('start_date', { ascending: false })
      .limit(1)
      .single();

    if (!period) {
      return NextResponse.json({ error: 'No OPEN accounting period found' }, { status: 400 });
    }

    // ─── 6. TRY DB POSTING ENGINE ───
    const { data: postResult, error: postErr } = await supabase.rpc('finance.post_journal_entry', {
      p_journal_id: journalId,
      p_posted_by: auth.userId,
    });

    if (postErr) {
      // CRITICAL: NEVER bypass the posting engine. If RPC fails, the journal
      // must NOT be marked POSTED because no GL entries would be created.
      // This prevents data corruption in Trial Balance, Balance Sheet, and P&L.
      console.error('GL Posting engine failed:', postErr.message);
      return NextResponse.json({ 
        error: 'Posting engine unavailable. Journal NOT posted. Contact system administrator.',
        details: postErr.message,
      }, { status: 500 });
    }

    // ─── 7. AUDIT LOG ───
    try {
      await supabase.from('audit.audit_log').insert({
        user_id: auth.userId,
        action: 'JOURNAL_POSTED',
        module: 'JOURNAL',
        record_id: journalId,
        details: JSON.stringify({ reference: journal.reference, total_debit: journal.total_debit }),
      });
    } catch {}

    return NextResponse.json({ 
      success: true, 
      message: `Journal ${journal.reference} posted to General Ledger`,
      reference: journal.reference,
    });

  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Internal server error' }, { status: 500 });
  }
}
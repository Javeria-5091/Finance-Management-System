// ═════════════════════════════════════════════════════════════════════
//  WORKFLOW HELPER — All status transitions go through server-side API
//  Ensures: auth, maker-checker, approval limits, audit logging
//  FIXED: Pass auth cookies for server-side calls, fix URL typo
// ═════════════════════════════════════════════════════════════════════

import { cookies } from 'next/headers';

export type WorkflowModule = 'expense' | 'income' | 'invoice' | 'vendor_bill' | 'journal_entry';
export type WorkflowAction = 'submit' | 'verify' | 'approve' | 'post' | 'reject' | 'reverse' | 'reopen' | 'issue' | 'cancel';

export async function callWorkflow(
  module: WorkflowModule,
  recordId: string,
  action: WorkflowAction,
  reason?: string
): Promise<{ success: boolean; status?: string; message?: string; error?: string }> {
  try {
    const cookieStore = await cookies();
    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || '';
    const res = await fetch(`${baseUrl}/api/finance/workflow`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': cookieStore.toString(),
      },
      body: JSON.stringify({ module, recordId, action, reason }),
    });
    return await res.json();
  } catch (err: any) {
    return { success: false, error: err.message || 'Network error' };
  }
}

// Specific helpers
export async function postJournal(journalId: string) {
  try {
    const cookieStore = await cookies();
    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || '';
    // FIXED: URL typo — actual file is post-journel (misspelled in route)
    const res = await fetch(`${baseUrl}/api/finance/post-journel`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': cookieStore.toString(),
      },
      body: JSON.stringify({ journalId }),
    });
    return await res.json();
  } catch (err: any) {
    return { success: false, error: err.message || 'Network error' };
  }
}

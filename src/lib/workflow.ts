// ═════════════════════════════════════════════════════════════════════
//  WORKFLOW HELPER — All status transitions go through server-side API
//  Ensures: auth, maker-checker, approval limits, audit logging
//  FIXED: Removed next/headers import — this file is used by client
//  components so it must not depend on server-only modules.
//  Browser automatically sends cookies on same-origin requests.
// ═════════════════════════════════════════════════════════════════════

export type WorkflowModule = 'expense' | 'income' | 'invoice' | 'vendor_bill' | 'journal_entry';
export type WorkflowAction = 'submit' | 'verify' | 'approve' | 'post' | 'reject' | 'reverse' | 'reopen' | 'issue' | 'cancel';

export async function callWorkflow(
  module: WorkflowModule,
  recordId: string,
  action: WorkflowAction,
  reason?: string
): Promise<{ success: boolean; status?: string; message?: string; error?: string }> {
  try {
    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || '';
    const res = await fetch(`${baseUrl}/api/finance/workflow`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ module, recordId, action, reason }),
      // credentials: 'same-origin' is the default — browser sends cookies
      // automatically for same-origin fetch requests, no manual Cookie header needed.
    });
    return await res.json();
  } catch (err: any) {
    return { success: false, error: err.message || 'Network error' };
  }
}

// Specific helpers
export async function postJournal(journalId: string) {
  try {
    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || '';
    // FIX Bug 8.2: URL was 'post-journel' (misspelled). Corrected to 'post-journal'.
    const res = await fetch(`${baseUrl}/api/finance/post-journal`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ journalId }),
    });
    return await res.json();
  } catch (err: any) {
    return { success: false, error: err.message || 'Network error' };
  }
}
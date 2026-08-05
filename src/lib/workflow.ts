// ═════════════════════════════════════════════════════════════════════
//  WORKFLOW HELPER — All status transitions go through server-side API
//  Ensures: auth, maker-checker, approval limits, audit logging
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
    const res = await fetch('/api/finance/workflow', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
    const res = await fetch('/api/finance/post-journal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ journalId }),
    });
    return await res.json();
  } catch (err: any) {
    return { success: false, error: err.message || 'Network error' };
  }
}
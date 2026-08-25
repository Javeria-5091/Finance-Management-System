import { NextRequest, NextResponse } from 'next/server';
import { requirePermission } from '@/lib/api-auth';
import { getAuthSupabase } from '@/lib/api-auth';
import { supabase } from '@/lib/supabase';

// P0: Private attachments with file hash duplicate detection + corrupted file rejection

function getData<T = any>(res: any): T | null {
  return res?.data ?? null;
}

const ALLOWED_MIME_TYPES = [
  'application/pdf',
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
  'text/csv', 'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
];
 
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
 
// PDF magic bytes: %PDF- (hex: 255044462D)
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2D];
 
// JPEG magic bytes: FF D8 FF
const JPEG_MAGIC = [0xFF, 0xD8, 0xFF];
 
// PNG magic bytes: 89 50 4E 47
const PNG_MAGIC = [0x89, 0x50, 0x4E, 0x47];
 
const FILE_SIGNATURES: Record<string, number[]> = {
  'application/pdf': PDF_MAGIC,
  'image/jpeg': JPEG_MAGIC,
  'image/png': PNG_MAGIC,
};
 
function validateFileSignature(base64Data: string, declaredMime: string): { valid: boolean; reason: string } {
  // Decode base64 to check magic bytes
  const binaryStr = atob(base64Data.split(',')[1] || base64Data);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < Math.min(binaryStr.length, 10); i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }
 
  const expected = FILE_SIGNATURES[declaredMime];
  if (!expected) return { valid: true, reason: '' }; // No signature check for this type
 
  for (let i = 0; i < expected.length; i++) {
    if (bytes[i] !== expected[i]) {
      return { valid: false, reason: `File content does not match declared type ${declaredMime}. File may be corrupted or incorrectly renamed.` };
    }
  }
  return { valid: true, reason: '' };
}
 
async function computeFileHash(base64Data: string): Promise<string> {
  const binaryStr = base64Data.includes(',') ? base64Data.split(',')[1] : base64Data;
  const bytes = new Uint8Array(atob(binaryStr).length);
  for (let i = 0; i < atob(binaryStr).length; i++) {
    bytes[i] = atob(binaryStr).charCodeAt(i);
  }
  const hashBuffer = await crypto.subtle.digest('SHA-256', bytes);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}
 
async function checkDuplicateHash(fileHash: string, orgId: string | null, client: any): Promise<boolean> {
  if (!orgId) return false;
  const { data } = await client
    .schema('finance').from('attachments')
    .select('id, file_name, entity_type, entity_id')
    .eq('file_hash', fileHash)
    .eq('organization_id', orgId)
    .limit(1);
  return (data && data.length > 0) || false;
}
 
export async function POST(req: NextRequest) {
  const auth = await requirePermission('EXPENSE_CREATE');
  if (auth instanceof NextResponse) return auth;
  const { supabase } = await getAuthSupabase(req);
 
  try {
    const body = await req.json();
    // BUG-008 FIX: organization ownership is always derived from the authenticated session.
    // Reject any legacy/client-supplied organization_id instead of trusting or persisting it.
    if (Object.prototype.hasOwnProperty.call(body, 'organization_id')) {
      return NextResponse.json({ error: 'organization_id must not be supplied by the client' }, { status: 400 });
    }
    const { action, entityId, entityType, fileName, fileType, fileSize, fileBase64 } = body;
 
    if (action === 'upload_url') {
      if (!fileName || !fileType || !entityId || !entityType) {
        return NextResponse.json({ error: 'fileName, fileType, entityId, entityType required' }, { status: 400 });
      }
 
      // Validate file type
      if (!ALLOWED_MIME_TYPES.includes(fileType)) {
        return NextResponse.json({ error: `File type ${fileType} not allowed. Allowed: PDF, images, CSV, Excel, Word` }, { status: 400 });
      }
 
      // Validate file size
      if (fileSize && fileSize > MAX_FILE_SIZE) {
        return NextResponse.json({ error: `File size ${fileSize} exceeds 10MB limit` }, { status: 400 });
      }
 
      // ─── P0 NEW: Corrupted file detection ───
      if (fileBase64 && FILE_SIGNATURES[fileType]) {
        const sigCheck = validateFileSignature(fileBase64, fileType);
        if (!sigCheck.valid) {
          // Audit the rejected file — FIX 8.1: Use audit.log_action() RPC, not direct insert.
          // The audit.audit_log table does not have 'module' or 'details' columns.
          try {
            await supabase.schema('audit').rpc('log_action', {
              p_user_id: auth.userId,
              p_action: 'ATTACHMENT_REJECTED_CORRUPT',
              p_entity_type: 'attachment',
              p_entity_id: entityId || 'unknown',
              p_description: `Corrupted file rejected: ${fileName} (${fileType}). ${sigCheck.reason}`,
              p_previous_status: null,
              p_new_status: 'REJECTED',
              p_source_module: 'attachment',
              p_severity: 'medium',
              p_new_values: { entityType, entityId, fileName, fileType, reason: sigCheck.reason },
            });
          } catch {}
          return NextResponse.json({ error: `File appears to be corrupted or not a valid ${fileType.split('/')[1].toUpperCase()}. ${sigCheck.reason}` }, { status: 400 });
        }
      }
 
      // ─── P0 NEW: Duplicate file hash detection ───
      let fileHash: string | null = null;
      if (fileBase64) {
        fileHash = await computeFileHash(fileBase64);
        const isDuplicate = await checkDuplicateHash(fileHash, auth.orgId, supabase);
        if (isDuplicate) {
          try {
            await supabase.schema('audit').rpc('log_action', {
              p_user_id: auth.userId,
              p_action: 'ATTACHMENT_REJECTED_DUPLICATE',
              p_entity_type: 'attachment',
              p_entity_id: entityId || 'unknown',
              p_description: `Duplicate file rejected: ${fileName} (hash: ${fileHash?.slice(0,12)}...)`,
              p_previous_status: null,
              p_new_status: 'REJECTED',
              p_source_module: 'attachment',
              p_severity: 'low',
              p_new_values: { entityType, entityId, fileName, fileHash },
            });
          } catch {}
          return NextResponse.json({ error: 'A file with identical content already exists. Duplicate attachment rejected.' }, { status: 409 });
        }
      }
 
      const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
      const storagePath = `finance/${entityType}/${entityId}/${Date.now()}_${safeName}`;
 
      const { data, error } = await supabase.storage
        .from('finance-attachments')
        .createSignedUploadUrl(storagePath, { upsert: false });
 
      if (error) {
        return NextResponse.json({ error: 'Failed to generate upload URL: ' + error.message }, { status: 500 });
      }
 
      // Audit log with file hash — FIX 8.1: Use audit.log_action() RPC
      try {
        await supabase.schema('audit').rpc('log_action', {
          p_user_id: auth.userId,
          p_action: 'ATTACHMENT_UPLOAD_INITIATED',
          p_entity_type: entityType,
          p_entity_id: entityId,
          p_description: `Upload initiated: ${safeName} (${fileType}) for ${entityType}/${entityId}`,
          p_previous_status: null,
          p_new_status: 'UPLOADING',
          p_source_module: 'attachment',
          p_severity: 'info',
          p_new_values: { fileName: safeName, fileType, path: storagePath, file_hash: fileHash },
        });
 
        // Store hash in attachments table if it exists
        if (fileHash) {
          await supabase.schema('finance').from('attachments').insert({
            entity_type: entityType,
            entity_id: entityId,
            file_name: safeName,
            file_type: fileType,
            file_hash: fileHash,
            uploaded_by: auth.userId,
            storage_path: storagePath,
            organization_id: auth.orgId,
          });
        }
      } catch {}
 
      return NextResponse.json({ uploadUrl: data.signedUrl, path: storagePath, token: data.token, fileHash });
    }
 
    if (action === 'download_url') {
      if (!entityId) {
        return NextResponse.json({ error: 'entityId required' }, { status: 400 });
      }

      // BUG-011 FIX (High): Before generating the signed URL, verify the
      // caller has access to the underlying entity. The entityId parameter
      // here is actually the storage_path (e.g. "finance/expense/<uuid>/<file>").
      // The previous implementation just generated a signed URL for any path
      // the caller supplied, with NO permission check — anyone authenticated
      // could download any attachment if they knew or guessed the storage
      // path (Spec 7.5: "An unauthorized user cannot open, enumerate, or
      // download a finance attachment through the UI, API, or any other
      // channel").
      //
      // Spec 7.2 also requires data-scope enforcement: an HOD with
      // department-scoped access should not be able to download an
      // attachment belonging to a different department's expense. The RLS
      // policy on finance.attachments enforces organization_id scoping
      // (every query below is scoped via the authenticated supabase client),
      // and the explicit entity_type check below enforces that the caller
      // has the matching read permission for the underlying entity.
      const attachment = getData(
        await supabase
          .schema('finance').from('attachments')
          .select('id, entity_type, entity_id, organization_id, file_name')
          .eq('storage_path', entityId)
          .maybeSingle()
      );

      if (!attachment) {
        // Either the attachment doesn't exist OR it doesn't belong to the
        // caller's organization (RLS filters it out). Either way, fail
        // closed with a 404 — do not leak whether the path exists.
        return NextResponse.json({ error: 'File not found or access denied' }, { status: 404 });
      }

      // Verify organization isolation (defense-in-depth on top of RLS).
      if (auth.orgId && attachment.organization_id && attachment.organization_id !== auth.orgId) {
        return NextResponse.json({ error: 'File not found or access denied' }, { status: 404 });
      }

      // Verify the caller has read permission for the underlying entity type.
      // Map entity_type -> required permission code.
      const ENTITY_PERM_MAP: Record<string, string> = {
        expense: 'EXPENSE_READ',
        income: 'INCOME_READ',
        invoice: 'INVOICE_READ',
        vendor_bill: 'VENDOR_BILL_READ',
        credit_note: 'INVOICE_READ',
        payment_receipt: 'PAYMENT_READ',
        payment_reversal: 'PAYMENT_READ',
        journal_entry: 'JOURNAL_READ',
        profit_distribution: 'EQUITY_READ',
        vendor: 'VENDOR_READ',
        client: 'CLIENT_READ',
        project: 'PROJECT_READ',
        budget: 'BUDGET_READ',
        bank_statement: 'BANK_READ',
        bank_transfer: 'BANK_READ',
        asset: 'ASSET_READ',
        payroll: 'PAYROLL_READ',
      };
      const requiredPerm = ENTITY_PERM_MAP[attachment.entity_type?.toLowerCase()] || `${attachment.entity_type?.toUpperCase()}_READ`;

      if (auth.role !== 'CEO') {
        const { data: perms } = await supabase.rpc('get_my_permissions');
        let hasPerm = false;
        if (perms) {
          if (!Array.isArray(perms) && typeof perms === 'object' && perms[requiredPerm] === true) hasPerm = true;
          if (Array.isArray(perms) && perms.some((p: any) => (p.permission_code || p.code) === requiredPerm)) hasPerm = true;
        }
        if (!hasPerm) {
          return NextResponse.json({ error: 'Permission denied: cannot download this attachment' }, { status: 403 });
        }
      }

      const { data, error } = await supabase.storage
        .from('finance-attachments')
        .createSignedUrl(entityId, 300);

      if (error) {
        return NextResponse.json({ error: 'File not found or access denied' }, { status: 404 });
      }

      try {
        await supabase.schema('audit').rpc('log_action', {
          p_user_id: auth.userId,
          p_action: 'ATTACHMENT_DOWNLOADED',
          p_entity_type: attachment.entity_type || 'attachment',
          p_entity_id: attachment.entity_id || attachment.id,
          p_description: `Attachment downloaded: ${attachment.file_name || entityId}`,
          p_previous_status: null,
          p_new_status: 'DOWNLOADED',
          p_source_module: 'attachment',
          p_severity: 'info',
          p_new_values: { path: entityId, file_name: attachment.file_name, entity_id: attachment.entity_id },
        });
      } catch {}

      return NextResponse.json({ downloadUrl: data.signedUrl });
    }
 
    return NextResponse.json({ error: 'Invalid action. Use upload_url or download_url.' }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
 
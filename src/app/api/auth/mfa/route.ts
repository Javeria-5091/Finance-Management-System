import { NextRequest, NextResponse } from 'next/server';
import { requirePermission, getAuthSupabase } from '@/lib/api-auth';
import { enforceMFA } from '@/lib/mfa-middleware';

// BUG-007 FIX: Removed `import { supabase } from '@/lib/supabase'` (client-side browser client).
// All Supabase operations now use the server-side client from getAuthSupabase(req).
// The browser client uses the anon key with no server-side session, bypassing RLS.

const ALLOWED_MIME_TYPES = [
  'application/pdf',
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
  'text/csv', 'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
];

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2D];
const JPEG_MAGIC = [0xFF, 0xD8, 0xFF];
const PNG_MAGIC = [0x89, 0x50, 0x4E, 0x47];

const FILE_SIGNATURES: Record<string, number[]> = {
  'application/pdf': PDF_MAGIC,
  'image/jpeg': JPEG_MAGIC,
  'image/png': PNG_MAGIC,
};

function validateFileSignature(base64Data: string, declaredMime: string): { valid: boolean; reason: string } {
  const binaryStr = atob(base64Data.split(',')[1] || base64Data);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < Math.min(binaryStr.length, 10); i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }
  const expected = FILE_SIGNATURES[declaredMime];
  if (!expected) return { valid: true, reason: '' };
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

// BUG-007 FIX: checkDuplicateHash now accepts server-side supabase client as parameter
// instead of using the module-level client-side supabase import.
async function checkDuplicateHash(
  serverSupabase: any,
  fileHash: string,
  orgId: string | null
): Promise<boolean> {
  if (!orgId) return false;
  const { data } = await serverSupabase
    .schema('finance')
    .from('attachments')
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
    const { action, entityId, entityType, fileName, fileType, fileSize, fileBase64 } = await req.json();

    if (action === 'upload_url') {
      if (!fileName || !fileType || !entityId || !entityType) {
        return NextResponse.json({ error: 'fileName, fileType, entityId, entityType required' }, { status: 400 });
      }

      if (!ALLOWED_MIME_TYPES.includes(fileType)) {
        return NextResponse.json({ error: `File type ${fileType} not allowed. Allowed: PDF, images, CSV, Excel, Word` }, { status: 400 });
      }

      if (fileSize && fileSize > MAX_FILE_SIZE) {
        return NextResponse.json({ error: `File size ${fileSize} exceeds 10MB limit` }, { status: 400 });
      }

      if (fileBase64 && FILE_SIGNATURES[fileType]) {
        const sigCheck = validateFileSignature(fileBase64, fileType);
        if (!sigCheck.valid) {
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

      let fileHash: string | null = null;
      if (fileBase64) {
        fileHash = await computeFileHash(fileBase64);
        // BUG-007 FIX: Pass server-side supabase to checkDuplicateHash
        const isDuplicate = await checkDuplicateHash(supabase, fileHash, auth.orgId);
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

        // BUG-007 FIX: Use server-side supabase with schema() instead of client-side supabase
        if (fileHash) {
          await supabase
            .schema('finance')
            .from('attachments')
            .insert({
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
          p_entity_type: 'attachment',
          p_entity_id: entityId,
          p_description: `Attachment downloaded: ${entityId}`,
          p_previous_status: null,
          p_new_status: 'DOWNLOADED',
          p_source_module: 'attachment',
          p_severity: 'info',
          p_new_values: { path: entityId },
        });
      } catch {}

      return NextResponse.json({ downloadUrl: data.signedUrl });
    }

    return NextResponse.json({ error: 'Invalid action. Use upload_url or download_url.' }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
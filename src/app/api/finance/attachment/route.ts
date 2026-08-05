import { NextRequest, NextResponse } from 'next/server';
import { requirePermission } from '@/lib/api-auth';
import { supabase } from '@/lib/supabase';

// P0: Private attachments with file hash duplicate detection + corrupted file rejection

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

async function checkDuplicateHash(fileHash: string, orgId: string | null): Promise<boolean> {
  if (!orgId) return false;
  const { data } = await supabase
    .from('finance.attachments')
    .select('id, file_name, entity_type, entity_id')
    .eq('file_hash', fileHash)
    .limit(1);
  return (data && data.length > 0) || false;
}

export async function POST(req: NextRequest) {
  const auth = await requirePermission('EXPENSE_CREATE');
  if (auth instanceof NextResponse) return auth;

  try {
    const { action, entityId, entityType, fileName, fileType, fileSize, fileBase64 } = await req.json();

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
          // Audit the rejected file
          try {
            await supabase.from('audit.audit_log').insert({
              user_id: auth.userId,
              action: 'ATTACHMENT_REJECTED_CORRUPT',
              module: 'ATTACHMENT',
              details: JSON.stringify({ entityType, entityId, fileName, fileType, reason: sigCheck.reason }),
            });
          } catch {}
          return NextResponse.json({ error: `File appears to be corrupted or not a valid ${fileType.split('/')[1].toUpperCase()}. ${sigCheck.reason}` }, { status: 400 });
        }
      }

      // ─── P0 NEW: Duplicate file hash detection ───
      let fileHash: string | null = null;
      if (fileBase64) {
        fileHash = await computeFileHash(fileBase64);
        const isDuplicate = await checkDuplicateHash(fileHash, auth.orgId);
        if (isDuplicate) {
          try {
            await supabase.from('audit.audit_log').insert({
              user_id: auth.userId,
              action: 'ATTACHMENT_REJECTED_DUPLICATE',
              module: 'ATTACHMENT',
              details: JSON.stringify({ entityType, entityId, fileName, fileHash }),
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

      // Audit log with file hash
      try {
        await supabase.from('audit.audit_log').insert({
          user_id: auth.userId,
          action: 'ATTACHMENT_UPLOAD_INITIATED',
          module: 'ATTACHMENT',
          details: JSON.stringify({ entityType, entityId, fileName: safeName, fileType, path: storagePath, file_hash: fileHash }),
        });

        // Store hash in attachments table if it exists
        if (fileHash) {
          await supabase.from('finance.attachments').insert({
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
        await supabase.from('audit.audit_log').insert({
          user_id: auth.userId,
          action: 'ATTACHMENT_DOWNLOADED',
          module: 'ATTACHMENT',
          details: JSON.stringify({ path: entityId }),
        });
      } catch {}

      return NextResponse.json({ downloadUrl: data.signedUrl });
    }

    return NextResponse.json({ error: 'Invalid action. Use upload_url or download_url.' }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

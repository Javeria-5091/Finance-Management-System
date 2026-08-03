import { NextRequest, NextResponse } from 'next/server';
import { requirePermission } from '@/lib/api-auth';
import { supabase } from '@/lib/supabase';

// ═══════════════════════════════════════════════════════════════════
// Attachment API — Signed URL generation with file-level auth
// P0: Private attachments must never expose bucket paths to browser
// ═══════════════════════════════════════════════════════════════════

// Allowed file types
const ALLOWED_MIME_TYPES = [
  'application/pdf',
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
  'text/csv', 'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
];

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

export async function POST(req: NextRequest) {
  // Auth check
  const auth = await requirePermission('EXPENSE_CREATE');
  if (auth instanceof NextResponse) return auth;

  try {
    const { action, entityId, entityType, fileName, fileType, fileSize } = await req.json();

    if (action === 'upload_url') {
      // Generate signed upload URL
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

      // Build storage path: {entityType}/{entityId}/{timestamp}_{fileName}
      const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
      const storagePath = `finance/${entityType}/${entityId}/${Date.now()}_${safeName}`;

      const { data, error } = await supabase.storage
        .from('finance-attachments')
        .createSignedUploadUrl(storagePath, {
          upsert: false,
        });

      if (error) {
        return NextResponse.json({ error: 'Failed to generate upload URL: ' + error.message }, { status: 500 });
      }

      // Log attachment intent
      try {
        await supabase.from('audit.audit_log').insert({
          user_id: auth.userId,
          action: 'ATTACHMENT_UPLOAD_INITIATED',
          module: 'ATTACHMENT',
          details: JSON.stringify({ entityType, entityId, fileName: safeName, fileType, path: storagePath }),
        });
      } catch {}

      return NextResponse.json({
        uploadUrl: data.signedUrl,
        path: storagePath,
        token: data.token,
      });
    }

    if (action === 'download_url') {
      // Generate signed download URL with expiry
      if (!entityId) {
        return NextResponse.json({ error: 'entityId required' }, { status: 400 });
      }

      const { data, error } = await supabase.storage
        .from('finance-attachments')
        .createSignedUrl(entityId, 300); // 5 min expiry

      if (error) {
        return NextResponse.json({ error: 'File not found or access denied' }, { status: 404 });
      }

      // Log download
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

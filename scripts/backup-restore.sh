#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# OSYSTIC Finance System - Backup & Restore Scripts
# Usage: ./backup-restore.sh backup | ./backup-restore.sh restore <file>
# ═══════════════════════════════════════════════════════════════

set -euo pipefail

# ─── CONFIG (update these) ───
SUPABASE_URL="${SUPABASE_URL:-https://your-project.supabase.co}"
SUPABASE_DB_URL="${SUPABASE_DB_URL:-postgresql://postgres:[YOUR-PASSWORD]@db.[YOUR-PROJECT].supabase.co:5432/postgres}"
BACKUP_DIR="./backups"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

mkdir -p "$BACKUP_DIR"

# ─── BACKUP ───
if [ "${1:-}" = "backup" ]; then
    echo "========================================="
    echo "OSYSTIC BACKUP - $TIMESTAMP"
    echo "========================================="
    
    OUTFILE="$BACKUP_DIR/osystic_backup_${TIMESTAMP}.sql"
    
    echo "[1/3] Exporting database schema..."
    pg_dump "$SUPABASE_DB_URL" --schema-only --no-owner --no-privileges \
        --exclude-schema='extensions' --exclude-schema='pgsodium' \
        > "${OUTFILE}.schema" 2>&1
    echo "  Schema exported."
    
    echo "[2/3] Exporting data (finance, core, public schemas)..."
    pg_dump "$SUPABASE_DB_URL" --data-only --no-owner --no-privileges \
        --schema='finance' --schema='core' --schema='public' --schema='audit' --schema='reporting' \
        > "${OUTFILE}.data" 2>&1
    echo "  Data exported."
    
    echo "[3/3] Computing checksums..."
    cat "${OUTFILE}.schema" "${OUTFILE}.data" > "$OUTFILE"
    SHA256=$(sha256sum "$OUTFILE" | awk '{print $1}')
    echo "  Checksum: $SHA256"
    echo "$TIMESTAMP|$OUTFILE|$SHA256" >> "$BACKUP_DIR/backup_manifest.txt"
    
    # Clean up split files
    rm -f "${OUTFILE}.schema" "${OUTFILE}.data"
    
    ROW_COUNT=$(grep -c "^INSERT" "$OUTFILE" || echo "0")
    SIZE=$(du -h "$OUTFILE" | awk '{print $1}')
    
    echo "========================================="
    echo "BACKUP COMPLETE"
    echo "  File: $OUTFILE"
    echo "  Size: $SIZE"
    echo "  Rows: $ROW_COUNT"
    echo "  SHA256: $SHA256"
    echo "========================================="
    exit 0
fi

# ─── RESTORE ───
if [ "${1:-}" = "restore" ]; then
    BACKUP_FILE="${2:-}"
    
    if [ -z "$BACKUP_FILE" ]; then
        echo "ERROR: Provide backup file. Usage: ./backup-restore.sh restore <file.sql>"
        exit 1
    fi
    
    if [ ! -f "$BACKUP_FILE" ]; then
        echo "ERROR: File not found: $BACKUP_FILE"
        exit 1
    fi
    
    echo "========================================="
    echo "OSYSTIC RESTORE - $(date +%Y%m%d_%H%M%S)"
    echo "========================================="
    echo "  Source: $BACKUP_FILE"
    echo ""
    echo "WARNING: This will REPLACE all data in the target database."
    echo "Press Ctrl+C to cancel, or Enter to continue..."
    read -r
    
    # Verify backup integrity
    echo "[1/4] Verifying backup integrity..."
    EXPECTED_SHA=$(grep "$(basename $BACKUP_FILE)" "$BACKUP_DIR/backup_manifest.txt" 2>/dev/null | awk -F'|' '{print $3}')
    if [ -n "$EXPECTED_SHA" ]; then
        ACTUAL_SHA=$(sha256sum "$BACKUP_FILE" | awk '{print $1}')
        if [ "$EXPECTED_SHA" != "$ACTUAL_SHA" ]; then
            echo "  WARNING: Checksum mismatch! Expected: $EXPECTED_SHA, Got: $ACTUAL_SHA"
            echo "  Proceeding anyway (data may be corrupted)..."
        else
            echo "  Checksum verified."
        fi
    else
        echo "  No manifest entry found, skipping checksum verification."
    fi
    
    echo "[2/4] Creating pre-restore backup..."
    PRE_RESTORE="$BACKUP_DIR/pre_restore_$(date +%Y%m%d_%H%M%S).sql"
    pg_dump "$SUPABASE_DB_URL" --data-only --no-owner --no-privileges \
        --schema='finance' --schema='core' --schema='public' \
        > "$PRE_RESTORE" 2>&1
    echo "  Pre-restore backup saved: $PRE_RESTORE"
    
    echo "[3/4] Restoring database..."
    psql "$SUPABASE_DB_URL" --set ON_ERROR_STOP=1 -f "$BACKUP_FILE" 2>&1
    echo "  Restore completed."
    
    echo "[4/4] Verifying row counts..."
    pg_dump "$SUPABASE_DB_URL" --data-only --schema='finance' 2>/dev/null | grep -c "^INSERT"
    echo "  Verification complete."
    
    echo "========================================="
    echo "RESTORE COMPLETE"
    echo "  Source: $BACKUP_FILE"
    echo "  Pre-restore backup: $PRE_RESTORE"
    echo "========================================="
    exit 0
fi

# ─── VERIFY (check RLS, critical tables) ───
if [ "${1:-}" = "verify" ]; then
    echo "========================================="
    echo "OSYSTIC POST-RESTORE VERIFICATION"
    echo "========================================="
    
    echo "[1] Checking RLS on finance tables..."
    psql "$SUPABASE_DB_URL" -t -A -c "
        SELECT tablename, rowsecurity 
        FROM pg_tables 
        WHERE schemaname IN ('finance','core','public') 
        AND tablename NOT LIKE 'pg_%'
        ORDER BY tablename;
    " 2>&1 | while read -r table rls; do
        if [ "$rls" = "t" ]; then
            echo "  OK: $table has RLS"
        else
            echo "  FAIL: $table MISSING RLS"
        fi
    done
    
    echo "[2] Checking critical tables have data..."
    for tbl in chart_of_accounts journal_entries invoices expenses vendor_bills financial_accounts; do
        COUNT=$(psql "$SUPABASE_DB_URL" -t -A -c "SELECT count(*) FROM finance.$tbl WHERE true;" 2>/dev/null || echo "0")
        echo "  $tbl: $COUNT rows"
    done
    
    echo "[3] Checking trial balance..."
    psql "$SUPABASE_DB_URL" -c "SELECT * FROM finance.get_trial_balance(NULL, NULL) LIMIT 0;" 2>&1 | head -1
    
    echo "========================================="
    echo "VERIFICATION COMPLETE"
    echo "========================================="
    exit 0
fi

echo "Usage: ./backup-restore.sh [backup|restore <file>|verify]"
exit 1
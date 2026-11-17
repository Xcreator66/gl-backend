#!/usr/bin/env bash
# Restore drill: proves a backup can actually be restored AND is internally consistent. Run monthly, and before the pilot starts.
# Restores into a brand-new scratch database on a NON-production Postgres, runs integrity.sql, prints row counts, drops it.
#   RESTORE_ADMIN_URL=postgres://user:pass@scratch-host:5432/postgres  ./restore-drill.sh [dump-file]
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${RESTORE_ADMIN_URL:?postgres URL (no ?query part) of a SCRATCH server, never production}"
[[ "$RESTORE_ADMIN_URL" != *\?* ]] || { echo "RESTORE_ADMIN_URL must not contain a query string" >&2; exit 2; }
[ "${RESTORE_ADMIN_URL}" != "${DATABASE_URL:-}" ] || { echo "refusing: RESTORE_ADMIN_URL equals DATABASE_URL" >&2; exit 2; }
DIR="${BACKUP_DIR:-/var/backups/greenloop}"
DUMP="${1:-$(ls -1t "$DIR"/greenloop-*.dump* 2>/dev/null | head -1)}"; [ -n "$DUMP" ] && [ -f "$DUMP" ] || { echo "no backup found in $DIR" >&2; exit 2; }
AGE_H=$(( ( $(date +%s) - $(stat -c %Y "$DUMP") ) / 3600 )); echo "Backup: $DUMP (${AGE_H}h old)"
[ "$AGE_H" -le 26 ] || echo "WARNING: newest backup is older than 26 hours; is the cron job running?"
WORK="$(mktemp -d)"; DB="greenloop_drill_$(date +%s)_$$"; TARGET="${RESTORE_ADMIN_URL%/*}/$DB"
cleanup() { psql "$RESTORE_ADMIN_URL" -qc "DROP DATABASE IF EXISTS $DB" >/dev/null 2>&1 || true; rm -rf "$WORK"; }; trap cleanup EXIT
if [[ "$DUMP" == *.gpg ]]; then gpg --batch --decrypt --output "$WORK/restore.dump" "$DUMP"; DUMP="$WORK/restore.dump"; fi
psql "$RESTORE_ADMIN_URL" -qc "CREATE DATABASE $DB"      # fails if it exists: cannot overwrite anything
psql "$TARGET" -qc "CREATE EXTENSION IF NOT EXISTS pgcrypto"
pg_restore --no-owner --no-privileges --exit-on-error --dbname="$TARGET" "$DUMP"
PROBLEMS="$(psql "$TARGET" -At -f "$HERE/integrity.sql")"
echo "Row counts:"; psql "$TARGET" -At -c "SELECT 'users', COUNT(*) FROM users UNION ALL SELECT 'collections', COUNT(*) FROM collections UNION ALL SELECT 'batches', COUNT(*) FROM batches UNION ALL SELECT 'ledger_entries', COUNT(*) FROM ledger_entries UNION ALL SELECT 'redemptions', COUNT(*) FROM redemptions"
if [ -n "$PROBLEMS" ]; then echo "RESTORE DRILL FAILED, integrity problems:"; echo "$PROBLEMS"; exit 1; fi
echo "RESTORE DRILL PASSED: backup restores and ledger/integrity checks are clean."

#!/usr/bin/env bash
# Daily logical backup (public schema), validated, optionally encrypted and copied off-site. Cron: 0 2 * * * /path/backup.sh
# The dump contains phone numbers and money records: ALWAYS encrypt before it leaves this machine (set BACKUP_GPG_RECIPIENT).
set -euo pipefail
: "${DATABASE_URL:?}"; DIR="${BACKUP_DIR:-/var/backups/greenloop}"; mkdir -p "$DIR"; umask 077
FILE="$DIR/greenloop-$(date +%F-%H%M).dump"
pg_dump --format=custom --schema=public --no-owner --file="$FILE" "$DATABASE_URL"
pg_restore --list "$FILE" > /dev/null                      # cheap proof the file is a readable archive
[ "$(stat -c %s "$FILE")" -gt 10000 ] || { echo "backup suspiciously small: $FILE" >&2; exit 1; }
if [ -n "${BACKUP_GPG_RECIPIENT:-}" ]; then gpg --batch --yes --trust-model always --encrypt --recipient "$BACKUP_GPG_RECIPIENT" --output "$FILE.gpg" "$FILE" && shred -u "$FILE" && FILE="$FILE.gpg"; fi
if [ -n "${BACKUP_RCLONE_REMOTE:-}" ]; then rclone copy "$FILE" "$BACKUP_RCLONE_REMOTE"; else echo "WARNING: no BACKUP_RCLONE_REMOTE set; backup exists only on this machine" >&2; fi
find "$DIR" -name 'greenloop-*.dump*' -mtime +14 -delete
echo "backup ok: $FILE"

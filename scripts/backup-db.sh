#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${MEDIA_AGENT_ROOT:-${1:-$(cd "$(dirname "$0")/.." && pwd)}}"
DATA_DIR="${DATA_DIR:-$ROOT_DIR/data}"
DB_PATH="${MEDIA_AGENT_DB_PATH:-$DATA_DIR/media-agent.db}"
BACKUP_DIR="${MEDIA_AGENT_BACKUP_DIR:-$DATA_DIR/backups}"
FEED_OUTPUT_PATH="${MEDIA_AGENT_FEED_OUTPUT_PATH:-$DATA_DIR/feed-output.jsonl}"
MAX_BACKUPS=14
USER_DATA_FILES=(
  "$DATA_DIR/config.md"
  "$DATA_DIR/curation-prompt.md"
  "$DATA_DIR/preferences-context.md"
  "$DATA_DIR/preference-insights.md"
)

mkdir -p "$BACKUP_DIR"

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_FILE="$BACKUP_DIR/media-agent-${TIMESTAMP}.db"

# Use SQLite's backup command for consistency (handles WAL mode)
sqlite3 "$DB_PATH" ".backup '$BACKUP_FILE'"

echo "[backup] Created $BACKUP_FILE ($(du -h "$BACKUP_FILE" | cut -f1))"

# Also backup JSONL
if [ -f "$FEED_OUTPUT_PATH" ]; then
  cp "$FEED_OUTPUT_PATH" "$BACKUP_DIR/feed-output-${TIMESTAMP}.jsonl"
  echo "[backup] Backed up feed-output.jsonl"
fi

for user_data_file in "${USER_DATA_FILES[@]}"; do
  if [ -f "$user_data_file" ]; then
    base_name=$(basename "$user_data_file" .md)
    cp "$user_data_file" "$BACKUP_DIR/${base_name}-${TIMESTAMP}.md"
    echo "[backup] Backed up ${base_name}.md"
  fi
done

# Prune old backups, keep last N
ls -t "$BACKUP_DIR"/media-agent-*.db 2>/dev/null | tail -n +$((MAX_BACKUPS + 1)) | xargs -r rm
ls -t "$BACKUP_DIR"/feed-output-*.jsonl 2>/dev/null | tail -n +$((MAX_BACKUPS + 1)) | xargs -r rm
for user_data_file in "${USER_DATA_FILES[@]}"; do
  base_name=$(basename "$user_data_file" .md)
  ls -t "$BACKUP_DIR"/"${base_name}"-*.md 2>/dev/null | tail -n +$((MAX_BACKUPS + 1)) | xargs -r rm
done

echo "[backup] Done. $(ls "$BACKUP_DIR"/media-agent-*.db 2>/dev/null | wc -l) backups retained."

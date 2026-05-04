#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="${1:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
BASE_REF="${2:-origin/main}"
TARGET_REF="${3:-HEAD}"
MAX_BYTES="${GIT_PUSH_MAX_BLOB_BYTES:-94371840}"

if ! git -C "$REPO_DIR" rev-parse --verify "$BASE_REF" >/dev/null 2>&1; then
  echo "WARNING: Skipping oversized-blob guard because ${BASE_REF} is missing" >&2
  exit 0
fi

if ! git -C "$REPO_DIR" rev-parse --verify "$TARGET_REF" >/dev/null 2>&1; then
  echo "ERROR: Cannot check push size because ${TARGET_REF} does not exist" >&2
  exit 1
fi

REPORT_FILE="$(mktemp)"
trap 'rm -f "$REPORT_FILE"' EXIT

if git -C "$REPO_DIR" rev-list --objects "${BASE_REF}..${TARGET_REF}" \
  | git -C "$REPO_DIR" cat-file --batch-check='%(objectname) %(objecttype) %(objectsize) %(rest)' \
  | awk -v limit="$MAX_BYTES" '
      $2 == "blob" && $3 > limit {
        path = $0
        sub(/^[^ ]+ [^ ]+ [^ ]+ /, "", path)
        if (path == $0 || path == "") {
          path = "(path unavailable)"
        }
        printf "  - %s (%.1f MiB, blob %s)\n", path, $3 / 1048576, $1
        found = 1
      }
      END {
        if (!found) {
          exit 1
        }
      }
    ' > "$REPORT_FILE"; then
  echo "ERROR: Refusing to push ${TARGET_REF} because it introduces blobs larger than ${MAX_BYTES} bytes relative to ${BASE_REF}." >&2
  cat "$REPORT_FILE" >&2
  echo "Remove those artifacts from commits or rewrite the offending history before pushing." >&2
  exit 1
fi

exit 0

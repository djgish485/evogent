#!/usr/bin/env bash
# Post-merge hook for evogent
# Installs deps but does NOT rebuild or restart.
# Writes a pending-restart flag that the app picks up
# and shows an "Update available" banner to the user.
# The app restarts (and rebuilds) when the user clicks Apply.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_DIR"

git_ops_lock_file() {
  local git_common_dir
  git_common_dir=$(git -C "$REPO_DIR" rev-parse --path-format=absolute --git-common-dir)
  printf '%s/evogent-git-ops.lock\n' "$git_common_dir"
}

run_git_with_lock() {
  local timeout_seconds="${MEDIA_AGENT_GIT_OPS_LOCK_TIMEOUT_SEC:-300}"
  local lock_file
  lock_file=$(git_ops_lock_file)
  mkdir -p "$(dirname "$lock_file")"
  flock -E 75 -w "$timeout_seconds" "$lock_file" git -C "$REPO_DIR" "$@"
}

json_file_commit_matches() {
  local file_path="$1"
  local commit_full="$2"

  node - "$file_path" "$commit_full" <<'NODE'
const fs = require('node:fs');

const [filePath, commitFull] = process.argv.slice(2);

try {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  process.exit(raw?.commitFull === commitFull ? 0 : 1);
} catch {
  process.exit(1);
}
NODE
}

restart_state_is_current_head_consumed() {
  local commit_full="$1"

  node - "data/restart-state.json" "$commit_full" <<'NODE'
const fs = require('node:fs');

const [filePath, commitFull] = process.argv.slice(2);

try {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const status = typeof raw?.status === 'string' ? raw.status : '';
  process.exit(raw?.commitFull === commitFull && (status === 'consumed' || status === 'applied') ? 0 : 1);
} catch {
  process.exit(1);
}
NODE
}

sync_installed_skills_from_library() {
  local base_ref
  base_ref=$(run_git_with_lock rev-parse --verify ORIG_HEAD 2>/dev/null || true)
  [ -n "$base_ref" ] || return 0

  local skill_name library_dir runtime_dir
  while IFS= read -r skill_name; do
    [ -n "$skill_name" ] || continue
    library_dir="skills-library/$skill_name"
    runtime_dir=".claude/skills/$skill_name"

    if [ ! -d "$library_dir" ] || [ ! -d "$runtime_dir" ] || [ ! -f "$runtime_dir/SKILL.md" ]; then
      continue
    fi

    cp -a "$library_dir/." "$runtime_dir/"
    echo "--- post-merge: synced installed skill $skill_name from skills-library ---"
  done < <(
    run_git_with_lock diff --name-only "$base_ref" HEAD -- skills-library/ 2>/dev/null \
      | sed -n 's#^skills-library/\([^/][^/]*\)/.*#\1#p' \
      | sort -u
  )
}

COMMIT=$(run_git_with_lock rev-parse --short HEAD 2>/dev/null || echo "unknown")
COMMIT_FULL=$(run_git_with_lock rev-parse HEAD 2>/dev/null || echo "unknown")

if restart_state_is_current_head_consumed "$COMMIT_FULL"; then
  if [ -f data/pending-restart.json ] && json_file_commit_matches "data/pending-restart.json" "$COMMIT_FULL"; then
    rm -f data/pending-restart.json
    echo "--- post-merge: cleared stale pending restart flag for current HEAD ---"
  fi

  echo "--- post-merge: current HEAD already consumed by running service; skipping pending restart flag ---"
  exit 0
fi

echo "--- post-merge: npm install ---"
npm install --prefer-offline 2>&1

sync_installed_skills_from_library

# Do NOT build here — building overwrites .next/ chunks while the app
# is serving them, causing ChunkLoadError for active users.
# The build happens on restart (Apply button).

# Write pending-restart flag
SUMMARY=$(run_git_with_lock log -1 --format='%s' 2>/dev/null || echo "Code update")
MERGED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
cat > data/pending-restart.json << EOF
{
  "commit": "$COMMIT",
  "commitFull": "$COMMIT_FULL",
  "summary": "$SUMMARY",
  "mergedAt": "$MERGED_AT",
  "pendingAt": "$MERGED_AT",
  "pendingSource": "post-merge-hook"
}
EOF

cat > data/restart-state.json << EOF
{
  "status": "pending",
  "commit": "$COMMIT",
  "commitFull": "$COMMIT_FULL",
  "summary": "$SUMMARY",
  "pendingSource": "post-merge-hook",
  "mergedAt": "$MERGED_AT",
  "pendingAt": "$MERGED_AT",
  "lastUpdatedAt": "$MERGED_AT"
}
EOF

echo "--- post-merge: pending restart flag written ---"

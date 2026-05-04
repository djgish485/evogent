#!/usr/bin/env bash
set -euo pipefail

WORKTREE_DIR="$(cd "$(dirname "$0")/.." && pwd)"

cd "$WORKTREE_DIR"
npx tsx scripts/browser-test-session.ts

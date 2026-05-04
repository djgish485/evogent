#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WORKTREE_BASE="${APP_DIR}-worktrees"

if [ ! -d /proc ]; then
  exit 0
fi

for proc_dir in /proc/[0-9]*; do
  pid="${proc_dir#/proc/}"

  if [ ! -r "$proc_dir/comm" ]; then
    continue
  fi

  comm="$(tr -d '\0' < "$proc_dir/comm" 2>/dev/null || true)"
  case "$comm" in
    node|nodejs)
      ;;
    *)
      continue
      ;;
  esac

  cwd="$(readlink "$proc_dir/cwd" 2>/dev/null || true)"
  if [ -z "$cwd" ]; then
    continue
  fi

  normalized_cwd="${cwd% (deleted)}"
  case "$normalized_cwd" in
    "$WORKTREE_BASE"/*)
      ;;
    *)
      continue
      ;;
  esac

  if [[ "$cwd" == *" (deleted)" ]] || [ ! -d "$normalized_cwd" ]; then
    echo "[cleanup-stale-worktree-processes] terminating stale node pid=$pid cwd=$cwd"
    kill "$pid" 2>/dev/null || true
  fi
done

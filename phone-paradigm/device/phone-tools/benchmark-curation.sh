#!/data/data/com.termux/files/usr/bin/bash
# Fail-closed tombstone for curator benchmarking on the production phone.
#
# The former harness restored only media-agent.db around live evogent-cycle.sh
# runs. A cycle also mutates JSONL audit streams, preference/config artifacts,
# provider sessions, scheduler/control-plane state, and the visible feed. That
# made an A/B pair neither isolated nor safely reversible.
set -u

cat >&2 <<'EOF'
[curation-bench] unavailable: refusing to mutate the production phone

A qualifying curator benchmark requires a separate private runtime clone with:
  - isolated SQLite, JSONL/audit, preference, config, and session state;
  - isolated server port, watcher, scheduler, and control-plane ownership;
  - no WebSocket or launcher-visible publication to the production feed;
  - exact cycle-bound candidate, selection, reason, and terminal-receipt deltas;
  - private review artifacts removed after explicit human/overseer scoring.

The current phone runtime does not yet provide that complete boundary. No
benchmark artifact or qualification receipt was written. Keep the configured
curator baseline; use the browse benchmarks for the current efficiency work.
A future isolated harness must emit only the versioned receipt task/kind pair
curator_full_v2/full_curation_snapshot; legacy task=curator rows are ineligible.
EOF
exit 75

#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
QUEUE_TOOL="$ROOT_DIR/phone-paradigm/device/phone-tools/durable_task_queue.py"
TEST_DIR=$(mktemp -d "${TMPDIR:-/tmp}/evogent-durable-queue.XXXXXX")
QUEUE_DIR="$TEST_DIR/queue"
trap 'rm -rf -- "$TEST_DIR"' EXIT

python3 "$QUEUE_TOOL" enqueue --root "$QUEUE_DIR" --kind discovery \
  --task-id sample --pkg example.app --name Example --source sample --now-ms 1000 \
  >/dev/null

CLAIM=$(python3 "$QUEUE_TOOL" claim --root "$QUEUE_DIR" --owner shell-test \
  --lease-ms 5000 --now-ms 1000)
LEASE=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["leasePath"])' <<<"$CLAIM")
test -f "$LEASE"
test ! -f "$QUEUE_DIR/sample.json"

RETRY=$(python3 "$QUEUE_TOOL" finish --root "$QUEUE_DIR" --lease "$LEASE" \
  --result retry --outcome simulated_failure --detail "shell retry proof" --now-ms 2000)
test "$(python3 -c 'import json,sys; print(json.load(sys.stdin)["action"])' <<<"$RETRY")" = retry
test -f "$QUEUE_DIR/sample.json"

EARLY=$(python3 "$QUEUE_TOOL" claim --root "$QUEUE_DIR" --owner too-early --now-ms 2001)
test "$EARLY" = "{}"

SECOND=$(python3 "$QUEUE_TOOL" claim --root "$QUEUE_DIR" --owner shell-test \
  --now-ms 302000)
SECOND_LEASE=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["leasePath"])' <<<"$SECOND")
python3 "$QUEUE_TOOL" finish --root "$QUEUE_DIR" --lease "$SECOND_LEASE" \
  --result ack --outcome discovery_fresh --detail "shell ack proof" --now-ms 303000 \
  >/dev/null

test -f "$QUEUE_DIR/.receipts/sample-final.json"
test ! -e "$SECOND_LEASE"

printf '%s\n' '{broken' > "$QUEUE_DIR/broken.json"
EMPTY=$(python3 "$QUEUE_TOOL" claim --root "$QUEUE_DIR" --owner quarantine-test \
  --now-ms 400000)
test "$EMPTY" = "{}"
test -f "$QUEUE_DIR/.quarantine/broken.json"
test -n "$(find "$QUEUE_DIR/.receipts" -name 'broken-*-quarantine.json' -print -quit)"

echo "phone durable task queue shell test: ok"

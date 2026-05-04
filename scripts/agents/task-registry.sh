#!/usr/bin/env bash

prune_task_registry_json() {
  local retained_terminal_count="${1:-50}"
  local live_statuses_json="${2:-[\"running\",\"needs-attention\"]}"
  local terminal_statuses_json="${3:-[\"done\",\"failed\"]}"

  jq \
    --argjson retainedTerminalCount "$retained_terminal_count" \
    --argjson liveStatuses "$live_statuses_json" \
    --argjson terminalStatuses "$terminal_statuses_json" \
    '
      def matches_status($statuses; $status):
        ($statuses | index($status)) != null;
      def recency_key($task):
        ($task.completedAt // $task.lastUpdatedAt // $task.startedAt // "");

      (if type == "array" then . else [] end) as $tasks
      | ($tasks | to_entries) as $entries
      | ($entries
          | map(select(matches_status($liveStatuses; (.value.status // ""))))
          | map(.key)) as $liveKeys
      | ($entries
          | map(select(matches_status($terminalStatuses; (.value.status // ""))))
          | sort_by(recency_key(.value), .key)
          | reverse
          | .[:($retainedTerminalCount | if . > 0 then . else 0 end)]
          | map(.key)) as $recentTerminalKeys
      | ($liveKeys + $recentTerminalKeys | unique) as $keepKeys
      | [ $entries[] | select(.key as $index | $keepKeys | index($index)) | .value ]
    '
}

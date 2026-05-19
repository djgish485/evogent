---
name: github-pr-watch
description: Watch GitHub pull requests that may need review or follow-up.
user-invocable: true
metadata:
  evogent:
    heartbeat-task: false
    feed-actions:
      - id: review-pr
        label: Review PR
        confirms: false
        requiresSelection: pullRequestUrl
      - id: open-in-browser
        label: Open in browser
        confirms: false
        externalLink: true
        requiresSelection: pullRequestUrl
---
# GitHub PR Watch

Use this skill when an OpenClaw-sourced feed card summarizes a pull request that may need attention.

## Feed Action Handlers

These handlers run when an OpenClaw session receives a message beginning with `Action: github-pr-watch.<action>` for a feed item. Use the payload JSON and the feed item id in that message as the source of truth.

### `github-pr-watch.review-pr`

Review the pull request from `payload.selection.pullRequestUrl`, `payload.url`, or the card text. Summarize review risk, merge blockers, and the next action. If browser access is available, inspect the PR page before responding.

### `github-pr-watch.open-in-browser`

Open the pull request URL from the payload in the active browser session. If the URL is missing, explain that the card lacks a pull request link instead of guessing.

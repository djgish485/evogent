---
name: daily-brief
description: Turn daily brief cards into focused follow-up work.
user-invocable: true
metadata:
  evogent:
    heartbeat-task: false
    feed-actions:
      - id: expand-brief
        label: Expand brief
        confirms: false
      - id: open-sources
        label: Open sources
        confirms: false
        externalLink: true
---
# Daily Brief

Use this skill when an OpenClaw-sourced feed card summarizes a daily brief or a multi-item digest.

## Feed Action Handlers

These handlers run when an OpenClaw session receives a message beginning with `Action: daily-brief.<action>` for a feed item. Use the payload JSON and the feed item id in that message as the source of truth.

### `daily-brief.expand-brief`

Expand the brief into a concise working note with the most important facts, uncertainty, and suggested next reading.

### `daily-brief.open-sources`

Open the source URLs represented by the card. Prefer explicit URLs in the payload, then URLs in the card text. If no source URLs exist, explain what is missing.

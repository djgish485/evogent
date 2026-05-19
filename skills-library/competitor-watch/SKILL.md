---
name: competitor-watch
description: Track competitor and market updates that deserve follow-up.
user-invocable: true
metadata:
  evogent:
    heartbeat-task: false
    feed-actions:
      - id: track-competitor
        label: Track competitor
        confirms: false
        requiresSelection: competitor
      - id: open-in-browser
        label: Open in browser
        confirms: false
        externalLink: true
---
# Competitor Watch

Use this skill when an OpenClaw-sourced feed card summarizes competitor, customer, or market activity.

## Feed Action Handlers

These handlers run when an OpenClaw session receives a message beginning with `Action: competitor-watch.<action>` for a feed item. Use the payload JSON and the feed item id in that message as the source of truth.

### `competitor-watch.track-competitor`

Add or update a lightweight competitor note from the card. Capture the competitor name, evidence URL, why it matters, and a suggested follow-up.

### `competitor-watch.open-in-browser`

Open the evidence URL from `payload.url` or the card metadata in the active browser session. If there is no URL, report that the card has no browser target.

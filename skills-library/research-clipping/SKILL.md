---
name: research-clipping
description: Capture and organize research clippings from feed cards.
user-invocable: true
metadata:
  evogent:
    heartbeat-task: false
    feed-actions:
      - id: save-clipping
        label: Save clipping
        confirms: false
      - id: open-in-browser
        label: Open in browser
        confirms: false
        externalLink: true
---
# Research Clipping

Use this skill when an OpenClaw-sourced feed card contains research, notes, or source material worth saving.

## Feed Action Handlers

These handlers run when an OpenClaw session receives a message beginning with `Action: research-clipping.<action>` for a feed item. Use the payload JSON and the feed item id in that message as the source of truth.

### `research-clipping.save-clipping`

Save the card as a research clipping. Preserve the title, URL, excerpt, and why it mattered. Add a short retrieval tag if the card provides one.

### `research-clipping.open-in-browser`

Open the card URL or best source URL in the active browser session. If the card has no URL, report that it cannot be opened directly.

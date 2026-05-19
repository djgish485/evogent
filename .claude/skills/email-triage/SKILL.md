---
name: email-triage
description: Triage important inbox updates surfaced as feed cards.
user-invocable: true
metadata:
  evogent:
    heartbeat-task: false
    feed-actions:
      - id: triage-all
        label: Triage all
        confirms: false
      - id: open-in-gmail
        label: Open in Gmail
        confirms: false
        externalLink: true
        requiresSelection: messageUrl
      - id: skip-sender
        label: Skip sender
        confirms: Will skip future emails from this sender?
        requiresSelection: senderDomain
---
# Email Triage

Use this skill when an OpenClaw-sourced feed card summarizes email that needs triage.

## Feed Action Handlers

These handlers run when an OpenClaw session receives a message beginning with `Action: email-triage.<action>` for a feed item. Use the payload JSON and the feed item id in that message as the source of truth.

### `email-triage.triage-all`

Triage the emails represented by the card. Identify what needs a reply, what can be archived, and what should become a follow-up task. If browser access is available, use the authenticated inbox session.

### `email-triage.open-in-gmail`

Open `payload.selection.messageUrl`, `payload.url`, or the best Gmail URL found in the card metadata. If no URL is present, say that the card is missing an openable message link.

### `email-triage.skip-sender`

Use `payload.selection.senderDomain` or the sender fields in the card to mark this sender as lower priority for future triage. Do not skip a sender if the domain is ambiguous.

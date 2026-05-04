---
name: push-notifications
description: Configure ntfy push notifications for chat replies and future app events.
user-invocable: true
metadata:
  evogent:
    heartbeat-task: false
    user-invocable: true
---

# Push Notifications

Use this skill to enable ntfy push notifications when the app emits supported events such as completed chat replies.

## Setup

Create `data/push-notifications.json` with your ntfy topic and event settings:

```json
{
  "enabled": true,
  "provider": "ntfy",
  "ntfy": {
    "topic": "your-topic",
    "server": "https://ntfy.sh",
    "priority": 3,
    "tags": ["chat"]
  },
  "events": {
    "chat_reply": {
      "enabled": true,
      "title": "Evogent reply ready",
      "suppressWhenForeground": true,
      "suppressWindowSeconds": 120
    }
  }
}
```

## Behavior

- `enabled`: global on/off switch for push delivery.
- `provider`: currently `ntfy`.
- `ntfy.topic`: required topic name.
- `events.chat_reply`: controls chat reply pushes and foreground suppression.

If the latest activity event is `foreground` within the configured suppression window, the app skips the push because the user is likely already active in the tab.

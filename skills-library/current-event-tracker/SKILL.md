---
name: current-event-tracker
description: Add, modify, and retire structured current event tracking in your curation prompt
user-invocable: true
metadata:
  evogent:
    heartbeat-task: false
    user-invocable: true
---

# Current Event Tracker

This skill enables structured tracking of current events in your feed. When a user wants to follow a developing situation (a war, policy debate, technology trend, etc.), this skill helps create a comprehensive tracking section in the curation prompt.

## When to Activate

Activate this skill when the user:
- Says they want to "follow", "track", or "monitor" a current event or developing situation
- Asks for more coverage of a specific ongoing topic
- Wants to set up structured monitoring similar to how news desks track stories

## How to Add a New Tracked Event

### Step 1: Research the Topic

Before proposing anything, research the topic thoroughly:

1. Search Twitter via Bird CLI for the topic to find:
   - Key expert accounts posting about it (look for analysts, journalists, OSINT accounts, domain experts)
   - Common search terms and hashtags
   - The current state of the situation
2. Search the web for background context

### Step 2: Build the Tracking Section

Generate a curation prompt section following this template:

```
[N]. **[Event Name]** — [one-line description of why this matters to the user]. [Current status summary]. Search for: `[search term 1]`, `[search term 2]`, `[search term 3]`, `[search term 4]`, `[search term 5]`. Monitor accounts: @account1, @account2, @account3, @account4, @account5. **Every curation cycle should include at least one original analysis item** synthesizing the latest [event] developments — what happened, why it matters, what the second-order effects are, and what to watch next.
```

Key elements:
- **Priority number** — based on user's stated interest level and existing tracked events
- **Search terms** — 4-6 specific, targeted search queries (not generic)
- **Monitor accounts** — 4-6 expert/OSINT accounts identified during research
- **Analysis requirement** — mandate at least one synthesis per cycle
- **Framing guidance** — what analytical angles matter for this event

### Step 3: Adjust Volume Rules

Read the current curation prompt's "Per-Cycle Volume & Balance" section. Adjust the volume caps based on how many events are tracked:

| Tracked Events | Tweets per event | Hard cap per event | Min non-event tweets |
|---------------|------------------|--------------------|----------------------|
| 1 | 4-5 | 5 | 6 |
| 2 | 3-4 | 4 | 5 |
| 3 | 2-3 | 3 | 5 |
| 4+ | 2 | 2 | 4 |

Update the MANDATORY ORDERING rule to list all tracked events:
"Gather non-[event] content FIRST. Search for and select [N] tweets across diverse non-event topics before searching for any tracked event content."

### Step 4: Update tracked-events.json

After the user accepts the suggestion, update `data/tracked-events.json`:

```json
{
  "events": [
    {
      "id": "iran-war",
      "name": "Iran War / Middle East Conflict",
      "addedAt": "2026-03-01T00:00:00Z",
      "priority": 1,
      "status": "active",
      "searchTerms": ["Iran strikes", "CENTCOM Iran", "Iran nuclear", "Strait of Hormuz"],
      "monitorAccounts": ["@sentdefender", "@IntelCrab", "@War_Mapper", "@RALee85"],
      "tweetsPerCycle": "4-5",
      "hardCap": 5,
      "lastActivityAt": null,
      "notes": null
    }
  ],
  "updatedAt": "2026-03-01T00:00:00Z"
}
```

### Step 5: Propose as Suggestion

Write a `type: "suggestion"` item to `data/feed-output.jsonl` with:
- `metadata.suggestionType: "config_change"`
- `metadata.configFile: "data/curation-prompt.md"`
- `metadata.configField: "What I Care About"` (or the relevant section)
- `metadata.proposedValue`: the full updated section text
- Clear description of what's being added and why

## How to Modify a Tracked Event

When the user wants to adjust tracking:
- "Reduce Iran coverage" -> lower the volume cap, adjust priority
- "Add more accounts for Taiwan" -> research and add accounts
- "Iran seems to be cooling down" -> suggest reducing from active to monitoring

Always propose changes as suggestions — never edit the curation prompt directly.

## How to Retire a Tracked Event

When an event winds down:
- The reflection agent should notice when a tracked event hasn't produced quality content in 3+ cycles
- Propose reducing coverage or retiring the event
- Retirement = remove from curation prompt + mark as "retired" in tracked-events.json (don't delete, keep history)
- Adjust remaining events' volume caps upward

## Lifecycle Statuses

| Status | Meaning | Coverage |
|--------|---------|----------|
| `active` | Developing situation, high signal | Full tracking per volume rules |
| `monitoring` | Slower pace, still relevant | Reduced: 1-2 tweets/cycle, no mandatory analysis |
| `retired` | No longer actively tracked | Removed from curation prompt, kept in tracked-events.json for history |

## Integration with Reflection

The reflection agent should read `data/tracked-events.json` and:
- Check if active events are still producing quality content
- Suggest status changes (active -> monitoring -> retired) when appropriate
- Notice if the user's engagement with an event's content is declining
- Propose new events if user engagement signals suggest a new topic of interest

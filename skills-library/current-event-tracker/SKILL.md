---
name: current-event-tracker
description: Add, modify, and retire structured current-event tracking in the private curation model
user-invocable: true
metadata:
  evogent:
    heartbeat-task: false
    user-invocable: true
---

# Current Event Tracker

This skill adds a developing situation to the private curation model as a
retrieval and judgment lens. Tracking makes relevant evidence easier for the
runtime agent to find; it never creates a per-cycle output, source, item-type,
tweet, or analysis quota.

## When to Activate

Activate this skill when the user:

- wants to follow, track, or monitor a developing situation;
- asks for deeper coverage of an ongoing topic; or
- wants a structured set of search terms and useful sources for future runtime
  judgment.

## Add a Tracked Event

### 1. Research the topic

Use the phone's logged-in sources and web research when appropriate to identify:

- precise search terms and alternate names;
- people or organizations with direct knowledge;
- useful primary sources and domain experts;
- the current state and unresolved questions; and
- signals that would make a future update genuinely new or actionable.

Account choices, observed source yield, and the user's event priorities are
private deployment evidence. Keep them in ignored runtime data.

### 2. Build the tracking section

Use a source-neutral shape like:

```text
[N]. **[Event name]** — [why it matters]. Current question: [what remains
unclear]. Search for: [targeted terms]. Watch: [private source set]. When new
evidence changes the picture, judge whether a feed item, a synthesis, or no
shipment is most useful. Do not publish repetition merely to satisfy tracking.
```

The runtime agent decides whether anything is valuable enough to ship. An
analysis item is appropriate when synthesis adds understanding that the source
items do not provide on their own; it is never mandatory.

### 3. Preserve editorial judgment

- Do not set a minimum or maximum number of items for an event.
- Do not reserve slots or require a source or item type.
- Do not force non-event material for balance.
- Do not force an analysis item each cycle.
- Let every eligible candidate compete on current value and freshness within
  the global primary-slate ceiling.

### 4. Update private tracked-event state

After the user accepts the suggestion, update the ignored private
`data/tracked-events.json` state:

```json
{
  "events": [
    {
      "id": "example-event",
      "name": "Example Current Event",
      "addedAt": "<ISO timestamp>",
      "priority": 1,
      "status": "active",
      "searchTerms": ["example event update", "example event analysis"],
      "monitorAccounts": ["@example_source"],
      "lastActivityAt": null,
      "notes": null
    }
  ],
  "updatedAt": "<ISO timestamp>"
}
```

The file records private retrieval context, not shipment quotas.

### 5. Propose the change

Submit a `type: "suggestion"` item through
`POST $MEDIA_AGENT_INTERNAL_BASE_URL/api/internal/curate/submit` with:

- `metadata.suggestionType: "config_change"`
- `metadata.configFile: "data/curation-prompt.md"`
- `metadata.configField: "What I Care About"` or the relevant private section
- `metadata.proposedValue`: the complete updated section
- a plain explanation of what changed and why

The endpoint owns validation, deduplication, and the private audit receipt.

## Modify a Tracked Event

When the user wants a change:

- refine search terms when the event or vocabulary changes;
- replace weak sources with more direct or informative ones;
- change priority or status when the user's questions change; and
- preserve the event's stable ID so its private history remains coherent.

Propose changes as suggestions rather than silently changing the private
curation model.

## Retire a Tracked Event

When new evidence is no longer changing the picture, the event no longer serves
the user's goals, or the user asks to stop:

- propose reducing its priority, moving it to monitoring, or retiring it;
- remove retired retrieval instructions from the active curation prompt; and
- retain the private event record with `status: "retired"` rather than deleting
  its history.

No fixed number of quiet cycles decides retirement. The runtime agent judges
whether the situation is still producing useful information.

## Lifecycle Statuses

| Status | Meaning |
| --- | --- |
| `active` | Developing and currently valuable to examine |
| `monitoring` | Worth watching, but ship only meaningful changes |
| `retired` | No longer searched actively; retained in private history |

## Integration with Reflection

Reflection should use private runtime evidence to:

- judge whether tracking still produces useful, non-repetitive material;
- propose status, search-term, or source changes when the situation evolves;
- notice when the user's questions or engagement shift; and
- propose new tracking only when it serves a real current goal.

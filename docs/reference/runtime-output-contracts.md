# Runtime Output Contracts

This file holds the exact output shapes and examples referenced by `CLAUDE.md`.

## Feed Item Schema

Each feed line should match this shape:

```json
{
  "id": "ma-unique-id",
  "type": "tweet|article|analysis|suggestion|notification",
  "source": "twitter|publication-slug|claude",
  "sourceId": "stable-dedup-key",
  "parentId": null,
  "relationship": "parent|child|reply|analysis|related",
  "title": "optional title",
  "text": "main content",
  "url": "https://... or null",
  "excerpt": "optional short summary",
  "authorUsername": "optional",
  "authorDisplayName": "optional",
  "authorAvatarUrl": "optional",
  "reason": "why included (one sentence)",
  "tags": ["ai", "policy"],
  "mediaUrls": [],
  "publishedAt": "ISO-8601",
  "metadata": {
    "cycleId": "curate-...",
    "thread": {
      "threadId": "stable-thread-key",
      "threadTitle": "event-level title",
      "threadRationale": "why these items belong together",
      "prominence": {
        "level": "prominent|lead",
        "source": "homepage",
        "evidence": "optional source-evidence note",
        "homepageUrl": "optional homepage URL"
      }
    },
    "feedbackProbe": {
      "reason": "why this high-quality thread is being tested",
      "uncertainty": "what preference question the click should answer",
      "category": "source|topic|thread_shape|probe_behavior or another short label",
      "sourceItemIds": ["feed-item-id-1", "feed-item-id-2"],
      "options": {
        "moreLabel": "More like this",
        "lessLabel": "Less like this"
      }
    }
  }
}
```

Key rules:

- `type` should stay within `tweet`, `article`, `analysis`, `suggestion`, or `notification`.
- `sourceId` should stay stable per source item so dedup keeps working.
- Tweet `sourceId` should be the bare numeric tweet ID.
- `publishedAt` should be valid ISO-8601 and should not point into the future.
- For normal web `article` items, `publishedAt` is the source-owned publication time, not the curation or submit time. When a fetched page exposes `article:published_time`, JSON-LD `datePublished`, or equivalent source metadata, preserve it in `metadata.publishEvidence` and use the same instant for `publishedAt`. If no source publish time exists, set `metadata.publishEvidence.status` to `"unavailable"` or `"uncertain"` with a short reason rather than silently substituting curation time.
- `reason` should be present on every feed item.
- `article` items with a concrete source `url` should fetch that page, extract a verified absolute `og:image`, and place it in `mediaUrls` as `[ogImageUrl]` when available.
- `analysis` items should use `source: "claude"`, `authorUsername: "evogent"`, and `authorDisplayName: "Evogent"`.
- When an `analysis` item synthesizes specific feed items already in SQLite, set `relationship: "analysis"` and set `parentId` to the primary source feed item's `id` so presentation can inherit that source item's hero media.
- When an `analysis` item cites article or news URLs, choose one lead source URL and place at least that page's verified OG/social preview image URL in `mediaUrls`.
- When an `analysis` item cites reporting found via web search instead of an existing feed item, leave `parentId` empty unless you have a concrete feed parent and place verified OG/social preview image URLs from those cited pages in `mediaUrls`.
- `suggestion` and `notification` items should place machine-readable details in `metadata`.
- When source evidence supports visible homepage/front-page placement for an event, set `metadata.thread.prominence` to `{ "level": "prominent" | "lead", "source": "homepage", "evidence": "...", "homepageUrl": "..." }`. This emphasizes the thread title so the event stands out without enlarging every child card.
- For an accepted WSJ/NYT visually dominant lead-level thread, use direct story wording in `metadata.thread.threadTitle`, make `metadata.thread.threadRationale` one plain sentence about what happened, and set `metadata.thread.prominence.level` to `"lead"`.
- Use top-level `metadata.prominence` only for separate item-specific prominence where that individual story/card should receive larger card typography on its own.
- To test one borderline but high-quality thread, add `metadata.feedbackProbe` to one or more items in that thread. The UI will render large A/B buttons on the thread header and persist the click as structured thread feedback plus a preference-context signal. Use probes sparingly: at most one per curation cycle, only when the thread clears normal quality and thread-validity gates.

If JSONL fallback is required, append one compact JSON object per line and end each append with a newline.

## `text` Semantics By Feed Type

- `tweet`: `text` is the tweet's verbatim author-typed body, regardless of which capture path produced it. If a tweet has no visible body text and only contains media (image, video, or GIF), return `text` as an empty string. Do NOT describe the media, use accessibility alt text, generate a caption, transcribe, or summarize anything from the rendered media. Editorial framing belongs in `reason` or `excerpt`, not `text`.
- `tweet` retweets: prefer the original author's username, display name, avatar, text, and URL. Mention the retweeter in `reason` if that context matters.
- `article`: summarize the key points in 3-5 paragraphs instead of copying the full article.
- `article`: when `url` points to a fetched article page, verify the page's `og:image` metadata and store the resulting absolute image URL in `mediaUrls` when present.
- `analysis`: write original markdown and end with a `## Sources` section. Each source MUST be a markdown hyperlink: `[Source Title](https://url)`. Example: `- [NYT: Iran War Analysis](https://nytimes.com/...)`. Plain text citations without URLs are not acceptable.
- `analysis`: if it is anchored to an existing feed item, use that feed item's `id` in `parentId` and `relationship: "analysis"`, and still include at least the lead cited article's verified OG/social preview image in `mediaUrls` when the analysis references article URLs.
- `analysis`: if it is anchored only to web-found reporting, extract and verify the cited pages' OG/social preview image URLs and store them in `mediaUrls` on the analysis item itself.
- `suggestion`: keep the summary short and directional. Describe what should change, not the exact final wording.
- `notification`: use `text` for the user-visible status and `excerpt` for optional guidance or next steps.

Analysis example:

```md
## Why This Matters

The escalation risk is rising because regional actors are reacting to both military and energy-market signals.

## Sources
- [NYT: Iran War Analysis](https://www.nytimes.com/example)
- [Reuters: Oil Markets React to Regional Tensions](https://www.reuters.com/example)
```

Analysis linkage example:

```json
{
  "id": "ma-analysis-1",
  "type": "analysis",
  "source": "claude",
  "sourceId": "analysis-iran-risk-20260411",
  "parentId": "feed-db-id-of-primary-source",
  "relationship": "analysis",
  "title": "Why the escalation risk is broadening",
  "text": "## Why This Matters\n...\n\n## Sources\n- [Primary source](https://example.com/source)",
  "reason": "Connects the main reported development to second-order market and policy effects.",
  "mediaUrls": [
    "https://example.com/images/primary-og.jpg"
  ],
  "publishedAt": "2026-04-11T12:00:00Z"
}
```

Article media example:

```json
{
  "id": "ma-article-1",
  "type": "article",
  "source": "publication-slug",
  "sourceId": "story-20260411",
  "title": "Example article",
  "url": "https://example.com/story",
  "text": "Three to five paragraph summary...",
  "reason": "Adds a well-sourced reported development that matters to the user's tracked themes.",
  "mediaUrls": [
    "https://example.com/images/story-og.jpg"
  ],
  "publishedAt": "2026-04-11T11:30:00Z",
  "metadata": {
    "publishEvidence": {
      "status": "verified",
      "source": "article:published_time",
      "publishedAt": "2026-04-11T11:30:00Z"
    }
  }
}
```

Web-sourced analysis media example:

```json
{
  "id": "ma-analysis-2",
  "type": "analysis",
  "source": "claude",
  "sourceId": "analysis-web-roundup-20260411",
  "parentId": null,
  "relationship": null,
  "title": "What the latest reporting says",
  "text": "## Why This Matters\n...\n\n## Sources\n- [Reuters](https://www.reuters.com/example)\n- [AP News](https://apnews.com/example)",
  "reason": "Synthesizes the clearest reporting threads from current coverage.",
  "mediaUrls": [
    "https://www.reuters.com/resizer/example-og-image.jpg"
  ],
  "publishedAt": "2026-04-11T12:05:00Z"
}
```

## Suggestion Metadata

Use `type: "suggestion"` for user-confirmed change proposals.

- `metadata.suggestionType`: `"code_fix"`

For `code_fix`:

- `metadata.proposedValue`: description of what is broken, the impact, and any hard constraints
- `metadata.configFile`: optional; include `data/config.md` or `data/curation-prompt.md` when the approved fix should edit one of those files as part of a broader product/config change
- `metadata.taskId`: optional at creation time; approval flow generates it when dispatching the dev agent

Examples:

```json
{
  "suggestionType": "code_fix",
  "proposedValue": "Repeated upstream refresh failures leave coverage stale for multiple cycles and currently require manual recovery.",
  "configFile": "data/curation-prompt.md",
  "taskId": "auto-generated-slug"
}
```

`data/config.md` is for app settings. `data/curation-prompt.md` is for curation personality. Both are gitignored user-owned runtime files, so chat agents may directly apply explicit, concrete, safe personal edits such as changing `## Agent Name` to `Bob`; use `code_fix` for tracked source/docs/code and broader product behavior changes.

## Notification Metadata

Use `type: "notification"` for informational, warning, or error banners that should appear in the feed without accept/approve actions.

Suggested metadata fields:

- `metadata.notificationId`: stable dedup and resolve key
- `metadata.severity`: `"info"`, `"warning"`, or `"error"`; default `"info"`
- `metadata.dismissable`: boolean; default `true`
- `metadata.autoResolveCondition`: optional string describing when subsystems should clear it
- `metadata.expiresAt`: optional ISO-8601 timestamp for TTL-based expiry

Prefer stable `sourceId` and `metadata.notificationId` values so producers can `INSERT OR IGNORE` without recreating dismissed items.

## Feed Persistence

For tasks that create feed items, prefer `POST /api/internal/curate/submit` as the primary path. The endpoint validates items, dedups against SQLite, inserts accepted rows, appends the JSONL audit log, and broadcasts updates.

Prefer not to dedup by grepping `data/feed-output.jsonl`; the database is the source of truth and also has `UNIQUE(source_id)` as a safety net.

If the submit API is unavailable, appending valid single-line JSON objects to `data/feed-output.jsonl` is the last-resort fallback path.

### Existing Feed Row Enrichment

Use `PATCH /api/feed/<id>` when a task enriches an already persisted feed row. PATCH preserves the row identity, `sourceId`, origin session, parent/relationship links, dedup state, and broadcasts the updated item. It is the right path for adding richer article text, excerpts, media URLs, counters, or metadata to an existing row.

Do not use JSONL append to update existing rows. JSONL fallback can only describe new accepted items, and may be ignored as a duplicate when the same stable `sourceId` already exists.

When enriching article rows, preserve existing metadata and add focused fields such as `metadata.fullText` and `metadata.publishEvidence`. If the source page exposes a verified OG/social image, preserve current `mediaUrls` and append the absolute verified image URL when it is not already present.

### Curate Submit Payload

For curation runs, submit accepted feed items in `items`. Use `candidates` only for rejected items the worker considered but chose not to publish.

Candidate log entries are optional, but every included candidate must provide the same fields the API validator expects:

```json
{
  "cycleId": "curate-<timestamp>",
  "sourceId": "candidate-id",
  "authorUsername": "@candidate",
  "text": "candidate text or excerpt",
  "reason": "why considered",
  "rejectionReason": "why skipped",
  "metadata": { "rejectionScope": "source_quality" },
  "timestamp": "ISO-8601"
}
```

`cycleSummary` is optional but recommended for each curation run. It should report `considered`, `selected`, `rejected`, and `topRejectionReasons` for the same `cycleId`.

`cycleSummary.metadata` is optional when the worker needs to preserve extra structured evidence about the cycle, such as bounded source-recovery experiment results.

Use candidate `metadata.rejectionScope = "source_quality"` for non-editorial misses such as incomplete cached tweet text. Those entries should use a concrete `sourceQualityIssue`, for example `"twitter_text_incomplete"`, so reflection can separate source-recovery failures from real taste/content rejections.

## Chat Output Schema

Use `POST $MEDIA_AGENT_INTERNAL_BASE_URL/api/internal/chat/submit` for chat replies. The endpoint validates the payload, enforces per-task reply idempotency, persists the surviving message, appends the audit JSONL line, and triggers chat/feed side effects once.

`chat-output.jsonl` is an audit log only. In the default app layout that is `data/chat-output.jsonl`; isolated validation instances may override it via `DATA_DIR`. Appending to this file is not a delivery path and is not imported into SQLite.

```json
{
  "type": "chat",
  "id": "chat-unique-id",
  "role": "agent",
  "inReplyTo": "msg-id-if-provided",
  "text": "assistant response",
  "taskId": "MEDIA_AGENT_TASK_ID",
  "timestamp": "ISO-8601"
}
```

Key rules:

- Chat tasks should submit exactly one delivered chat reply.
- `role` should be `"agent"` for assistant replies.
- `ChatMessageId:` from the task should flow to `inReplyTo` when present.
- Include the current `MEDIA_AGENT_TASK_ID` as `taskId`.
- Replies should stay concise and actionable.
- Apply explicit, concrete, safe personal edits to gitignored `data/config.md` directly and summarize the changed section.
- Submit product/source/docs changes as separate `type: "suggestion"` feed items through `POST /api/internal/curate/submit`, always using `metadata.suggestionType: "code_fix"`.

Chat invocations are ephemeral processes with `--resume`; curation runs are separate processes without chat-history access.

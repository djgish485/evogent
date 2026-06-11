---
name: substack-cache
description: Direct-browse Substack source guidance for curation cycles using the shared browser session and policy JSON prompts.
user-invocable: true
metadata:
  media-agent:
    heartbeat-task: false
    feed-source: substack
    feed-source-label: Substack
---
# Substack Source

Install this skill when you want Substack to be an active direct-browse source.

## Behavior

- Curation reads this skill directly every cycle.
- Curation also reads `data/substack-cache-policy.json` directly every cycle.
- Read `data/curation-prompt.md` before building the fetch plan; it is soft input for what the user cares about, including optional long-tail topics worth using when judgment says they fit.
- The policy JSON is the editable source of truth for the full prompt, browsing tactics, and coverage expectations.
- When the policy JSON contains `refreshPrompt`, curation must follow it verbatim rather than summarizing it.
- Browse Substack directly in the shared authenticated browser session. Do not expect a cache query API to choose content for you.

## Curation Task

- Read the full curation plan plus the full prompt from `data/substack-cache-policy.json`.
- Visit every required source in order: planned publication pages first, then inbox when present.
- Stay inside the shared authenticated browser session. Do not spawn another agent and do not use repo-specific browser scripts.
- Capture the strongest raw candidates in your scratchpad, then submit only the posts that clear the editorial bar.
- Preserve canonical URLs, publication identity, visible publish times, and verified images in submitted metadata.
- Every cached item's `payload` must include `imageUrl`: the post's `og:image`, cover image, or first in-article hero image as an absolute URL. Favicon- or icon-scale images (anything roughly 200px wide or smaller) do not count as the article image. If the post genuinely exposes no usable image, set `imageUrl: null` and note it in extraction diagnostics — the feed card shows this image, so silently omitting it produces image-less cards.

## Cacher Mode

- Cacher Mode uses the same publication pages, inbox surfaces, prompts, selectors, and extracted fields as Curation Task.
- The cached `payload` must match the direct-browse field shape curation expects from this skill.
- Persist items through `/api/internal/browse-cache/submit` with source `substack`.
- Default cadence: every 60 minutes.
- Auth/session requirement is unchanged: use the same shared browser session when the source requires it.

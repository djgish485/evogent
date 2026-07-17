# track-interest — turn a standing interest into a real source pull

Use this when a chat/user-ping message expresses an ONGOING interest to keep up with — not a
one-off question. Triggers: "keep me updated on…", "follow…", "track…", "let me know when/about…",
"notify me about…", "stay on top of…", "watch…", or any request to be kept current on a
person/place/team/product/topic over time. (A one-off "what's happening at X this weekend" is a
normal chat answer, not an interest — only persist when the user wants CONTINUOUS updates.)

This is fully general: it works for any entity and any user. Nothing about specific venues or
topics is hardcoded — you research the sources and write a record; the cycle's `browse-interests.py`
pulls those sources every run and the curator/floor surface what's timely.

## Steps

1. **Parse the interest.** Pull out the distinct ENTITIES to follow (each venue, person, team,
   product, org, or topic) and the FOCUS (what the user cares about: events, openings, drops,
   news, releases, scores, prices…). Keep the user's exact words for the record.

2. **Resolve the best SOURCES for each entity.** Aim for 1–4 high-signal sources each. Prefer, in
   order: the entity's own EVENTS/calendar page → its official site/blog → its primary social
   handle (Instagram/X) → a reputable local aggregator that lists its events. Use web search when
   available; otherwise use known URL patterns (official domain, `instagram.com/<handle>`,
   `x.com/<handle>`) and your knowledge. Favor pages that list dated happenings over generic home
   pages. If you genuinely cannot resolve a source, record the entity with a `note` saying what's
   missing rather than guessing wildly — and ask the user for the handle/URL in your reply.
   Source types: `website`, `events`, `calendar` (all fetched by browse-interests), `instagram`,
   `x` (browsed via the app source when the account is followed; otherwise note it).

3. **Write the record** to `data/interests.jsonl` (append one JSON object per line; if an interest
   with the same `id` already exists, rewrite that line instead of duplicating). Shape:
   ```json
   {"id":"<short-kebab-slug>","createdAt":<epoch_ms>,"query":"<user's verbatim words>",
    "status":"active","focus":"<what to surface, e.g. events/openings/drops near Bozeman>",
    "cadenceHours":24,
    "entities":[{"name":"<Entity>","sources":[{"type":"events","url":"https://…"},
                                              {"type":"instagram","handle":"…"}]}]}
   ```
   Web sources (`website`/`events`/`calendar` with a `url`) are the ones browse-interests fetches
   and extracts events from — always include at least one per entity when you can.

4. **Reply** (one concise chat message): confirm what you'll track, name the sources you set up,
   say events/updates will start showing in the feed as they come up, and mention they can say
   "stop tracking <thing>" anytime. If a source was unresolved, ask for it.

5. **Removal / edits.** "stop tracking X" → set that interest's `status` to `"removed"`. "also
   follow Y" or "add Z as a source" → update the existing record's entities/sources.

Do NOT block on the browse — you only write the record and confirm. The next cycle's
browse-interests.py fetches the sources and the events land in the feed on their own.

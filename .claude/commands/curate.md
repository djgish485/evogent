Run one curation invocation: either a full curation cycle or one targeted thread, based on request scope.

Usage: `/curate [optional focus]`

`$ARGUMENTS` is optional extra focus for a full cycle, or the anchor for a targeted-thread request.

## Execution model

- You are the curation worker for this task.
- Do the work directly in this run. Do not spawn another agent CLI process. Do not use tmux.
- Resolve `API_BASE="${MEDIA_AGENT_INTERNAL_BASE_URL:-http://127.0.0.1:${PORT:-3001}}"` before calling any internal endpoint.
- When `MEDIA_AGENT_INTERNAL_BASE_URL` is present, never replace it with `localhost:3001`, `127.0.0.1:3001`, or another guessed port.
- When `MEDIA_AGENT_CURATION_PROGRESS_URL` is present, report major phase changes there with `taskId`, `phase`, and optional `detail`.
- When `MEDIA_AGENT_CURATION_PERSIST_DEADLINE_AT` is present, treat it as the submit boundary for the locked batch.
- When the prompt includes both `ChatMessageId:` and `SessionId:`, this cycle is chat-backed regardless of trigger source.
- Chat-backed cycles must POST exactly one brief agent reply to `${API_BASE}/api/internal/chat/submit` with `inReplyTo = ChatMessageId`, `taskId = $MEDIA_AGENT_TASK_ID`, and `sessionId = SessionId`. Do not skip the reply just because the cycle was heartbeat-fired.
- For chat-backed cycles, `SessionId` is the provenance source of truth for feed submission: include request-level `originSessionId = SessionId`, per-item top-level `originSessionId = SessionId`, `metadata.originSessionId = SessionId`, and `metadata.originKind = "curator_chat"`.
- Runtime-first boundary: judge sources here, but prefer the revived ambient browse cache first. Product code owns cache persistence, dedup, enrichment, and feed reads. Do not invent new product-side thread machinery inside the curation run.

## 0. Classify request scope

Before treating `$ARGUMENTS` as extra editorial focus, classify the user's request.

- **Full-cycle mode:** use the normal Phase 1-8 flow when the user sends bare `/curate`, asks for a broad refresh, or asks for a source-wide pull.
- **Targeted-thread mode:** use this mode when `$ARGUMENTS` names a specific URL, article, tweet, video, paper, or says things like "around this article", "one thread", "inspired by <url>", or "curate on this".

In targeted-thread mode, the goal is one focused thread around the named source item, not a full feed cycle. Anchor the thread on the source item, browse/cache-search only for closely related context, and submit roughly 3-10 items when the evidence supports a coherent thread. Do not run the default five-category organization, do not aim for 40-50 items, and do not fill gaps with unrelated material. Still use the normal submit path, dedup checks, provenance fields, and mark-seen step for cache rows actually read. If the source item cannot support a thread, say that plainly in the chat reply instead of shipping an unrelated full cycle.

Before broadening the thread, read the anchor item itself. If the anchor URL is partially accessible, use the accessible title, deck, visible paragraphs, article metadata, and source-owned preview text as the controlling thesis. If a first fetch is blocked, retry with the shared browser or another normal browsing path before relying on secondary coverage. Build the thread by testing that thesis with supporting and contrary evidence; do not replace it with the strongest adjacent generic storyline. If you still cannot read enough source-owned material to state the anchor's thesis in one plain sentence, say that plainly in chat and do not ship a thread around inferred context.

## 1. Become the user first

- Use `${MEDIA_AGENT_ROOT}` when set. Otherwise work from the current project root.
- Read these context files before browsing:
  1. `data/config.md`
  2. `data/curation-prompt.md`
  3. `data/preferences-context.md`
  4. `data/preference-insights.md` when present
  5. `.claude/skills/*/SKILL.md`
- In full-cycle mode, use `$ARGUMENTS` as added editorial focus, not as a replacement for the context files. In targeted-thread mode, use `$ARGUMENTS` to identify the anchor source item and the tight context around it.
- Treat `data/curation-prompt.md` as the user's editorial taste surface; only shared UI/copy/submit mechanics belong in this tracked command.
- Read the recent raw feed via `GET ${API_BASE}/api/feed?limit=200&sort=created`.
- Read recent source ids and urls directly from SQLite before submit so you avoid obvious duplicates:
  `SELECT source_id, url FROM feed WHERE created_at_ms > (strftime('%s','now','-72 hours')*1000) AND (source_id IS NOT NULL OR url IS NOT NULL)`
- Ask at every stage: would this user see this as part of a live conversation they would stop scrolling for?

## 2. Gather current-interest and feedback signals

- Track the installed source skills available for this cycle from the skills you loaded in Section 1. Currently the source-skill set is `tweet-cache`, `youtube-cache`, `substack-cache`, and `hackernews-cache`.
- Browse the user's signal X handle (declared in `data/curation-prompt.md`) and its `/with_replies` page for the last 24-48 hours through MCP Playwright every cycle.
- Extract repeated themes from that window and use them as soft editorial steering for matching items.
- Treat the user-declared signal account as signal, not first-class feed content. Use it to detect lanes, then build those lanes from other authors. It can appear as one supporting voice inside a thread only when at least 2 other distinct authors contribute substantively; otherwise drop it.
- Tag matching accepted items with `metadata.currentInterestReason`.
- Skip this gracefully when recent activity is too thin to support a real theme read.
- In parallel with the signal account's `/with_replies` read, identify up to 2 accounts the user engaged with in a clearly positive way in the last 24-48 hours: substantive replies, supportive or curious tone, and clear extension of the original idea rather than argument, correction, or dunking.
- Exclude accounts already listed under `## Priority Thinkers` in `data/curation-prompt.md`. Also exclude accounts the secondary browse session already follows; if follow-state is unclear, err on surfacing rather than suppressing.
- Before emitting anything, read the last 7 days of feed items and skip any handle that already has a `type: "notification"` item with `metadata.notificationKind: "follow_candidate"` or matching `metadata.suggestedHandle`.
- For each qualifying account, emit at most one `type: "notification"` item this cycle with:
  - `title`: `Consider following @<handle> on the browse account`
  - `text`: brief account description, the specific reply from the signal account that signaled interest (link to or quote the reply), and a one-line reason to follow
  - `metadata.notificationKind: "follow_candidate"`
  - `metadata.suggestedHandle`: the plain X handle
- Never auto-follow, never click Follow, and never navigate to a profile just to follow it. This is a user-decision notification only.
- Also read the last 72 hours of chat messages with `metadata.threadFeedback` before selection.
- Also read recent structured `thread_feedback` rows when present:
  `SELECT thread_id, cycle_id, vote, thread_title, reason, category, probe_reason, probe_uncertainty, source_item_ids, origin_session_id, created_at FROM thread_feedback ORDER BY datetime(created_at) DESC LIMIT 25`
- Build a feedback dictionary keyed both by `threadId` and by fuzzy topic-lane matches derived from `threadTitle` substrings plus `threadRationale`.
- Record the user's `vote` (`up`/`down` from chat feedback, `more`/`less` from structured probe feedback) and any stated reason for each matching thread or lane.
- Use that dictionary bidirectionally during thread detection:
  - `up` votes on a lane allow and encourage continuation of that lane in this cycle.
  - `down` votes on a lane actively dampen re-threading; require materially different content, new events, or new angles before threading that lane again.
  - absence of a vote on a recently-threaded lane is a soft negative signal; do not auto-continue it just because the conversation is still alive.
- Treat recent thread feedback as editorial steering for continuation decisions, not as a frozen taxonomy or hardcoded lane list.
- In most cycles, consider at most one feedback-probe thread when a candidate is high quality, clears the normal thread rules, and is genuinely uncertain because of source fit, topic fit, thread shape, or borderline-probe behavior. Do not force a probe when the pool is weak or the candidate fails quality gates.
- To create a probe, attach `metadata.feedbackProbe = { reason, uncertainty, category, sourceItemIds, options }` to the selected thread's items. Keep `options` short, usually `{ "moreLabel": "More like this", "lessLabel": "Less like this" }` or `{ "moreLabel": "Keep pushing", "lessLabel": "Stop pushing" }`.

## 3. Build one holistic candidate pool before selection

- Before final selection, assemble a unified pool from:
  - fresh `browse_cache_items` rows for every installed source skill, read via `GET ${API_BASE}/api/internal/browse-cache/items?source=<source>&unseenFirst=true`
  - direct-browse fallback results only for sources whose cache is stale, empty, or explicitly force-refreshed this turn
  - the last 3-5 scratchpads in `data/tmp/curate-scratchpad-*.md`
  - the last 48-72 hours of feed items via `GET ${API_BASE}/api/feed?limit=200&sort=created`
- The unseen cache is the candidate pool; do not filter it down to "stuff newer than the last cycle." It already excludes shipped items, so re-filtering by post-cycle time just drops earlier-in-the-day items the previous cycle skipped.
- Deduplicate this pool and treat it as the substrate for both thread detection and final item selection.
- Fresh cache rows are the default source of speed for interactive curator sessions and heartbeat curation alike. Live browse is fallback, not the default path.
- Treat `holisticPoolSize.thisCycle < 300` deduped cache-plus-fallback candidates as a soft under-coverage warning. If the pool is thin because a source cache is stale or empty, either force-refresh that source or document why the cycle had to proceed with thinner input.
- Do not print full cache payloads, giant per-item dumps, or Python-expanded candidate lists into the chat/tool transcript. Inspect locally and carry forward only compact notes, ids, counts, and the shortlist that actually survives.
- Always run 2-3 targeted web searches each cycle for current-news articles from quality outlets (AP News, Reuters, Ars Technica, Nature, WSJ, FT, Bloomberg, specialist tech/policy sites). The cache covers social and aggregator surfaces; these web searches cover the rest of the news landscape. When a web-search result covers a story already anchored by a tweet in the pool, attach the article as a `relationship: "context"` item under the tweet's feed-id instead of shipping it as its own first-class card.
- For every full curation cycle, directly browse the WSJ home page, the New York Times home page, and WSJ Opinion/editorials before final thread selection when browser access works. Headlines, decks, page placement, and editorial-page framing are useful even when article bodies are paywalled; do not require subscription text.
- Front-page lead handling: when WSJ or NYT has a visually dominant current-event lead, treat it as a rare override signal, not a routine requirement. Ask: is this a live public event, policy shock, market shock, war/diplomacy turn, or major elite-institution story? If yes, prefer a fresh top-level thread/update unless there is a clear quality reason to drop it. If no, record the headline in `frontPageSignalAudit` and continue normally. Use direct story wording and `metadata.thread.prominence.level = "lead"` only for accepted lead-level threads.
- Use front-page prominence as evidence for thread detection, targeted follow-up searches, context attachments, and top-level update/probe decisions, especially for current events and elite-opinion shifts. For accepted lead-level threads, use the story itself as the thread title, make the thread rationale one plain sentence about what happened, and set `metadata.thread.prominence` with `level: "lead"`, `source: "homepage"`, compact `evidence`, and optional `homepageUrl`. Do not ship paywalled homepage items as standalone cards unless the URL, source synopsis, and thread fit clear the normal quality gate.
- Record `frontPageSignalAudit: { pagesChecked, majorHeadlineSignals, wsjEditorialSignals, actions, skipReasons }` in the scratchpad. For each major lead considered, include `{ headline, prominence, action, reason }`; a dropped visually dominant lead must include the headline and a concrete quality reason. If a page cannot be checked, keep the curation moving and record the skip reason instead of inventing the signal from memory.
- Record in the scratchpad:
  - `signalHandleRead`
  - `frontPageSignalAudit`
  - `holisticPoolSize: { thisCycle, fromPreviousScratchpads, fromRecentFeed, totalDedupedCandidates }`
  - `consideredFrontierSize`
- The considered frontier should usually be at least 40 items unless the pool is genuinely too small.
- If context or tool-call budget is already getting tight once the compact frontier exists, stop frontier expansion there. Record `what_survived` in the scratchpad with the valid threads, strongest near-misses, and sources not yet checked, then move immediately to thread detection and staged submit.

### Tweet candidate pool

- The tweet candidate pool is the full unshipped Twitter cache, not the `Priority Thinkers` subset. Read it via `GET ${API_BASE}/api/internal/browse-cache/items?source=twitter&limit=150&unseenFirst=true`. This read cap follows the policy-side cache limits in `data/tweet-cache-policy.json`; do not expand it to 500 inside curation. Before concluding the tweet pool is thin, evaluate up to 150 distinct unshipped tweets across at least 40 distinct handles when that many are available.
- Before editorially judging a cached tweet, inspect its payload text-completeness markers. If `payload.textCapture.completeness`, `payload.cacheAudit.textCompleteness`, or `payload.sourceQuality.textCompleteness` is `"incomplete"` or the row says status-page recovery failed, do not treat it as a taste/content rejection and do not ship it. Log it only as a source-quality candidate miss with `rejectionReason: "source-incomplete-text"` and candidate `metadata: { rejectionScope: "source_quality", sourceQualityIssue: "twitter_text_incomplete", cacheAudit: <compact cacheAudit/textCapture facts> }`.
- Cache-only curation should judge tweet content only when the cache row has complete text or no explicit incomplete marker. A visibly mid-sentence timeline snippet without a complete marker is a cache-quality bug, not a reason to penalize the author in editorial rejection stats; include the count in `cycleSummary.metadata.twitterSourceQualityMisses`.
- Keep the two `priority` concepts separate: caching priority (`tweet_cache_priority_accounts`, for scraper depth only; curator does not use it) versus curation boost (`Priority Thinkers` in `data/curation-prompt.md`, which lowers the bar once a tweet is already under consideration). Priority Thinkers are a tiebreaker, not a gate. If you are filtering tweets by handle before reading content, you are making this mistake.

## 3.5. Source coverage is expected unless a real limit stops it

- Breadth is the default, and getting one validated thread shipped is the first hard requirement. Attempt every discovered source skill when budget is healthy. If the first shippable thread appears before all source attempts are done, staged-submit that thread first, then continue the remaining source attempts while source access, deadline, context, and tool budget remain healthy.
- First attempt a cache read for each source. Only escalate to live browsing when that source's cache is stale, empty, or the user explicitly requested freshness.
- The holistic pool is the point of browsing. Adding breadth to `holisticPoolSize.thisCycle` is a first-class goal even when items from that source do not survive final selection.
- Skipping a source's browse requires an explicit scratchpad entry. Record `sourcesSkipped: [{ source, reason }]` for every skill that was discovered but not browsed.
  - Valid reasons: authentication broken because the skill's env vars are missing, the source is verifiably down because a quick probe returned an error, or deadline/context/tool budget was genuinely exhausted before broad coverage could finish.
  - Invalid reasons: "I expected low yield", "another source was more promising today", "the story was in X so I focused there", "nothing timely from this source typically", "the previous cycle just did this, so the cache must be drained", "the major lanes were already covered last cycle."
- Low-yield output from a source is acceptable and does not require an entry in `sourcesSkipped`. Only the case where you never visited the source's canonical URL or never made the source's API pull requires a skip entry.
- When YouTube, Substack, or another non-event-dominant source would otherwise be skipped, remember that you are trading feed diversity for convenience. The default posture is broad coverage across every installed source skill. Active-event cycles still attempt every source. A fresh AP article can compete for a slot against a fresh Dwarkesh video or a Substack piece, but all three sources should be browsed first.

## 3.6. Hacker News points are a light curation signal

- For Hacker News candidates, read points directly from the cache row's non-null integer `score` field; do not do extra browsing just to recover a score.
- Treat low HN score, roughly below 30 points, as a soft drop signal when the item is not otherwise somewhat interesting. A low-score HN item with no clear exception should be dropped before submit.
- Exceptions are allowed when the content itself is genuinely strong: examples include a Priority Thinker pickup, a Current Focus thread, the only available source for a fresh story, or a real Underpriced discovery. High-score HN items remain eligible on engagement alone, but score is still one input rather than a hard gate.
- If pre-submit candidates include low-score HN items that are dropped for this reason, record their cache/source ids in scratchpad audit metadata such as `droppedLowScoreHackerNewsIds`.

## 4. Detect threads before final selection

- Run thread or cluster detection before locking the accepted set.
- Threads are the shipping unit. The five-category default below is a reasonable starting shape; ship it when today's pool maps onto those categories, ship a custom set of validated threads when a different organization is more natural. Record `threadStrategy: { mode: 'default-five-categories' | 'custom-organization', reason }` in the scratchpad. Do not force items into a poor-fitting category to keep the count at exactly five.

  Default five categories:

  1. **Mainstream** — what is actually moving right now. The live stories the feed would lead with today. Let the source material tell you what is actually live.
  2. **Contrarian** — pushbacks on the dominant takes. Posts that argue against the reigning consensus on today's live topics. Each bridge names the consensus and the specific mechanism of disagreement.
  3. **Unknown voices** — fresh handles worth the attention. Accounts not in the user's Priority Thinkers list and not repeat sources in the last 5 scratchpads. Each bridge names the handle and a one-line reason to follow. The handle should map to someone the user could actually follow on X, Substack, or YouTube; an HN item belongs here only when it clearly points to the creator's real off-HN presence.
  4. **Underpriced** — high signal, low engagement. Substantively interesting items with low public engagement (few likes, few HN points). Treat this as a real discovery claim: the spirit is material the user likely would not have surfaced elsewhere. Frontpage HN stories, popular Substack posts, and already-trending discourse usually miss the category even when they look smart.
  5. **Long-tail adjacent** — deeper angles on the usual preferences. Topics adjacent to the user's interests but not served this week: unusual tech economics, specific engineering deep-dives, historical parallels to current stories, philosophy-of-science beyond the standard shelf.
- When multiple sources cover the same story, prefer the tweet as the primary item and attach cross-source captures as `relationship: "context"` items with `parentId` pointing to that primary item.
- Inside a chosen thread container, individual items do NOT need cross-source pairing, a companion tweet, or a second source of their own. The `>=2 distinct-source` rule applies to the thread in aggregate, not to each item. A strong solo-source article, a single sharp tweet, or a one-off operator postmortem are all valid items inside a thread when they fit the chosen thread's discipline and pass the anti-slop and empathy gates.
- Inside each chosen thread container, detect multiple topic strands and order items so related ones sit together. The `>=3 items / >=2 distinct sources` validity bar applies at the thread level, not to sub-strands within it. When using the default category organization, keep those topic strands inside the chosen category thread instead of carving them out into substitutes.
- If a lane was threaded in any of the last 2 cycles and a fresh lane also survives the normal validity bar, use recency only as a tiebreaker: prefer the strongest fresh lane over a similarly strong continuation lane, but if no fresh lane survives, fall back to the strongest continuation lane that still clears 3+ items across 2+ sources.
- A valid cluster requires at least 3 items from at least 3 distinct authors. Same-author piles do not qualify.
- For science, engineering, and mechanism lanes, virality alone is not signal. The lane should offer either a concrete technical mechanism insight in the content or substantive discussion depth from trusted accounts such as Karpathy, Deutsch, Paul Graham, Nielson, and similar thinkers.
- Valid topic strands inside a category include specific events, debates, and continuing intellectual lanes or conversations; invalid grouping is a generic undifferentiated topic bag such as broad AI news, politics, or crypto.
- Signal-account-only or signal-account-dominant clusters do not qualify as threads.
- Use the empathy test: would this user see these items as the same conversation while scrolling?
- For time-sensitive event strands such as war, conflict, diplomacy-in-motion, and breaking policy or regulatory developments, cross-source convergence is itself meaningful signal. Do not reject a live event cluster as mere "negotiation-state churn" or "headline wrapping" when multiple sources are reflecting real state change across distinct angles such as an official announcement, a counter-announcement, a market reaction, a policy mechanism, or an international response.
- For evergreen intellectual lanes, hold the normal bar for commentary depth and distinctness. For time-sensitive event strands, the default posture is: if 3+ items across 2+ sources are clearly the same live event, keep that strand grouped together inside the chosen thread container unless every member is truly surface-level repetition without any distinct angle.
- Do not require each member to be strong enough for standalone curation. Cluster membership can promote a thinner third or fourth angle that helps the thread cohere.
- Record promoted items in `promotedFromClusterMembership: [sourceId, ...]`.
- When a thread starts earlier in prior scratchpads or the recent feed, do not automatically mark it as continuing.
- A thread is only allowed to be marked `continuing: true` when at least one of these is true:
  - the last 72 hours of `metadata.threadFeedback` include a matching `threadId` or fuzzy topic-lane with `vote: "up"`
  - the thread is `time_sensitive` and has fresh developments within the last 24 hours
  - the lane has not been threaded in any of the last 3 cycles
- If none of those conditions is true, do not build a continuation thread for that lane in this cycle. Either promote a fresh thread around materially new evidence or drop the lane for this cycle; do not ship lane-matching items outside a thread.
- Bias toward threading fresh lanes over re-threading the same lane without engagement. The user model is: the agent surfaced a conversation, the user reacted, and then the agent kept pulling on it.
- Read "has the user seen this thread?" from activity, not votes. Query `user_activity` for `foreground` and `app_open` events with `timestamp` after the thread's shipment time; also count chat messages in the same session after shipment. Several foreground events or any chat activity after shipment = "seen."
- An explicit thumbs-down or dismiss (visible in the `interactions` table or in `chat_messages` with `metadata.threadFeedback`) is a drop signal. A seen-but-not-voted thread is NEUTRAL, not soft-negative — this user rarely votes; absence of a vote after confirmed activity means the thread wasn't strong enough to react to, not that it was rejected.
- When the user has not been active since shipment, hold continuation judgment until they have been; do not drop a lane just because there is no vote on an unseen thread.
- When continuation is allowed, include the historical members in the thread evidence and note why continuation was justified.
- Treat the in-cycle items that triggered detection as the thread seed. If the thread is valid, those seed members stay in the thread; later research augments them rather than replacing them.
- `threadsDetected` may be empty only when the entire candidate pool has no cluster that clears 3+ items across 2+ sources and no orphan-promotion attempt can raise a strong seed to the bar; in that case record `pool-too-thin-for-any-thread` in the scratchpad and warn the user explicitly instead of silently shipping any non-threaded fallback.
- The moment at least one detected thread already clears the validity bar and survives the recent-feed/dedup precheck, lock an initial batch from those thread members and staged-submit it. That first batch prevents zero output; it is not a completion condition.
- Record:
  - `threadsDetected`
  - `threadCandidatesRejected`
  - `threadContinuationDecisions`
  - `promotedFromClusterMembership`

## 5. Run thread-driven deep research before final selection

- Deep research is additive, not a blocker on the first landing. If one or more valid threads already survive without it, staged-submit that floor first, then continue research only if budget remains healthy.
- Every valid thread that remains in play after the first staged submit should get a focused deep-research pass before the final stage. Do not let this phase prevent the first valid submit.
- Do not spend deep-research budget on items that are not part of a detected thread, except for orphan-promotion attempts on individually strong seeds.
- Keep the in-cycle seed as the lane detector, but do not treat signal-account seed items as protected content. Use them to find the lane, then prefer other authors for final thread membership unless the final thread still has at least 2 other substantive authors and the signal account remains a supporting voice.
- Classify each thread by time-sensitivity and record it in the scratchpad entry as `timeSensitivity: "time_sensitive" | "evergreen"`.
  - `time_sensitive`: breaking news, active conflict, live policy or regulatory developments. Prioritize sources from the last 24 hours.
  - `evergreen`: methodology debates, philosophical threads, longer-horizon research arcs. Allow a wider time range and optimize for commentary depth rather than freshness.
- Run targeted deep-research browses aimed at adding distinct angles to the thread, not replacing the seed:
  - Twitter/X search on the specific topic, using `&f=live` and a recency posture that matches the thread's time-sensitivity.
  - Hacker News search via `https://hn.algolia.com/api/v1/search_by_date?query=...` for commentary or related technical discussion.
  - Web search for quality-outlet coverage that matches the thread's character.
    - For `time_sensitive` threads, prioritize outlets such as AP, Reuters, WSJ, FT, and Bloomberg.
    - For `evergreen` threads, prioritize longer-form analysis, research blogs, and preferred commentary sources from `data/curation-prompt.md`.
  - Targeted profile browsing for thinkers tightly associated with the thread who were not already covered by the normal gap-fill pass.
- Budget research deliberately:
  - start with 1-2 targeted searches per thread
  - hard cap of 3 targeted searches per thread
  - cycle-wide cap of about 10 additional targeted searches regardless of thread count
  - stop early when the thread already has one genuinely new angle or the budget is starting to feel tight
- Orphan promotion: when a candidate item is individually strong but has no obvious thread, the agent must attempt to build support around it before deciding whether to ship it. Run the same deep-research browse set used for organic threads above (Twitter/X live search with `&f=live`, HN Algolia, web search for quality outlets, targeted profile browses of adjacent thinkers), sized to 1-3 probes rather than 5. Use that research to place the item into the best-fit validated thread with a clearer bridge and stronger neighboring items. If research finds no fresh companions, the orphan can still ship as a strong item inside its best-fit validated thread; it does not create a separate mini-thread. Drop only when the orphan fails the empathy or anti-slop gate, not when external coverage is just thin.
- Promote newly found items into the thread only when they add a distinct angle, new evidence, or a genuinely different voice. Reject weak corroboration and near-duplicates that merely restate what the seed already says.
- For `time_sensitive` threads, drop newly researched additions older than 48 hours from the research results. The seed is exempt from that age filter and stays in the thread regardless of age.
- The thread's final membership is additive: `seed members + newly promoted research members`. Both sets should carry the same `metadata.thread.threadId`.
- When a selected tweet is a reply (body starts with `@`, or the capture marks `inReplyTo` / `isReply`), check existing captures for the parent first. If it is not already captured, browse the parent status URL, then submit the direct parent tweet as a `relationship: "parent"` context item alongside the reply. A reply without its parent is missing the conversation.
- Record per thread:
  - `threadDeepResearch: { threadId, timeSensitivity, seedMemberIds: [...], searchesRun: [...], newSourcesFound: [...], newMembersAdded: [...] }`
  - Keep seed members and newly added research members distinct in the audit trail.
- Record orphan attempts as `orphanPromotions: [{ seedSourceId, searchesRun: [...], sourcesFound: [...], outcome: 'promoted_to_thread' | 'dropped', threadId? }]`.

## 6. Select with the validated floor

**The previous cycle is irrelevant to this cycle.** The unseen cache only returns items not yet shipped — a lane covered last time is not a lane drained, and "we just shipped this" is never a real stop reason. Build against the Section 6 target from the unshipped pool the new cycle actually has.

- Threads are the shipping unit, and tweets should be the majority of what ships inside those threads:
  - target about 40-50 items per cycle across a handful of validated threads, typically 4-7; the category targets in `data/curation-prompt.md` apply when the curator has chosen the default category organization
  - tweets should be the majority of shipped content items across all categories, not a minority. Aim for tweets to be at least half of each thread's content items (excluding analysis) when the pool supports it. A cycle with 18 articles and 1 tweet is structurally wrong even when the thread framing is good; the feed exists to surface what real people are saying on X, not to become a long-form link digest. If X browsing is thin or the pool has few tweets passing the anti-slop and signal-account rules, record `under-tweet-volume: true` in the scratchpad only after showing `(a)` raw unshipped Twitter cache count, `(b)` tweets actually read this cycle, and `(c)` distinct authors represented there; if the cache has `>=200` unshipped tweets but you evaluated fewer than `150`, that is under-browsing, not under-tweet-volume. Do not silently ship article-dominant cycles.
  - Max 3 tweets from any single author per cycle, across all threads combined. If a high-volume handle has 10 good tweets in the pool, pick the 3 strongest thread members and make room for other voices. Priority Thinker status does not override this cap.
  - do not hit a tweet count by shipping lane-matching items outside their thread
  - volume floors no longer apply as a ceiling; the default category targets are reaching numbers, not caps. Shipping 8 items across validated threads is better than 22 items padded by weak leftovers, but shipping 19 items when the pool cleanly supports 40 is under-curation
  - Orphan-promoted items count only inside their best-fit validated thread. If the pool genuinely cannot support the volume target after the orphan-promotion pass, ship what is clean and record `pool-too-thin-for-volume-target: true` with evidence; do not pad with singletons.
- When using the default category organization, push each category toward its ~10-item target before stopping. When a chosen thread is still thin but marginal-but-real candidates exist in the considered frontier, include them with `metadata.currentInterestReason` explaining the cut. Do NOT reject otherwise-strong items for being one-source when the containing thread still clears the thread-level validity bar.
- When a valid thread survives to the final set, keep its seed members and approved deep-research additions together. Do not replace the seed with "better" research finds.
- If context or tool-call budget is getting tight at any point in Section 6, stop polishing and ship the validated floor immediately. Record `what_survived` with the threads locked, the strongest unfinished additions, and the exact reason you stopped expanding.
- Apply the anti-slop gate to every final item: reject visual-satisfaction or novelty bait such as humanoid robot half-marathons, satisfying manufacturing clips, novelty embodied-AI demos, vertical-farming wow reels, craft/tool spectacle, and similar items when spectacle is doing the work and the item lacks real mechanism insight, trusted-account depth, or a trust signal from the account itself.
- At the start of Section 6, calibrate the preference DB with exactly 3 `POST ${API_BASE}/api/preferences/match` calls against the top 3 pool items using `{ text, topK: 5 }`. Record `cycleSummary.metadata.preferenceMatchAudit = { dbState, calledCount, skippedByScore, overrideCount, shippedAverageScore }`. If the endpoint fails or the 3-call average `density.total` is `<10`, set `dbState: "cold"`, keep `calledCount: 3`, and skip the hard-filter step for the rest of the cycle.
- When `dbState: "populated"`, every candidate that already survived anti-slop and thread-validity checks must be scored before ship using its primary text (`tweet text`, `article title + excerpt`, or `YouTube title + channel`). Attach `preferenceMatch: { relevanceScore, verdict, matchedLikes, matchedDislikes, densityTotal }` to the candidate scratchpad entry. Treat `verdict: "weak_match"` or `relevanceScore < 0.35` as a hard skip unless the item is `(a)` a real live-event breaking story in a Current Focus lane or `(b)` an explicit Priority Thinker tiebreaker; record each exception in `metadata.preferenceMatchOverride` with a one-line reason. Populated cycles should usually make about 8-12 calls total, and shipping with `dbState: "populated"` but `calledCount: 0` is a correctness failure.
- Every shipped item, including the cycle problem-solving article, must belong to a validated thread and carry `metadata.thread.threadId`.
- If the cycle ships materially below the intended volume target after the orphan-promotion pass, the scratchpad should include explicit proof:
  - pool size
  - how many candidate threads cleared the bar
  - how orphan-promotion attempts were exhausted
  - why the remainder failed
- Record `volumeAudit: { validThreadsAccepted, tweetsAccepted, nonTweetsAccepted, totalAccepted, targetThreadsMet, ifNot_explanation }`.

## 7. Risky takes and the cycle problem-solving article

- Every cycle attempts ONE problem-solving article. This is the signature first-class output of each curation, but it ships only when one selected thread clearly owns the problem.
- Include 1-2 risky takes per cycle when adjacent-but-not-alien items are worth stretching toward. Every risky take should carry `metadata.riskyTake.reason` with a concrete mechanism-rich explanation.
- The article is a short piece by `<Agent Name>'s Solutions` from `## Agent Name` in `data/config.md`. Name a real problem, then propose a creative solution. It is not a generic synthesis or a "read these together" blurb.
- Find the problem across the cycle's selected items, the broader unshipped browse cache for every installed source skill, and the last ~7 days of feed items and scratchpad notes. It can draw from several threads, but before submit choose the best-fit selected thread that raised the problem.
- Pick the single most interesting problem in that pool: not the biggest story, the most tractable question this user would stop scrolling for. A good problem has named actors, a specific mechanism under stress, and room for a concrete solution the user has not already seen on X.
- Simplicity gate, once per cycle:
  1. Draft the problem in 1-2 plain-language sentences with named actors and a specific mechanism. No jargon, hedging, or abstract compound nouns. If the first draft is vague, widen the pool and try again.
  2. Run 2-5 targeted probes such as web search, preferences context, prior analyses, or profile browses. Draft a concrete creative solution in plain language. If the first solution draft needs consulting-speak, do one more probe and rewrite. If the second still needs consulting-speak, skip.
- When the gate clears, ship the article inside the best-fit selected thread that raised the problem:
  - `type: "analysis"`, `source: "claude"`, lower-case `authorUsername`, `authorDisplayName: "<Agent Name>'s Solutions"`
  - set `metadata.thread` to that thread's normal `{ threadId, threadTitle, threadRationale }`, `parentId` to a real primary member of that same thread, and `relationship: "analysis"` so the UI renders it in the thread Synthesis block
  - topic-first title, 250-500 words minimum, plain language, concrete actors, creative proposed solution, and a brief "what would refute this" or "what to watch" footer
  - `## Sources` required; cite every materially used tweet, article, HN item, and web-search URL from this cycle's actual inputs; never fabricate URLs
  - `metadata.analysisScope: "thread-solving"`, matching `metadata.cycleId`, and a reason or metadata note explaining why this thread owns the problem when the article draws from multiple threads
- In staged-submit cycles, the article may land in a later stage than the first valid thread batch. Do not hold the first valid submit open while drafting the article.
- Skip when the second solution draft still needs consulting-speak, the full pool genuinely has no problem with a nameable mechanism and a creative solution, or no selected thread defensibly owns the problem. Do not append a loose analysis card at the end of the feed.
- If budget collapses after the initial valid submit, skipping the article is allowed only when the scratchpad records `analysisSkipped.reason: "budget-preserved-after-valid-submit"` plus the latest problem and solution drafts you reached.
- When skipping, record `analysisSkipped: { step1Draft, step2Draft, reason }` in the scratchpad. A silent skip without the drafts is a correctness failure.
- Healthy cache plus 3+ valid threads plus zero article is a flag to re-audit the cycle, not a normal outcome.

## 8. Write the scratchpad before submit

## 8.5. Mark cache rows seen before submit

- Required after selection, before submit: for every cache item you actually read during this cycle (HN/Substack/YouTube/tweet items that entered thread detection or orphan-promotion consideration — not just the ones that shipped), call:
  - `POST ${API_BASE}/api/internal/browse-cache/seen`
  - `Content-Type: application/json`
  - `{"items":[{"source":"twitter","sourceId":"<numeric-tweet-id>"}, {"source":"hackernews","sourceId":"<hn-id>"}, ...]}`
- Use the exact `source` value from the cache row (`twitter`, `hackernews`, `substack`, `youtube`).
- The endpoint returns `{ok,changed}`.
- If `changed` is `0` when you expected a non-zero, the body shape is wrong — fix it, do not ignore it.
- Mark-seen is not optional: it is what lets the next cycle's `unseenFirst=true` read see fresh material first.

- Before submitting anything, write a cycle scratchpad that includes:
  - `threadStrategy`
  - `signalHandleRead`
  - `frontPageSignalAudit`
  - `holisticPoolSize`
  - `consideredFrontierSize`
  - `sourcesAttempted`
  - `sourcesSkipped`
  - `threadsDetected`, `threadCandidatesRejected`, `threadContinuationDecisions`, `threadDeepResearch`, `threadDedupResilience`
  - `orphanPromotions`
  - `riskyTakes`, `problemSolvingArticle`, `analysisSkipped`, `promotedFromClusterMembership`, `volumeAudit`, `preferenceMatchAudit`, `what_survived`
- Also capture:
  - `sourcesAttempted: [skillId, ...]` for every source you actually browsed live this cycle, with at least one canonical URL per browser-backed skill or the skill's API for API-backed skills
  - `sourcesSkipped: [{ source, reason }]` for every installed source skill that was not attempted, using only the valid reasons from Section 3.5
  - the union of `sourcesAttempted` and `sourcesSkipped` should equal the set of installed source skills discovered earlier in the cycle
  - where coverage still felt thin, why the accepted set would stop this user from scrolling, and notable rejections
  - `problemSolvingArticle: { problemDraft, solutionDraft, scopeSpan, sourceCount, probeCount }` when shipped; `analysisSkipped: { step1Draft, step2Draft, reason }` when skipped
- `threadContinuationDecisions` should list each recently-threaded lane that was reconsidered, whether it had positive feedback, whether it was time-sensitive, whether it appeared in the last 3 cycles, and the final continue or drop decision with a short reason.
- `threadDedupResilience` should be recorded as: `[{ threadId, originallyPlanned, willBeKilledByDedup, replacedWith, finalMemberCount, finalSourceCount, decision: 'keep' | 'substitute' | 'drop' }]`.

## 9. Lock and submit in stages

- Report phases at minimum: `selecting`, `selection_locked`, `submitting_initial`, `submitted_initial`, and when applicable `submitting_final`, `submitted_final`.
- The moment the first valid thread batch is locked, immediately report `selection_locked` and switch to submit-fast-path.
- After `selection_locked`, stop optional polish that is not required for a valid submit payload; required expansion and volume audit continue after the initial submit while context, tool-call budget, and source access are healthy.
- Use staged submit. As soon as at least one valid thread survives dedup with 3+ members across 2+ distinct sources, `POST` that initial batch immediately with the cycle's real `cycleId`, even if the rest of the cycle is still unfinished. The initial batch is the floor, not completion; once a valid thread exists, a zero-item cycle is not acceptable.
- Continue after the initial submit while context and tool-call budget still look healthy. Additional source coverage, research, extra threads, and the cycle problem-solving article belong in later stages only when they do not risk the already-valid shipment.
- Reuse the same `cycleId` across all stages. Do not re-submit source ids that already landed in an earlier stage. Early stages may omit `cycleSummary` until the final stage if the totals are still moving.
- Each cycle ships a validated set of threads plus one thread-attached cycle problem-solving article when a selected thread clearly owns it. Use the default five-category titles from Section 4 when the curator chose the default organization; otherwise use short descriptive `threadId` slugs plus the date, stable within the cycle (for example `iran-hormuz-live-<date>`, `deepseek-v4-launch-<date>`, `agent-reliability-<date>`). Every thread member item belongs to exactly one chosen thread via `metadata.thread.threadId`; the cycle article must use `relationship: "analysis"`, a real `parentId` from its chosen thread, and `metadata.analysisScope: "thread-solving"`.

### Completion and reporting invariants

- A full `/curate` completes against the Section 6 target (40-50 items, 4-7 threads). Recency of the last cycle is not a real limit -- the unseen cache is the candidate frontier whether the previous `/curate` fired 30 minutes ago or 6 hours ago.
- Staged submit means: ship the first valid thread now, then keep going. It is not a completion condition. After the first staged submit, keep building toward 40-50 items across 4-7 validated threads until a real limit stops the cycle: source access failed, deadline/context/tool budget is exhausted, or the remaining pool cannot form another valid thread after dedup and orphan-promotion.
- If the final cycle is below target, record why in `volumeAudit` and say it is below target; do not present a staged floor as a complete curation.
- In the chat reply, count what the user can see after grouping. Raw accepted rows, duplicates, child/context rows, and existing-parent attachments are audit details, not the shipped count.
- Good full-cycle reply: `Shipped 43 items across five visible threads, led by GPT-5.5 work evidence.`
- Good thin-cycle reply: `Stopped below target after volumeAudit showed only two valid threads survived.`

- Copy rules for thread rationale and per-item bridge:
  - `threadRationale`: short phrase, hard-capped at about 10 words. If you can't write the rationale without jargon, you don't understand the thread well enough to ship it; rework it or drop the thread. Good: `Export controls reshape AI infrastructure plans.` Bad: `Since 9am, Reuters and X posts tracked export-control updates.`
  - `metadata.bridge`: short phrase, hard-capped at about 10 words. Same test: if it needs jargon or a pivot to stand up, try again. Abstract compound nouns like `control-plane surface`, `governance posture`, and `inflection point` are the tell that you're covering for lack of understanding with vocabulary. Plain language, named actors, short phrase. Good: `Altman frames Stargate as a power-and-permits bottleneck.` Bad: `@sama, 2h ago, citing Reuters, 12k likes.`
    - The bridge must add editorial value. A bridge that paraphrases the post in the same words is not a bridge.
    - Name the WHY or SO WHAT, not the WHAT the post already says.
    - Good: `Ion thrusters make ground tests the real risk burn-down.` Bad: `AstroForge is hot-firing its Hall-effect thrusters before launch.`
    - Good: `Pre-launch hardware risk, shown before the victory lap.` Bad: `AstroForge is hot-firing its Hall-effect thrusters to buy down risk before launch.`
    - Good: `Clean data makes small frontier-like models plausible.` Bad: `Karpathy tells Dwarkesh a 1B model on clean data could match a 1.8T model.`
- Short copy must not become an abstract slogan. Reject labels that sound tidy but omit the concrete reason to care unless the same visible title, intro, rationale, or bridge immediately explains the mechanism, actor, or consequence. When documenting examples, use actual rejected feed copy on the bad side, not intermediate drafts.
  - Bad old feed copy: `Readable systems beat platform drift` -> Preferred: `OpenAI's app builder matters because developers can still inspect and change the generated code.`
  - Bad old feed copy: `Linux-first hardware demand appears` -> Preferred: `A repairable Linux laptop is outselling Windows.`
  - Bad old feed copy: `Models meet messy developer workflows` -> Preferred: `GPT-5.5 is being tested inside real coding-agent workflows.`
  - Bad old feed copy: `Ownership records are part of security now` -> Preferred: `Old web access can become a security hole. Accounts using old email addresses can be hijacked when those domains expire.`
- Titles, thread intros, and bridges use plain language with named actors. Banned phrases everywhere: `one of the strongest surviving posts`, `the local payload`, `the cluster foregrounds`, `control-plane surface`, `retrieval-augmented-trust-boundary`, `inflection`, `posture` (unless the source itself uses it), `surface` as abstract noun, passive hedged constructions like `is being re-priced`, `is emerging as`, `is being reshaped by`. Banned: invented compound-noun jargon. Real terms of art are fine; coined phrases to sound smart are not.
- Before POST, count words on every threadRationale and metadata.bridge; any single one over 10 fails the batch - rewrite or cut. No exceptions, no abstract slogans.
- Before `POST`, query SQLite for the last 72 hours of existing `source_id` and `url` values, then compute each chosen thread's surviving members after removing already-shipped items and duplicate collisions with sibling threads in the same batch. If any thread falls below 3 surviving members or fails the `>=2 distinct-source` rule after that check, expand it with fresh thread-matched members from the candidate pool that also survive the check; when using the default category organization, do not solve this by carving out narrower substitute topic threads.
- Submit through `POST ${API_BASE}/api/internal/curate/submit`.
- Do not append to JSONL unless the submit API fails entirely.
- Submit the full item payload you actually verified. Do not expect the server to hydrate title, text, url, author, metrics, media, or metadata from a browse cache.
- Every item must include a concrete `reason`.
- `publishedAt` must never be in the future.
- Tweets must use the bare numeric tweet id for `sourceId`.
- Every tweet item carries `authorUsername` and `authorDisplayName` populated from the capture that contained the `sourceId`. Null author fields are a correctness failure, not a style issue.
- When submitting a tweet read from `browse_cache_items.payload_json`, carry the full `media` array through to `metadata.media` UNCHANGED, preserving each entry's `type`, `url`, `posterUrl`, and `videoUrl` if present. The flat compatibility list `mediaUrls` is derived by the storage layer; the curator does not need to compute it. Carry any captured `authorAvatarUrl` through unchanged. Do NOT drop these fields.
- Direct web article pre-submit gate:
  - For every article gathered by direct browsing or search, verify the saved card fields before submit: title, text/excerpt, URL, source, and media.
  - Do not submit first-class article cards whose title is only a domain, such as wsj.com, nytimes.com, or apnews.com.
  - Do not submit cards whose title/body is an unavailable page, access shell, navigation shell, or apology page, such as "Page unavailable," "Sorry, this page is unavailable," "Access denied," or "Not found."
  - If the page is real but the captured title is generic, revisit the page or source result and capture the source-owned headline plus source-owned synopsis.
  - If you cannot recover a real headline and source synopsis quickly, replace or drop the item. The agent's bridge/reason is not a substitute for missing source fields.
  - For accepted articles with a concrete `url`, fetch the page and set `mediaUrls` to the verified absolute social-preview image when one exists. The `text` or `excerpt` field carries the source's own synopsis: `og:description` meta tag, subtitle, or opening paragraph, never the agent's paraphrase.
  - Preserve source-owned publish time. If the fetched page exposes `article:published_time`, JSON-LD `datePublished`, or an equivalent source publish field, set `publishedAt` to that exact source time and include `metadata.publishEvidence = { status: "verified", source: "<field name>", publishedAt: "<same ISO time>" }`. Do not use curation time when source publish metadata exists. If no source publish field is present after checking the fetched page, include `metadata.publishEvidence = { status: "unavailable" | "uncertain", reason: "<short reason>" }` so submit-time validation can distinguish a deliberate fallback from a silent curation-time substitute.
- For YouTube posts and Substack pieces, the `text` or `excerpt` field carries the source's own synopsis — subtitle, description, or opening paragraph — not the agent's paraphrase. The agent's own take belongs in `metadata.bridge` or a separate analysis item, not in the item body. If the source has no usable synopsis, a neutral quote-based excerpt is acceptable (`The piece argues X, citing Y`); editorial framing (`The piece is interesting because...`) is not.
- Non-English tweet body handling: when a tweet candidate's primary body text is not in English, the submitted `text` field MUST be the English translation, not the original-language string. Translating it internally to decide whether to curate is not enough — the translation must carry through to the final submit payload.
  - `text`: the English translation (verbatim from your internal translation step).
  - `metadata.originalText`: the original-language body as rendered on X.
  - `metadata.originalLanguage`: a short language tag (`ja`, `zh`, `ko`, `ar`, `ru`); BCP-47 preferred, ISO-639-1 acceptable.
  - If translation confidence is low (cultural idiom, code-mixing, missing context, untranslatable wordplay), skip the tweet rather than shipping a weak translation or raw non-English text. Record the skip in `candidates` with `rejectionReason: "translation-confidence-low"`.
  - This rule is forward-only and applies only to tweet body text. Do not rewrite already-shipped feed items in place.
- For the cycle problem-solving article, use `relationship: "analysis"` and `parentId` pointing to a chosen primary source feed item in the same `metadata.thread`; if no owner thread is defensible, skip it and record `analysisSkipped`.
- `candidates` are only for rejected items you actually considered. Every included candidate must have `cycleId`, `sourceId`, `text`, `reason`, `rejectionReason`, and `timestamp`; use `"text": "candidate text or excerpt"`. Candidate `metadata` is optional and should be used for non-editorial source-quality misses, such as incomplete cached tweet text.
- Attach the relevant per-item metadata subset when applicable:
  - `metadata.thread: { threadId, threadTitle, threadRationale, continuing? }`
    - when using the default category organization, `threadTitle` should match the category title verbatim from the Section 4 default five categories; otherwise use the chosen custom thread title. Use `metadata.bridge` to name the specific development or angle for each item.
  - `metadata.cycleId` (same value as `cycleSummary.cycleId`)
  - `metadata.riskyTake: { reason }`
  - `metadata.currentInterestReason`
  - `metadata.preferenceMatchOverride`
  - `metadata.bridge`
  - `metadata.analysisScope`
- Chat-backed curator cycles take precedence over trigger source: if the prompt includes `ChatMessageId:` and `SessionId:`, include request-level `originSessionId` plus per-item top-level `originSessionId`, `metadata.originSessionId`, and `metadata.originKind: "curator_chat"` using that `SessionId`.
- Truly autonomous cycles with no `ChatMessageId:` must include `metadata.originSessionId: null` and `metadata.originKind: "heartbeat"`.
- The batch `cycleSummary.metadata` should capture cycle-level audit details, including the `volumeAudit` and `preferenceMatchAudit` results.

Batch shape:

```json
{
  "items": [],
  "candidates": [],
  "cycleSummary": {
    "cycleId": "curate-<timestamp>",
    "considered": 0,
    "selected": 0,
    "rejected": 0,
    "topRejectionReasons": [],
    "metadata": {}
  }
}
```

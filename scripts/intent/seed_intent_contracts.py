#!/usr/bin/env python3
"""Seed the distilled product-contract table in the canonical intent ledger.

The raw ledger (turns/signals/docs/commits) is evidence; this table is the
distilled, testable story: each row is one product contract with its origin
and a concrete way to verify it against the live app. Re-running replaces
all rows owned by this seed (idempotent).

Usage:
    python3 scripts/intent/seed_intent_contracts.py [--db PATH]
"""
import argparse
import sqlite3
from datetime import datetime, timezone

DEFAULT_DB = ".intent-ledger/evogent-intent-ledger.sqlite"
SEED_SOURCE = "seed-contracts-v1"

# (area, statement, evidence, verify_hint, confidence, status)
CONTRACTS = [
    # --- Feed ordering & carry-forward ---
    ("feed_ordering",
     "The top slate leads with the most valuable unseen material for the user now, not the newest accepted batch. Recency is not a substitute for relevance.",
     "AGENTS.md invariants; docs/intent-ledger.md; Dan 2026-06-01: 'it is supposed to reorder the feed editorially, not chronologically.'",
     "GET /api/feed?limit=30: top slots must not be 100% latest-cycle items; check displayOrder vs createdAt mix.",
     "established-by-user", "verified-2026-06-10"),
    ("feed_ordering",
     "Accepted-but-unviewed items remain eligible for the top slate no matter how old. Eligibility never expires; ranking competes on interest, not age.",
     "AGENTS.md; Dan 2026-06-07: 'everything unviewed & interesting should get reviewed in a curation process no matter how old.'",
     "feed_arrangement_runs.carry_forward_audit: eligibleCount == reviewedCount with includeAllUnviewed=true.",
     "established-by-user", "verified-2026-06-10"),
    ("feed_ordering",
     "After the user has been away, the best accepted-but-unviewed items created during the away gap (since last app_open) must compete for the top slate; the arrange backstop reserves about half its auto-promotion slots for them.",
     "Dan 2026-06-10: opened app after 3 days, top entries only hours old; June 8-9 batches (81 items) absent from slate while Apr/May items recycled. Root cause: age+displayed score bias.",
     "carry_forward_audit.gapPromotedIds non-empty when eligible gap candidates exist; gapStartMs == last app_open.",
     "established-by-user", "fixed-2026-06-10"),
    ("feed_ordering",
     "Items repeatedly auto-promoted into the slate but never viewed decay in rank (promotion-count penalty) so the same stale set cannot monopolize carry-forward slots. They stay eligible.",
     "Derived from 2026-06-10 finding: same Apr-28 tweet promoted in runs 53,54,55,56. Violates 'most valuable unseen NOW'.",
     "metadata.$.carryForward.promotedCount increments per promotion; scoreBreakdown.promotedPenalty < 0 for repeat promotions.",
     "established-by-user", "fixed-2026-06-10"),
    ("feed_ordering",
     "The curator decides what is important — not an opaque algorithmic score. Persisted ranking signals must be the curator's own judgment (metadata.interest.score set at ship time), with heuristics only as fallback ordering.",
     "data/preference-insights.md generalized product mechanism an opaque scoring system for bumping feed items and explicitly preferred the curation agent deciding what is important.' Dan 2026-06-10 asked for a stored interestingness score - synthesis: persist the curator's judgment.",
     "Submit accepts metadata.interest {score 0-1, reason}; carry-forward scoreBreakdown.curatorInterest weighted dominantly (x2.5).",
     "established-by-user", "fixed-2026-06-10"),
    ("feed_ordering",
     "The slate interleaves curator thread blocks and carry-forward blocks by effective (durability-decayed) interest: a fresh batch item leads only when it genuinely outscores the unviewed backlog. Carry-forwards keep visible 'Still unread:' rationales.",
     "Dan 2026-06-11: top entries an hour old 'is not finding older interesting tweets for me to look at right away'. Superseded the fixed insert-after-slot-2 design on 2026-06-11.",
     "arrange route block merge; carry_forward_audit fields; top slate mixes batches when backlog outscores fresh.",
     "established-by-user", "fixed-2026-06-11"),
    ("feed_ordering",
     "Interestingness is judged AS IF FRESH (score 0-1) with explicit durability (evergreen/dated/news); ranking applies durability decay at display time. Anchors: a 6-week-old coding-model hot take is 'totally out of date'; older mechanism/epistemology content stays worth seeing.",
     "Dan 2026-06-11 verdicts on the May-3 Codex tweet ('totally out of date') and Apr-22 Tim Cook tweet ('total nonsense') vs 'older interesting tweets' being welcome. Rubric: docs/interestingness-rubric.md.",
     "metadata.interest {score, durability}; durabilityDecay() in feed-carry-forward.ts; scoreBreakdown.effectiveInterest dominates (5x) with legacy proxies as near-tie breakers only.",
     "established-by-user", "fixed-2026-06-11"),
    ("feed_ordering",
     "A lone carry-forward never ships under its original thread banner ('pulling up a single old tweet and throwing it inside of a thread... total fail'); banners require 2+ promoted members, singletons go to the shared Still-worth-seeing lane.",
     "Dan 2026-06-11 verbatim. Implemented in arrange block merge.",
     "Promoted singleton rows have thread_id='carry-forward-unread'.",
     "established-by-user", "fixed-2026-06-11"),
    ("meta",
     "Every curated item carries metadata.interest. History was bootstrap-scored against docs/interestingness-rubric.md (scoredBy claude-bootstrap-20260611, 9,666 items); curator-stamped scores always win over bootstrap; unscored fresh items default to 0.55 and are counted in carry_forward_audit.unscoredFreshCount as a compliance signal.",
     "Dan 2026-06-11: 'you are the ultimate judge but get the system and algorithms and instructions working so that this all works autonomously without you.' Mechanism top-20 matched judge benchmark 16/20 strict, 20/20 within benchmark top-50.",
     "select count(*) from feed where json_extract(metadata,'$.interest.score') is null and parent_id is null -> ~0; audit unscoredFreshCount stays near 0 across curations.",
     "established-by-user", "fixed-2026-06-11"),
    ("feed_ordering",
     "Each arrange clears all previous display orders and writes the new slate; if the curator skips arrange, feed sort falls back to created_at within 12h so stale orderings do not persist.",
     "src/lib/db/feed.ts arrangeFeedDisplay; turn 2026-05-20: 'If the curator skips arrange, the feed sort falls back to created_at_ms within 12h.'",
     "SELECT COUNT(*) FROM feed WHERE display_order IS NOT NULL == latest run ordering_count.",
     "established-by-user", "verified-2026-06-10"),
    ("feed_ordering",
     "New/pending posts merge through the feed ordering logic on reveal; they must not blind-prepend and wreck curated editorial order.",
     "Fix landed 2026-06-07 (commit 02347017 era); Dan complaint: new posts prepending broke arranged order.",
     "UI: 'N new posts' banner reveal keeps arranged priority; page.test.tsx covers merge.",
     "established-by-user", "verified-2026-06-07"),
    # --- Curation volume & quality ---
    ("curation_volume",
     "A full curation cycle ships about 40-50 items across 4-7 named threads unless a concrete limiting reason is recorded.",
     "Dan 2026-06-07: 'My intent was for 40-50 items I believe - big difference!'; curation-prompt.default.md; AGENTS.md.",
     "curation_log recent successes: items_added in ~40-50; smaller runs must carry volumeAudit.ifNot_explanation.",
     "established-by-user", "verified-2026-06-10"),
    ("curation_volume",
     "An automated cycle below the 25-item floor without a volumeAudit explanation is rejected (HTTP 422) and logged failed - never masked as success.",
     "submit route assessAutomatedCurationCompletion + route tests; Dan: underfilled 'successes' were masking failures.",
     "POST small batch without explanation -> 422; curation_log completionStatus='failed'.",
     "established-by-user", "verified-2026-06-10"),
    ("curation_volume",
     "Tweets are the majority of shipped content; at least half of each thread's non-analysis items when the pool supports it. Prefer the tweet as primary when sources overlap.",
     "curation-prompt.default.md: 'tweets are the heartbeat of the feed'; 'A cycle with 18 articles and 1 tweet is structurally wrong.'",
     "Per cycle: count type='tweet' vs others among shipped items.",
     "established-by-user", "open"),
    ("curation_volume",
     "Every shipped item belongs to a validated thread (metadata.thread.threadId); no standalone items to pad volume.",
     "curation-prompt.default.md: 'Threads are the unit of shipment.'",
     "Recent cycle items: metadata.thread.threadId non-empty for all.",
     "established-by-user", "open"),
    ("curation_volume",
     "sourceId dedupes the feed: the same source item never appears twice.",
     "runtime-output-contracts.md: sourceId UNIQUE dedup key.",
     "SELECT source_id, COUNT(*) FROM feed GROUP BY source_id HAVING COUNT(*)>1 -> empty (for non-null).",
     "established-by-user", "open"),
    ("curation_volume",
     "Bridge/threadRationale are short plain-English phrases (~5-8 words, hard cap ~10), grounded in a specific claim, mechanism, number, or named actor; no invented jargon.",
     "curation-prompt.default.md; curate.md pre-POST word-count check: 'any single one over 10 fails the batch.'",
     "Word-count recent reasons/rationales; spot-check grounding.",
     "established-by-user", "open"),
    ("curation_volume",
     "Quality gate is mechanism-first: include what explains/tests/sharpens an idea; skip vibe, outrage, tribal signaling, propaganda, snark, link-dropping, vendor promo pages, low-engagement HN (<10 score, ~0 comments).",
     "curation-prompt.default.md; Dan's feedback tags ('propaganda', 'boring') in preference data.",
     "Spot-check shipped items against gate; no lowScoreHnOverride-style fields.",
     "established-by-user", "open"),
    ("curation_volume",
     "Article text is the source's own synopsis (og:description), never agent paraphrase; tweet text is verbatim; analysis ends with ## Sources / ## References and makes a concrete claim.",
     "runtime-output-contracts.md text semantics by type.",
     "Compare recent article text vs og:description; check analysis endings.",
     "established-by-user", "open"),
    ("curation_volume",
     "Fetch rules: 404/page-unavailable -> skip; strict paywall -> skip; partial paywall with visible blurb -> keep.",
     "runtime-output-contracts.md.",
     "Review cycle logs for fetch errors absent from shipped list.",
     "established-by-user", "open"),
    ("curation_volume",
     "Retweets attribute the original author in source fields; the retweeter is mentioned only in reason.",
     "runtime-output-contracts.md.",
     "Find RT items; check metadata author vs reason.",
     "established-by-user", "open"),
    # --- Threads & UI ---
    ("threads_ui",
     "Connector/thread headings with short curator descriptions are visible in the feed. They are part of the UI contract, never removable as 'metadata'.",
     "Dan 2026-05-27: 'threads have disappeared from the feed. the connector headings with the quick description of why curator included it are gone.'",
     "Browser: thread heading rows render above grouped items.",
     "established-by-user", "verified-2026-06-10"),
    ("threads_ui",
     "Primary (parent) feed items never disappear from the feed; thread grouping and child/context rows must preserve navigability.",
     "AGENTS.md: 'without making accepted primary items disappear.'",
     "Apply each filter; thread parents stay visible; child rows don't occupy display slots.",
     "established-by-user", "verified-2026-06-07"),
    ("threads_ui",
     "Feed filters (All/Agent/Tweet/Article/Analysis/Suggestion/Notification) keep content cards first; conversation/session cards and stale rows must not jump above real feed content.",
     "Fixed and browser-verified 2026-06-07; Dan complaint about filter switching surfacing conversation cards.",
     "Switch filters in browser; first rows are content cards in arranged order.",
     "established-by-user", "verified-2026-06-07"),
    ("threads_ui",
     "Reflection/system rows never leak into curated display slots.",
     "Commit ba693bcc 'keep reflections out of arrange backstop'; carry-forward SQL excludes reflection-% ids and reflectionCycle metadata.",
     "No display_order on reflection rows; none in arranged slate.",
     "established-by-user", "verified-2026-06-10"),
    ("threads_ui",
     "Load-more reachability: the next page of curated content loads when the reader nears the end of loaded content. Trailing surfaces (session cards, suggestion groups) must never sit between the reader and more curated items.",
     "2026-06-10 browser finding: the scroll sentinel sat below ~22 stale session cards (~10,000px), so arranged slate items 21-56 were unreachable by normal scrolling. Sentinel moved before the conversation tail (page.tsx).",
     "Browser: scroll to last content card; next content page loads within ~1 viewport. div.h-2 sentinel sits directly after last content entry.",
     "established-by-user", "fixed-2026-06-10"),
    ("threads_ui",
     "All-feed session gating: outside the Agent tab, a session card earns a timeline slot only with real recent activity (messages > 0, active within ~48h). Empty shells and long-idle dev sessions live under the Agent filter only.",
     "Dan 2026-05-18: 'I'm still seeing random chat agent session cards show in the main feed. what's going on?'; 2026-06-10 finding: 22 idle/0-message dev sessions (Session 58-64, PONG, YOLO) piled below the curated feed.",
     "All view: no 'Conversation ready / 0 messages' or >48h-idle session cards. Agent view: all sessions present.",
     "established-by-user", "fixed-2026-06-10"),
    ("threads_ui",
     "Analysis tab purity: only editorial analysis cards (concrete claim, Sources). Reflections and legacy transparency/curation-readout/cycle-status rows are process notices - Notification at most, never Analysis.",
     "May-21 commit deleted the transparency-card mandate; rows persisted (thread ids *transparency*, curation-readout-*). Reflection rows drifted to metadata.mode='reflection', evading the reflectionCycle guard. Both leaked into the Analysis tab top (2026-06-10 browser finding).",
     "GET /api/feed?type=analysis: no reflection-% ids, no transparency/readout thread ids; isReflectionFeedItem + isLegacyTransparencyCard cover all metadata shapes.",
     "established-by-user", "fixed-2026-06-10"),
    # --- Cadence & sources ---
    ("cadence_sources",
     "Curation cadence is adaptive between min and max intervals (config: ~2-6h; heartbeat-core constants); gaps beyond max interval must be explainable from runtime evidence (trigger or documented backoff).",
     "data/config.md min 2h max 6h; AGENTS.md cadence invariant; Dan 2026-05-28: 'get the end result of the curation frequency working the same as before the openclaw migration.'",
     "curation_log gaps > max interval need an associated reason (failed cache refresh, downtime).",
     "established-by-user", "open"),
    ("cadence_sources",
     "Source caches (twitter/hackernews/substack/youtube) refresh before a full curation consumes them; a timed-out pre-curation refresh fails the run honestly (503), never papered over.",
     "Pre-curation cache refresh pipeline (commit cde1efe4); curation_log failures show 'pre-curation cache refresh timed out... Pending sources: ...'.",
     "browse_cache_refresh_runs recency vs curation start; failed runs carry the timeout reason.",
     "established-by-user", "verified-2026-06-10"),
    ("cadence_sources",
     "The curator agent is the single editorial brain: skills, channels, and sources never push directly into the feed.",
     "data/openclaw-companion-master-plan.md: 'Every feed item is a curator decision.'",
     "All feed inserts go through curate submit; no source-direct writes.",
     "established-by-user", "open"),
    # --- Read/viewed semantics ---
    ("read_viewed",
     "A view requires ~2s continuous visibility (IntersectionObserver), debounced 30s, deduped per session. Quick scroll-past is not a view.",
     "content-card.tsx VIEW_INTERACTION_VISIBLE_MS=2000, VIEW_INTERACTION_DEBOUNCE_MS=30000.",
     "Scroll-past records no interaction; 2s+ dwell records one 'view'.",
     "established-by-user", "open"),
    ("read_viewed",
     "Views are neutral (unread/no-feedback), never negative signals. Positive engagement = expand/like/thread feedback. Absence of interaction must not downgrade existing preference lanes.",
     "Dan 2026-05-28: 'Views are not negative feedback; expands/likes/thread feedback are stronger signals'; preference-insights.md.",
     "Preference pipeline treats view-only as neutral; carry-forward only excludes interacted items from candidacy.",
     "established-by-user", "open"),
    # --- Meta / process ---
    ("meta",
     "Evogent is an anti-algorithm personal feed: the curator browses your sources and shows what YOU want, learning what you are trying to understand. Editorial quality over engagement mechanics.",
     "README first commit: 'shows you what you want to see, not what the algorithm wants you to see'; AGENTS.md.",
     "Product-level: judge changes against this framing.",
     "established-by-user", "open"),
    ("meta",
     "Evogent work starts from the canonical intent ledger (query_relevant_intent.py) before changing curation/feed/threads/cadence; scratch ledgers are never canonical; audit artifacts are working notes, not primary evidence.",
     "docs/intent-ledger.md; AGENTS.md Intent Ledger Contract; Dan's 2026-06-07 scratch-ledger correction.",
     "data/intent-audits artifact exists for each repair; ledger refreshed after meaningful new chat/commits.",
     "established-by-user", "verified-2026-06-10"),
    ("meta",
     "Dynamic curation completion is recorded truthfully: failed runs stay failed/recoverable; arrange-only cycles close as successful_empty with explicit reason.",
     "Commits 13d41c35, 78a1a261; submit/arrange completion paths.",
     "curation_log completion_status distribution matches reality.",
     "established-by-user", "verified-2026-06-10"),
]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", default=DEFAULT_DB)
    args = parser.parse_args()

    conn = sqlite3.connect(args.db)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS intent_contracts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            seed_source TEXT NOT NULL,
            area TEXT NOT NULL,
            statement TEXT NOT NULL,
            evidence TEXT,
            verify_hint TEXT,
            confidence TEXT,
            status TEXT,
            updated_at TEXT
        )
    """)
    now = datetime.now(timezone.utc).isoformat()
    conn.execute("DELETE FROM intent_contracts WHERE seed_source = ?", (SEED_SOURCE,))
    conn.executemany(
        """
        INSERT INTO intent_contracts
            (seed_source, area, statement, evidence, verify_hint, confidence, status, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        [(SEED_SOURCE, *row, now) for row in CONTRACTS],
    )
    conn.commit()
    count = conn.execute(
        "SELECT COUNT(*) FROM intent_contracts WHERE seed_source = ?", (SEED_SOURCE,)
    ).fetchone()[0]
    by_area = conn.execute(
        "SELECT area, COUNT(*) FROM intent_contracts WHERE seed_source = ? GROUP BY area ORDER BY 2 DESC",
        (SEED_SOURCE,),
    ).fetchall()
    conn.close()
    print(f"seeded {count} contracts into intent_contracts ({args.db})")
    for area, n in by_area:
        print(f"  {area}: {n}")


if __name__ == "__main__":
    main()

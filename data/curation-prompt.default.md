# Curation Prompt

## Philosophy

Curate in the spirit of good explanations. Knowledge grows through bold conjectures and critical feedback. A good explanation is "hard to vary" - its details are essential, not arbitrary.

## Interests

Infer my interests from `preferences-context.md` and `preference-insights.md`. Don't assume a fixed list - let engagement signals guide you. If I engage heavily with someone who talks about a topic, that's an interest. Follow the thinkers I keep returning to, not just the topics they talk about.

If preference data is sparse (new user), curate broadly across technology, science, ideas, and current events. Let engagement refine the mix over time.

## Quality Gate

Include content that explains, tests, or sharpens an idea: mechanism, causality, incentives, second-order effects, non-obvious connections, or specific claims that could be checked. Short but sharp takes clear this gate when they compress a real insight.

Skip content that is mostly vibe, outrage, tribal signaling, propaganda, snark, link-dropping, event transcription, celebrity churn, generic tutorials, shallow explainers, or easy-to-vary claims.

For analysis posts, make a concrete claim, clearly mark uncertainty, and end with `## Sources` or `## References`.

## Analysis Style Preferences

- Mechanism-first. Explain the system dynamics, incentives, and second-order effects.
- Separate observed facts from interpretation.
- Connect short-term events to long-term structural shifts.
- Prefer specific claims that can be checked against sources.
- Contrarian is good when backed by evidence.
- Write with confidence, not hedging.

## Source URLs

- Only cite URLs that came from this cycle's inputs: browse-cache items, feed scratchpad items, article URLs you fetched, or web-search result URLs returned this cycle.
- Never construct a URL from memory or from a plausible pattern. If the URL was not in the inputs, do not write it.
- Format each source line as `- [Descriptive label](https://...)` or as a bare `https://...`. Do not write `label: url`.
- When a cited source has no URL in the inputs, cite it without a link. Example: `- @gdb's introduction of ChatGPT for Clinicians`.
- A source without a URL is a smell. It usually means the source was not actually in this cycle, and the analysis should probably be skipped.

## Article Cards

Article body cards quote the source, not the agent. Before submitting ANY article, fetch the URL. The fetch result decides whether the article ships at all:

- Fetch returns 404, page-not-found, or page-unavailable: SKIP. Do not include it in the cycle. Do not invent a synonym URL.
- Fetch returns a strict paywall with no visible blurb: SKIP. Strict paywall means login wall only, with no og:description, no visible standfirst, and no lede paragraph above the wall. The user does not have subscriptions to most paywalled outlets.
- Fetch returns a partial paywall with a visible blurb: KEEP. Visible blurb means og:description is present, or there is a visible standfirst/dek, or there is a lede paragraph above the wall. Use that visible blurb verbatim as both `text` and `excerpt`. WSJ is the canonical case.
- Fetch returns a clean public page: KEEP. Use og:description, standfirst, or the first real paragraph verbatim as `text` and `excerpt`.

The `text` field MUST NOT be a paraphrase of the title. If you are tempted to write "X is doing Y" as the body when the title says "X did Y", you have not actually fetched the page. Stop, fetch, and use the page's own words.

## Front-page signal sources

For every full /curate, directly browse the WSJ home page, the New York Times home page, and WSJ Opinion/editorials before final thread selection. I do not need subscription-only article bodies; headlines, decks, page placement, and editorial-page framing are useful signals. Treat bigger or more prominent home-page headlines as evidence that the event matters to me.

When WSJ or NYT has a visually dominant current-event lead, treat it as a rare override signal, not a routine requirement. Ask: is this a live public event, policy shock, market shock, war/diplomacy turn, or major elite-institution story? If yes, prefer a fresh top-level thread/update unless there is a clear quality reason to drop it. If no, record the headline in `frontPageSignalAudit` and continue normally. Use direct story wording and `metadata.thread.prominence.level = "lead"` only for accepted lead-level threads.

Use this signal to shape thread detection, follow-up searches, context attachments, and top-level update/probe decisions, especially for current events and elite-opinion shifts. When an accepted lead should affect display, put it on `metadata.thread.prominence` with `level: "lead"`, `source: "homepage"`, compact `evidence`, and optional `homepageUrl`; this emphasizes the thread title, not every child card. Accepted lead thread titles should use the story itself, not curation-status language, and accepted lead rationale should be one plain sentence about what happened. Only use top-level `metadata.prominence` when an individual item itself deserves larger card typography independent of the thread. The article-card fetch rules above also apply to paywalled homepage items: front-page placement remains useful signal for thread shaping, but a standalone card still needs a fetchable URL and source-owned synopsis. Record `frontPageSignalAudit` with pages checked, major headline signals, WSJ editorial signals, and per-lead `{ headline, prominence, action, reason }`; a dropped visually dominant lead must include the headline and a concrete quality reason.

## Balance

Keep the feed diverse across topics and authors. Don't repeat the same angle. Don't flood from one account. Don't let any single topic dominate the feed. 1-2 items from outside usual interests are fine if they pass the quality gate.

## Priority Thinkers

- @example_account1, @example_account2 - add accounts you engage with here
These are boost handles, not a candidate filter: evaluate the full unshipped Twitter cache each cycle, then use Priority Thinkers only to lower the bar once their tweets are already under consideration.

## Current Focus

- Add current topics of interest here

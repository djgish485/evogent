---
metadata:
  evogent:
    user-facing: true
---
Run one lightweight live-gap curation pass in this invocation.

Usage: `/curate-latest [optional focus]`

`$ARGUMENTS` is optional editorial focus supplied by the user. It may narrow
judgment for this pass, but it is never a hard source quota.

## Role and boundaries

- This is the small manual layer between full scheduler-owned `/curate` cycles.
  Close a plausible live gap, make a fresh editorial decision, submit normal
  feed items, and explicitly arrange the result. Do not start a competing full
  cycle or pretend this command reviewed the full browse cache.
- Android is canonical production. Read `.claude/skills/phone-browse/SKILL.md`
  and use the phone's installed source/cache mechanics. Never use a VM browser,
  shared desktop Chrome, ADB, or host-side browsing as the production source.
- Never touch physical display 0. Logged-in app work must use
  `~/phone-tools/phone.sh` on a proved non-zero hidden display. If the hidden
  display is leased, unavailable, or cannot be proved non-zero, leave it alone
  and record that source outcome instead of falling back to the user's screen.
- Resolve `API_BASE` from `MEDIA_AGENT_INTERNAL_BASE_URL`. In the phone profile,
  use `EVOGENT_API_CURL` or `~/phone-tools/evo-curl` for every request to that
  loopback origin; raw `curl`, `urllib`, and other unauthenticated loopback
  clients are forbidden. A non-phone demo may use its configured API client.
- Use `${MEDIA_AGENT_ROOT}` when set and the configured `DATA_DIR`. SQLite is
  the source of truth; JSONL is audit evidence, not a replay or dedup database.
- Read the deployment's private `data/curation-prompt.md`,
  `data/preferences-context.md`, and `data/preference-insights.md` when present.
  Reuse the product laws and submit contract from `.claude/commands/curate.md`
  and `docs/reference/runtime-output-contracts.md`; do not invent a second
  editorial policy.

## Find and close the gap

1. Discover configured sources dynamically from installed source-skill
   frontmatter, phone source recipes, and the distinct sources in
   `browse_cache_refresh_runs` and `browse_cache_items`. Do not begin with a
   hard-coded source list.
2. Find the latest trustworthy completed full-or-lightweight curation boundary
   from terminal SQLite receipts or a prior manual cycle artifact whose matching
   submit receipt is `success`/`successful_empty`. A candidate-log
   `cycle_summary` by itself is not proof of completion. For each source,
   compare that boundary with its latest completed cache refresh. The earlier
   available instant is that source's coverage boundary: it keeps an older
   cache refresh from hiding material that the prior curation could not have
   seen. If neither instant exists, do not invent a timestamp; inspect a bounded
   current surface and record that the baseline was unknown.
3. Use existing unshipped cache rows after each source's coverage boundary as
   evidence. The browse-cache items endpoint is allowed here; cache evidence
   and live evidence are complementary.
4. Choose the smallest useful live check from the actual private context,
   optional user focus, cache coverage, and source outcomes. This is agent
   judgment: no fixed source count, account list, prior-topic loop, or required
   search pattern belongs in this public command.
5. When live evidence is needed, use that source's phone-native instructions.
   Logged-in apps run only through the hidden-display mechanics; public-network
   sources may use their supported on-phone fetch path. Persist newly observed
   raw source items through `/api/internal/browse-cache/submit` before judging
   them for the feed. Release the hidden display when the check is done.

Published time after the source coverage boundary defines the normal live-gap
scope, not editorial value. A source item with no trustworthy published time may
still be considered when this invocation directly observed it; preserve that
uncertainty rather than fabricating a date.

## Judge without quotas

- Judge the gathered candidates against the private model and the same quality
  bar as `/curate`. Mechanics may bound browsing time and payload size, but they
  must not rank or reject by source, account, language, type, popularity, age,
  or thread count.
- Exclude source duplicates and material whose substance is already represented
  in SQLite. Keep strong singles. Prefer diversity only between comparably
  valuable alternatives.
- There is no minimum output, no required source or item type, and no required
  analysis. Do not broaden the search or lower the bar merely to avoid an empty
  result. The primary-slate ceiling remains 50; it is a bound, not a target.

## Submit stable shipments and a truthful receipt

Use one cycle ID stable for this invocation, preferably derived from
`MEDIA_AGENT_TASK_ID`, with a `curate-latest-` prefix.

Every selected root item must follow the normal feed schema and carry:

- a stable `sourceId` and stable feed `id`;
- `metadata.cycleId`;
- agent-authored `metadata.interest` evidence; and
- a stable hidden `metadata.shipment.id` derived from canonical source identity,
  not from position, cutoff time, or batch membership.

Visible thread metadata is allowed only for a truthful topical/event cluster of
2+ unique selected root items. Give such a cluster one stable
`metadata.thread.threadId`, direct title, and short rationale, and preserve that
same ID through arrangement. A singleton has no visible `metadata.thread`; its
arrange entry uses `shipment-singleton:<feed-item-id>` only as a hidden shipment
boundary. If validation leaves one member of a proposed cluster, remove its
visible thread metadata.

Submit through `POST ${API_BASE}/api/internal/curate/submit` with `items`,
optional rejected `candidates`, and a final `cycleSummary` for this exact cycle:

- `considered = selected + rejected`;
- `selected` is the number of selected source identities in the request;
- `topRejectionReasons` contains only reasons actually observed; and
- `metadata.mode` is `curate_latest`, with source coverage/outcome evidence.

A valid terminal submit receipt is a 2xx response with no `errors`, no rejected
or deferred completion, and `accepted + duplicates == cycleSummary.selected`.
Only `accepted` counts as newly shipped. If a partial submit occurs, preserve
the accepted IDs, repair or honestly abandon the rejected inputs, and obtain a
matching final receipt before calling the pass successful. An empty pass still
submits `items: []` and an honest zero-selected summary; zero is not a failure.

## Arrange explicitly

After submission, call `POST ${API_BASE}/api/internal/curate/arrange`, even for
an empty pass. Preserve the relative order of the current displayed shipments
unless fresh judgment justifies placing a new shipment elsewhere; do not
re-rank the old slate with a formula. Include the current displayed root items
and newly accepted root items in explicit order, keep every real thread
contiguous, list only active 2+ member threads in `threads`, and use hidden
singleton shipment IDs for singles.

Treat arrangement as successful only when the response is 2xx with `ok: true`
and its complete-set receipt reports all eligible accepted-unviewed candidates
reviewed. The arrange endpoint may append eligible omissions in stable
mechanical order; this preserves completeness without turning this lightweight
command into a second full curator.

## Reply

For a chat-backed invocation, persist exactly one concise reply through the
normal chat-submit contract. Report the number newly accepted, whether the pass
was empty or partial, and any material source-coverage limitation. Do not call
duplicates newly shipped, expose private source/account details, list every
item, or claim success before both submit and arrange receipts pass.

# Phone efficiency and model routing

Evogent should spend attention where it can change the user's experience. It
must not browse every source on every cycle, invoke a premium model for
mechanical work, or put a model in the push-notification hot path.

This document defines product-wide mechanics. The selected models, source
cadence, benchmark evidence, provider allowance, private content, and personal
routine stay on the phone.

## Work selection

A full cycle is a curation opportunity, not an all-source sweep.

1. Each source has an independent private cadence in
   `data/source-cadence.json`.
2. A cycle browses only sources that are due. A relevant notification may
   refresh one fixed, content-free per-source marker and make only that source
   due early; it does not enter browse cache, wake a cycle, or wake unrelated
   sources. Successful work keeps normal cadence completion-based and
   separately acknowledges only signals covered when that source browse began.
3. Deterministic retrieval and parsing run before agent-driven computer use
   where both can produce the same evidence.
4. A failed, timed-out, or partial browse never advances the source's cadence
   stamp. The next owner can retry it honestly.
5. The daily overseer adjusts cadence from private yield, freshness, attention,
   battery, latency, and provider-use receipts. Mechanics never infer source
   value from a public schedule or a fixed source quota.

The public cadence template is bootstrap-only. It deliberately cannot encode a
person's routine.

## Latency and judgment lanes

| Lane | Default execution | Escalation |
|---|---|---|
| Notification capture, redaction, dedup, and digest | Deterministic, local, no model | Preserve the Android original and surface a health receipt |
| API fetches, timestamps, counts, locks, and validation | Deterministic | Diagnosis agent only after an outcome tripwire |
| Routine hidden-display browse | Terra/medium on a fresh phone; an existing explicit Browse Model is preserved | One-run candidate screening; diagnosis route after repeated anomalous yield |
| One-time source discovery | Independent Sol/high recipe-authoring route on a fresh phone | Explicit supervised candidate only; never inherit browse or curator promotion |
| Feed curation | Sol/high on a fresh phone, independently of ordinary chat | Higher effort only after a measured quality gain or a difficult exceptional slate |
| Cross-cycle review | One bounded high-reasoning overseer per service day | Max/Ultra only for an explicitly divisible, quality-first audit |

The supported runtime-brain APIs and model-facing browse caches exclude
notification content. Only a constant per-source due marker is policy-approved
to cross into scheduling, and the deterministic push path invokes no model.
Current provider workers share the server's Unix UID, so the exclusion is an
API-and-instruction boundary rather than OS isolation from adversarial same-UID
code. Within that stated boundary, the push path stays fast, cheap, private, and
available when the provider is offline.

Agent chat-reply push is a separate deterministic delivery lane. It starts only
after the reply is durable and its audit attempt has finished, then runs without
waiting behind WebSocket publication and without holding the submit response
open. The external body and network deadline are bounded. Foreground
suppression reads a process-epoch-bound singleton presence lease ordered by
page generation and sequence; heartbeats never enter behavioral history, and
stale or ambiguous presence permits an extra push instead of hiding a needed
one.

## Automatic source-diagnosis budget

The barren-source tripwire and warning card remain active for every source, but
all sources share at most one automatic diagnosis attempt per local service
date. The phone records the claim in an atomic mode-`0600` ledger before
launching the provider. A crash or failed provider call therefore spends that
day's slot instead of replaying an expensive diagnosis after restart.
Recent claims stay exact; older dates compact into a bounded fail-closed
boundary, so the private ledger cannot grow forever or reopen an old date after
a clock rollback.

The original first-trip and every-third-barren-cycle thresholds still apply.
When another source has already spent the global slot, the new threshold stays
durably pending, the source's health warning remains visible, and its diagnosis
remains due on a later service date even if the streak count is no longer an
exact multiple of three. A mechanics/provider failure may reset the consecutive
empty counter, but it does not prove recovery and therefore cannot discard a
pending diagnosis. A fresh or deduplicated harvest clears only that source's
pending threshold; it never refunds a daily claim.

This is an automatic-runtime cost boundary, not a restriction on supervised
operator diagnosis. Explicit model and effort overrides still select the route
for the one automatic attempt, and an operator can run a separate diagnostic
directly when immediate investigation is worth the spend.

## Automatic feed enrichment budget

On the phone, feed submission and the legacy JSONL watcher never launch
automatic enrichment agents. Submission still applies exact cached enrichment,
reloads the durable row, and broadcasts the primary card over WebSocket.
Watcher inserts follow the same deterministic cache-first path. Skipping an
agent must not write `queued` or `running` enrichment metadata because no work
was actually requested.

This boundary is independent of the configured Medium or High usage level.
Primary card content is the shipment; replies, related context, and richer
source structure are optional follow-up work. The explicit
`POST /api/feed/[id]/enrich` detail action remains available and launches one
full enrichment request when the user asks for it.

Non-phone runtimes retain automatic enrichment for rows that remain incomplete
after cache hydration: Low usage launches none, while Medium and High batch
only eligible top-level rows in bounded chunks.

## Route resolution

`phone-tools/model_routing.py` resolves each task from:

1. an explicit one-run environment override, used by a benchmark;
2. an enabled private, benchmark-qualified route in `data/model-routing.json`;
3. that task's explicit `data/config.md` headings; then
4. the public safe fallback in
   `phone-tools/model-routing.default.json`.

An explicit `Browse Model` is authoritative. If it is absent, browse preserves
the deployment's existing `Codex Model`; Terra is only the public model fallback
when neither heading exists. Browse reasoning remains independently selectable
through `Browse Reasoning`, with medium as its fallback.

Before phone-owned provider work, `model_routing.py ensure-phone-config` seeds
a genuinely absent config with the complete generic config baseline, then adds
fresh-phone routes: curator/Sol-high, source-discovery/Sol-high,
browse/Terra-medium, and overseer/Sol-high. The on-phone generic baseline is
regression-checked against the shared desktop/VM template.

For an existing config, missing curator, source-discovery, and browse model
headings instead inherit its effective `Codex Model`. Curator reasoning
inherits effective Codex reasoning, including reasoning derived from
`Usage Level`; the browse and source-discovery lanes preserve their prior
medium effort, and overseer preserves Sol/high. Existing headings—including
intentionally blank headings—are never rewritten, so an upgrade cannot
silently replace a deployment choice. A version-only private
`.phone-config-bootstrap.json`, atomically written mode-`0600` beside
`config.md`, records the applied migration through the production
`runtime/data` symlink without storing route values.

Automatic diagnosis is a separate bounded lane. Its policy has no config
inheritance and stays on Sol/high; it cannot inherit an overseer Max/Ultra
choice or consume a private persistent override. A one-run
`EVOGENT_DIAGNOSIS_MODEL` / `EVOGENT_DIAGNOSIS_REASONING` override remains
available for an explicit supervised run, without changing future routing.

Persistent overrides for global browse, YouTube browse, curation, source
discovery, and automatic diagnosis are disabled in both the policy and the
resolver. Existing entries in the private mode-`0600`
`data/model-routing.json` are ignored for those routes, regardless of how many
current receipts exist. This is deliberate: none of today's computer-use
receipt versions binds workload identity to a frozen, blinded private-relevance
review, and the curator harness cannot yet isolate every production side
effect. Explicit environment overrides remain one-run only, so supervised
benchmarks can compare candidates without silently changing routine behavior.

## Benchmark protocol

Cheaper is better only after equivalent outcomes are proven.

### Computer use

Run the grounded micro-benchmark first:

```bash
EVOGENT_BENCH_ROUNDS=3 \
  ~/phone-tools/benchmark-cu-micro.sh \
  '<current-model>@<current-effort>' \
  '<candidate-model>@<candidate-effort>'
```

Each back-to-back round starts from a cold app launch. The model reports five
visible items, then the harness independently re-reads the accessibility tree
and verifies all five strings are grounded there. Raw titles and responses live
only in a mode-`0600` temporary directory and are erased. The durable JSONL
receipt contains only model/effort, timing, counts, status, and a one-way case
digest. These receipts use the non-production `browse_micro` task and are
marked `grounded_micro`: they are a screening gate and can never qualify a
persistent production browse route, including if the router is rolled back to
a schema-v1 version that filters receipts by task alone.

Only after the micro-task passes is the live full-browse smoke test worth
running:

```bash
EVOGENT_BENCH_ROUNDS=3 \
  ~/phone-tools/benchmark-browse-models.sh \
  '<current-model>@<current-effort>' \
  '<candidate-model>@<candidate-effort>'
```

Every full-browse attempt gets a unique run ID and exact start time in the
model's prompt. Immediately before each Android share, the model calls the
bounded helper to arm one private random token through the authenticated APK
control channel. The share receiver consumes that arm synchronously, before
asynchronous ingest, and writes one content-free per-share refresh receipt
binding the run, sequence, token digest, source-ID digest, and exact fetch time.
The model must confirm that exact receipt before arming the next share. Ordinary
shares retain their original ingest shape.

Finalization accepts only consecutive confirmed receipts for distinct complete
videos, writes one schema-v2 terminal receipt, and never attributes rows merely
because their timestamps happen to fall inside the run window. The harness
independently re-reads the terminal receipt and every referenced per-share
receipt after the model exits. Unrelated ambient rows are ignored; a delayed
row cannot substitute for a missing token-bound receipt. A zero CLI exit, an
ambient timestamp match, or a self-reported count is never terminal proof.

This remains screening evidence. Baseline and candidate drive a live,
sequential recommendation surface, so they do not see an identical workload;
successful canonical shares also prove mechanics and completeness, not whether
the chosen videos fit the private taste model. The exact receipt pair is
therefore `browse_youtube_smoke_v1` /
`full_browse_youtube_smoke`, and routing rejects it. Historical
`browse_youtube_full_v1` / `full_browse_youtube`,
`browse_full_v2` / `full_browse`, and legacy `browse` rows are likewise not
current production proof.

Existing `browse_mixed_full_v3` / `full_browse_mixed` rows are also screening
evidence, not production proof: that receipt version has no frozen, blinded
private-relevance review binding. A future qualifying harness must introduce a
new versioned task/kind pair, give both sides the same frozen candidate
workload, blind route labels during explicit private-relevance review, and bind
that review to the content-free pair receipt. Driver mechanics, relevance,
fresh yield, latency, and total token use remain independent gates. Raw titles,
source IDs, preference evidence, and model output never enter the benchmark
ledger.

### Curation

Curation quality cannot be reduced to output count, thread count, or latency.
The production-phone curation harness is intentionally unavailable and exits
before writing state. Its former database-only restore was not a real sandbox:
a full cycle also mutates JSONL audit streams, preferences, provider sessions,
control-plane files, and the visible feed. Running alternate curators there
could race the scheduler or recontaminate a restored database.

Keep the configured curator baseline pinned. Do not add a private `curator`
route or synthesize qualification receipts from counts. A future harness must
run a separate private runtime/data/session/control-plane clone on its own
loopback port, publish nothing to the production feed, and capture exact
cycle-bound candidate, selection, reason, and terminal-receipt deltas.

The router retains a dormant, downgrade-safe evidence validator for that future
isolated runner: the exact versioned receipt pair
`curator_full_v2` / `full_curation_snapshot`, at least three recent paired
baseline/candidate rounds, no mechanics or role-integrity failure anywhere in
the suite, and an explicit private artifact review for each quality label. The
receipt task deliberately differs from the production `curator` route, so a
rollback to the prior task-only router ignores proof whose artifact-review and
suite-wide mechanics laws it does not understand. Each passing row must also
prove a nonempty full candidate snapshot, an exact terminal result, and a
run-bound digest. Receipts retain only model, effort, status, numeric mechanics,
review time, and one-way artifact/run digests. Legacy `curator`, browse,
grounded-micro, mislabeled, expired, unreviewed, or content-bearing rows fail
that validator. Until the isolated harness exists, neither those receipts nor a
private route entry can override the configured curator baseline.

For routes with an enabled safe qualifying harness, promote one at a time.
Re-run a representative natural cycle after every promotion and revert
immediately on degraded yield, bad judgment, excessive latency, or phone
responsiveness loss.

## Daily overseer

The scheduler runs at most one bounded private overseer per service day using
the configured `overseer` route. It falls back to the current Sol family at high
reasoning. Max is an explicit operator choice for especially difficult reviews.
Ultra is likewise explicit and useful only when the review genuinely divides
into independent workstreams; neither can be selected by the overseer through
the private persistent route file.

The overseer reads user-visible feed state plus aggregate source, cycle,
notification, latency, benchmark, and interaction receipts. It may atomically
tune private source cadence and preference synthesis. It may report candidate
model screening results, but it must not write a global-browse, YouTube-browse,
curator, or overseer route while the qualifying harnesses are unavailable. It
never drives an app, edits product code or committed instructions, or launches
a development agent on the phone. Observable product or instruction failures
become directional `code_fix` suggestions for host review.

The overseer replaces overlapping daily reflection/dream work. Do not run three
broad reviews over the same evidence.

## Verification

Before enabling any future cheaper persistent override:

1. Prove three workload-equivalent paired benchmark passes with no
   mechanics-failed pair and an explicit blinded private-relevance review.
2. Inspect that receipts contain no source text, account data, or model output.
3. Run one hint-free full cycle and verify its exact terminal receipt.
4. Confirm only due or signalled sources ran.
5. Inspect the feed at the glass for actual editorial quality.
6. Observe one natural scheduled cycle and one natural notification.
7. Confirm provider failure leaves notifications working and restores the
   previous proven model route.

The grounded micro and live YouTube smoke tests can still compare latency,
token use, driver reliability, and complete yield. Report those results as
screening evidence; never turn current `browse_micro`,
`browse_youtube_smoke_v1`, or `browse_mixed_full_v3` rows into a route
override.

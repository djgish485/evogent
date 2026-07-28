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
| Routine hidden-display browse | Cheapest route that passed the real computer-use benchmark | Current proven route on failure; diagnosis route after repeated anomalous yield |
| Feed curation | Strong editorial route with a truthful terminal receipt | Higher effort only after a measured quality gain or a difficult exceptional slate |
| Cross-cycle review | One bounded high-reasoning overseer per service day | Max/Ultra only for an explicitly divisible, quality-first audit |

Notification content never goes to the runtime brain or a model-facing browse
cache. Only a constant per-source due marker crosses into scheduling. That keeps
the push path fast, cheap, private, and available when the provider is offline.

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
2. a private, benchmark-qualified route in `data/model-routing.json`;
3. the deployment's existing `data/config.md` headings; then
4. the public safe fallback in
   `phone-tools/model-routing.default.json`.

Routine private overrides are fail-closed. The route falls back to its existing
configured baseline unless the referenced phone-local benchmark suite has at
least three recent paired rounds in which both baseline and candidate passed
mechanics and quality. A receipt's declared baseline/candidate role must agree
with the side implied by its exact model and effort; a mismatch or duplicate
side makes the suite an integrity failure. Any mechanics failure invalidates
that suite without being counted as a model-quality failure. Old evidence
expires, so an unrevalidated cheap route cannot silently become permanent after
the app, provider, or phone changes.

The private route file is mode `0600` and contains no source content:

```json
{
  "schemaVersion": 1,
  "routes": {
    "browse": {
      "model": "<candidate-model>",
      "effort": "low",
      "qualification": {
        "suiteId": "<phone-local-benchmark-suite>"
      }
    }
  }
}
```

Deleting one route entry immediately restores its configured baseline.

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

Only after the micro-task passes should the full browse benchmark run:

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

Only content-free receipts with the exact versioned task/kind pair
`browse_full_v2` / `full_browse` are eligible to qualify production. The task
name deliberately differs from the production route: rolling back to the prior
task-only router makes it ignore evidence whose 80/120 equivalence laws it does
not understand. Every paired row must carry the verified terminal proof,
at least one fresh complete row, elapsed time, and a one-way run digest. Within
each passing pair, candidate fresh yield must be at least 80 percent of the
baseline and candidate elapsed time must be no more than 120 percent of the
baseline. A missing or invalid terminal proof is a mechanics failure and
invalidates the suite; an outcome or latency miss cannot count as a paired
quality pass. Raw titles, source IDs, and model output never enter the benchmark
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

The router already reserves the downgrade-safe evidence contract for that
future isolated runner: the exact versioned receipt pair
`curator_full_v2` / `full_curation_snapshot`, at least three recent paired
baseline/candidate rounds, no mechanics or role-integrity failure anywhere in
the suite, and an explicit private artifact review for each quality label. The
receipt task deliberately differs from the production `curator` route, so a
rollback to the prior task-only router ignores proof whose artifact-review and
suite-wide mechanics laws it does not understand. Each passing row must also
prove a nonempty full candidate snapshot, an exact terminal result, and a
run-bound digest. Receipts retain only model, effort, status, numeric mechanics,
review time, and one-way artifact/run digests. Legacy `curator`, browse,
grounded-micro, mislabeled, expired, unreviewed, or content-bearing rows cannot
qualify the curator route.

For routes with an enabled safe benchmark harness, promote one at a time.
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
tune private source cadence, preference synthesis, and a benchmark-qualified
model route. It never drives an app, edits product code or committed
instructions, or launches a development agent on the phone. Observable product
or instruction failures become directional `code_fix` suggestions for host
review.

The overseer replaces overlapping daily reflection/dream work. Do not run three
broad reviews over the same evidence.

## Verification

Before calling a cheaper route production-ready:

1. Prove three paired benchmark passes with no mechanics-failed pair.
2. Inspect that receipts contain no source text, account data, or model output.
3. Run one hint-free full cycle and verify its exact terminal receipt.
4. Confirm only due or signalled sources ran.
5. Inspect the feed at the glass for actual editorial quality.
6. Observe one natural scheduled cycle and one natural notification.
7. Confirm provider failure leaves notifications working and restores the
   previous proven model route.

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
2. A cycle browses only sources that are due. A relevant notification may make
   its one source due early; it does not wake unrelated sources.
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

Notification content never goes to the runtime brain. That keeps the push path
fast, cheap, private, and available when the provider is offline.

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
mechanics and quality. Any mechanics failure invalidates that suite without
being counted as a model-quality failure. Old evidence expires, so an
unrevalidated cheap route cannot silently become permanent after the app,
provider, or phone changes.

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
digest.

Only after the micro-task passes should the full browse benchmark run:

```bash
EVOGENT_BENCH_ROUNDS=3 \
  ~/phone-tools/benchmark-browse-models.sh \
  '<current-model>@<current-effort>' \
  '<candidate-model>@<candidate-effort>'
```

The full benchmark measures a durable refresh receipt, freshly written rows,
canonical links, titles, and elapsed time. Counts come directly from SQLite,
never from a capped endpoint.

### Curation

Curation quality cannot be reduced to output count, thread count, or latency.
Run candidates against the same cache snapshot, preserve a private comparison
artifact long enough for the high-reasoning overseer or user to judge the
actual choices and reasons, then keep only the content-free receipt. A timeout,
missing terminal receipt, or failed restore is mechanics failure and receives
no quality score.

Promote one route at a time. Re-run a representative natural cycle after every
promotion and revert immediately on degraded yield, bad judgment, excessive
latency, or phone responsiveness loss.

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

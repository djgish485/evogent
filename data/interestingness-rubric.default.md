# Interestingness Judgment Context (template)

Evogent may persist a runtime agent's supporting content judgment in
`metadata.interest`. That metadata is evidence, not a scoring formula or
display-ranking algorithm. Shipment and ordering are fresh decisions made by
the runtime agent over the complete eligible set. This file is the TEMPLATE.
The live, per-user context is `data/interestingness-rubric.md` — it is private
runtime data, never committed, and is maintained from the deployment's own
signals.

## How the private context is built

At setup (and refined by reflection cycles thereafter), the agent builds the
private context from imported signals, in-app reactions, thread feedback,
hides, and chat feedback. Fill in sections marked USER with compact,
current synthesis and aggregate evidence counts. Keep raw excerpts and
attributed evidence only in private runtime state.

Reconsider every candidate in the current cycle. No stored number, account
label, or age rule is permission to ship or a substitute for ordering.

## Two supporting descriptors per item

- **score**: a normalized ordinal summary of the agent's content-value judgment
  at the time it was written. It is not a calibrated probability, target
  distribution, engagement prediction, or automatic rank.
- **durability**: `evergreen` | `dated` | `news`, a descriptive cue for how soon
  the claim should be reconsidered. Mechanics do not apply a decay curve.

## Judgment anchors

Use higher values only to express stronger agent judgment within the batch being
reviewed. Do not force a distribution, threshold, minimum shipment count, or
fixed source/type/account mix. A current explicit `ship` or `hold` decision and
the agent's arrangement order remain authoritative.

## Topic patterns (USER)

Record compact positive patterns derived from private evidence. These are
context for examining actual substance, never guaranteed lanes or quotas.

## Source context (USER)

Private evidence may help the agent interpret an author's history or expertise,
but account identity, tier, follow state, and favorite status never add an
automatic prior or guarantee inclusion. Judge the actual candidate.

## Content-shape evidence (part product, part USER)

Look for substantive material supported by specific evidence or useful
reasoning. Tune content-shape interpretation from private feedback rather than
a checked-in topic or stylistic taste list.

Usually hold deceptive promotion, unsupported or effectively content-free
items, and repetitive coverage already represented in the slate. The user's
own posts are signals to learn from rather than items to resurface. All other
shape, language, and topic exclusions belong in the private live context.

## Durability classes

- **evergreen** — the central claim can remain useful across many normal update
  cycles.
- **dated** — usefulness depends on a current version, live debate, or changing
  conditions.
- **news** — value is closely tied to a recent event or time-bound result.

Tie-break question: does the item's claim survive the next normal update cycle?
If no, it is news. The label asks the next agent to reconsider; it does not
mechanically demote the item.

## Calibration notes (USER)

Calibration is comparative and cycle-local. Do not translate attention,
popularity, source, account, or content type into a deterministic boost. Stored
scores may be stale; the current agent must inspect the content and decide
again.

## Context evolution

Reflection cycles and new feedback update the private live context while
preserving reversible synthesized anchors. Runtime agents and metadata
backfills may read it, but a backfilled score never ships, holds, promotes, or
reorders an item. Raw evidence never moves from private runtime state into
public defaults or history.

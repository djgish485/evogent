# Evogent intent ledger

Evogent separates public product intent from one deployment's private evidence.
That boundary matters more now that the canonical runtime is a personal phone.

## Canonical public artifacts

- `.intent/contracts.jsonl` — product-wide laws in force
- `.intent/backlog.jsonl` — append-oriented decisions, findings, and open work
- `.intent/failure-modes.jsonl` — general failure classes and their repair loops

These files travel with the repo. They must be useful to any Evogent user and
must not contain a person's email, device serial, account handle, messages,
contacts, local address, or private taste instance.

Run `npm run privacy:check` before publishing. The gate also rejects
`kind: "preference"`, direct evidence, and rows without an explicit
`privacy_scope: "product-wide"` in the public backlog. Contract evidence must
cite public docs, tests, or mechanisms. The public audit file is a boundary
stub; raw runtime audits belong under ignored private data paths, not
`.intent/audit-log.jsonl`.

`.intent-ledger/evogent-intent-ledger.sqlite` is an optional **private evidence
index**. It can combine local chats, git history, device DB snapshots, and other
evidence for a development environment. It is not required for a fresh checkout,
is not the public source of truth, and must not be committed. Keep any report or
summary derived from private evidence private unless it is deliberately
sanitized. For deployment questions, only the canonical phone's live runtime
state and private evidence with clear phone provenance are authoritative; an
older host snapshot remains a convenience copy.

Product laws answer “what should hold for every user?” Personal taste, account
tiers, learned preferences, cadence, and private history belong in the phone's
`data/` and SQLite state. A local observation can motivate a general ledger entry,
but the entry records the general mechanism or failure class rather than the
person's identifying evidence.

Contract history is append-only. Older rows without a `key` receive a stable
key derived from their area and statement. A revision repeats its stable key
and explicitly lists that key in `supersedes`; a replacement may also list
other already-known keys. The last valid record for a key wins. Superseded rows
remain in JSONL and in the derived history table, but queries, laws, audits, and
the active `intent_contracts` index ignore them. Run
`python3 scripts/intent/contract_ledger.py .intent/contracts.jsonl` to validate
the chain; unknown targets, silent duplicate keys, duplicate replacement, and
malformed tombstones fail closed.

## Required Workflow

Before changing behavior, always search the committed JSONL. If the optional
private index exists and the task benefits from historical evidence, also run:

```bash
python3 scripts/intent/query_relevant_intent.py \
  "<the user's concern in their own words>"
```

That wrapper keeps the user's wording, adds Evogent's guardrail wording, and
includes local vector evidence. It writes a private audit artifact under
`data/intent-audits/`.

The lower-level equivalent is:

```bash
python3 scripts/intent/ledger_query.py audit \
  --query "<user wording for the current problem>" \
  --query "phone runtime full eligible set private judgment maximum 50 no minimum stable thread singleton completion receipt" \
  --vector
```

Use the resulting audit as local evidence. Generated audit artifacts are not
primary evidence and do not belong in public commits. If the private index is
absent, continue from `.intent/*.jsonl`; do not recreate it from personal device
data merely to satisfy a workflow checkbox.

After meaningful new chat, commits, or docs, update a private index when present:

```bash
python3 scripts/intent/update_intent_ledger.py --git --docs
```

That full refresh is a maintenance step, not the prerequisite for every edit.
Because `--git` inspects reachable commits and may rebuild FTS, use a targeted
refresh for ordinary repair work when only recent evidence matters:

```bash
python3 scripts/intent/update_intent_ledger.py --docs --skip-fts-rebuild
python3 scripts/intent/update_intent_ledger.py --git --since "<YYYY-MM-DD>" --docs --skip-fts-rebuild
```

To ingest a Codex transcript explicitly into the private index:

```bash
python3 scripts/intent/update_intent_ledger.py --codex-session-jsonl /path/to/session.jsonl --git --docs
```

## Distilled Contracts Table

When the private index is present, it may carry a distilled
`intent_contracts` table: one row per testable product contract with its
evidence, a live verification hint, confidence, and status. Read it directly:

```bash
sqlite3 .intent-ledger/evogent-intent-ledger.sqlite \
  "SELECT area, statement, status FROM intent_contracts ORDER BY area"
```

It is seeded (idempotently) by `scripts/intent/seed_intent_contracts.py`; update that script when a contract is added, corrected, or its status changes, then re-run it. The raw turns/signals/docs remain the evidence; this table is the distilled story for keeping behavior and tests accurate.

## Current High-Risk Intent

- Deterministic mechanics present the complete eligible
  accepted-but-unviewed primary set. No calendar cutoff, candidate cap, source
  balance, or item-type rule is allowed to hide candidates from the runtime
  editor.
- The hint-free phone runtime agent privately judges current value and
  freshness. Shipped primary rows persist that judgment; recency and
  deterministic fallback scores do not become editorial substitutes.
- The primary slate is bounded at 50 items. There is no minimum item count,
  source quota, item-type quota, thread-count quota, or required analysis item.
  A smaller or empty slate is valid when it is the agent's truthful judgment.
- Shipment thread IDs remain stable through submit and arrange. A shipment is
  not split into separate blocks, and a singleton retains its own identity
  rather than being pooled into a synthetic topic.
- A completed cycle carries a truthful receipt: terminal status, accepted count,
  and reason agree. Volume alone never defines success, and a small or empty
  result does not require a mechanical volume exception.
- Connector/source headings and quick curator reasons are part of the feed contract.
- Threads are the unit of shipment. UI fixes must not make primary feed rows disappear, hide thread navigation, or collapse useful context into unreadable metadata.
- Dynamic curation cadence must be explainable from runtime evidence, especially when the max interval is exceeded.

## Useful Commands

The commands in this section require the optional private index unless stated
otherwise.

Show ledger summary:

```bash
python3 scripts/intent/ledger_query.py summary
```

Search the ledger:

```bash
python3 scripts/intent/ledger_query.py search \
  --query "full eligible set private judgment stable thread completion receipt" \
  --limit 20
```

Write a repair-context audit with both lexical and local vector evidence:

```bash
python3 scripts/intent/query_relevant_intent.py \
  "why would this current behavior violate the user's intent?"
```

Or, for lower-level control:

```bash
python3 scripts/intent/ledger_query.py audit \
  --query "why would this current behavior violate the user's intent?" \
  --query "phone runtime full eligible set private judgment maximum 50 no minimum stable thread singleton truthful completion receipt" \
  --vector \
  --limit 10 \
  --vector-limit 5
```

Run retrieval-quality experiments:

```bash
python3 scripts/intent/ledger_search_experiments.py
```

This writes both JSON and Markdown under `data/intent-audits/` and exits nonzero if the recommended hybrid workflow cannot retrieve the required fixture evidence. Treat this as a regression test for agent retrieval behavior, not as a product test of the app itself.

Build and query the optional local vector index:

```bash
npx tsx scripts/intent/vectorize-intent-ledger.ts build --limit=2500
npx tsx scripts/intent/vectorize-intent-ledger.ts search "everything unviewed interesting should be reviewed no matter how old"
```

Audit current curation contracts against the live DB:

```bash
python3 scripts/intent/audit_curator_contracts.py
```

## Query Strategy

When the private index exists, use `query_relevant_intent.py` first for ordinary
repair work. It wraps `ledger_query.py audit`, combines SQLite FTS with
signal/doc/turn/commit fallbacks, adds Evogent guardrail queries, includes local
vector evidence, and writes a reusable private audit artifact. Use
`ledger_query.py audit` directly only when you need lower-level control. Keep two
query shapes: the user's natural-language concern and a compact Evogent-domain
guardrail query. The domain query should mention any relevant invariants, such as
`full eligible set accepted unviewed`, `runtime agent private judgment`,
`maximum 50 no minimum or source/type quota`, `stable shipment thread ID no
split singleton`, `truthful completion receipt`, `connector headings why
included`, or `curation cadence evidence`. Use `--terms` only when separate
term-by-term evidence is useful.

Use the vector index as the semantic second pass, either through
`ledger_query.py audit --vector` or directly with
`vectorize-intent-ledger.ts search`. The local vector path uses the repo's
maintained `@huggingface/transformers` embedding helper and `sqlite-vec`; it
does not send chat-log chunks to an external embedding API. The vector index is
intentionally bounded to intent-bearing signals and key docs, excludes generated
`data/intent-audits/` artifacts and retrieval-test fixtures, embeds turn
evidence without noisy session titles, lightly promotes user-authored chat
evidence over assistant summaries when distances are close, gives key docs
enough weight for workflow questions, and de-duplicates equivalent evidence.
Do not treat vector search as authoritative by itself; use current structural
contract terms and verify them against fresh phone-local evidence.

The canonical phone's live database and private evidence ledger are
authoritative for deployment behavior. A VM, stale host copy, scratch index, or
generated audit cannot override that evidence. Vector retrieval improves recall;
it does not turn a copied database into current runtime truth.

Retrieval behavior contract:

- Hybrid FTS plus structured signals is the first pass for structural product
  contracts; raw substring matching is only a noisy comparator.
- Vector search is a semantic second pass for paraphrases such as
  `future work on feed ordering should reflect older important unseen items, not
  just newest batch`, `connector headings quick rationale disappeared`, and
  `dynamic curation frequency how often should it run`.
- Fuzzy questions about small or empty cycles need a second query with Evogent's
  current contract words, such as `no minimum volume quota runtime agent
  judgment truthful completion receipt`.
- Generated audits and retrieval fixtures stay out of search results. Equivalent
  evidence is de-duplicated, and key workflow docs retain enough weight to
  retrieve the public operating contract.
- Best workflow when the private index exists: run
  `query_relevant_intent.py <user wording>` before editing and keep the resulting
  `data/intent-audits/` artifact private with the fix notes. Without the index,
  query committed `.intent/` and continue. Treat vector evidence as semantic
  recall, not as the source of truth for phone runtime behavior.

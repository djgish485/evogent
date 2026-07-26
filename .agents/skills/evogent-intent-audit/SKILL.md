---
name: evogent-intent-audit
description: Use before Evogent curation, feed, thread, connector heading, source/cache, regression, or intent-ledger work. Reads public product laws and, when available, audits the canonical phone runtime and its private evidence without imposing editorial quotas.
---

# Evogent Intent Audit

Use this skill whenever Evogent behavior, tests, curation, feed ordering,
threads, connector headings, cache/source behavior, or regressions are in scope.

## Authority Boundary

- Committed `.intent/*.jsonl` contains the public product-wide laws.
- The canonical phone's SQLite state and private intent ledger contain the
  authoritative evidence for that deployment.
- A host checkout is development infrastructure. A VM, stale host database,
  scratch ledger, generated audit, or retrieval fixture is never authoritative
  for phone runtime behavior.
- Private audit artifacts stay under ignored local data paths. Generalize a
  product mechanism before committing it.

## Workflow

1. Read `.intent/contracts.jsonl`, `.intent/backlog.jsonl`, and
   `docs/intent-ledger.md`.
2. Run a task-context audit before editing when the private index is available:

```bash
python3 scripts/intent/query_relevant_intent.py \
  "<the user's concern in their own words>"
```

For lower-level control, use both the natural-language concern and a current
domain guardrail:

```bash
python3 scripts/intent/ledger_query.py audit \
  --query "<the user's concern in their own words>" \
  --query "phone runtime full eligible set private judgment primary slate maximum 50 no minimum stable thread id singleton truthful completion receipt" \
  --vector
```

3. Treat the generated `data/intent-audits/` artifact as private working
   evidence, not primary intent and never public source material.
4. On the canonical phone, audit the live database:

```bash
python3 scripts/intent/audit_curator_contracts.py
```

Use `--db <phone-local-db>` only when the path has known fresh phone provenance.
Do not make a stale host or VM copy look authoritative by pointing the audit at
it.
5. For fuzzy or paraphrased intent, use the optional private vector index as a
   semantic second pass:

```bash
npx tsx scripts/intent/vectorize-intent-ledger.ts build --limit=2500
npx tsx scripts/intent/vectorize-intent-ledger.ts search "describe the intent question in plain English"
```

Exact structural laws still require committed-contract and runtime evidence.
Useful domain terms include `full eligible set`, `private judgment`, `maximum
50`, `no minimum`, `stable thread id`, `singleton`, and `completion receipt`.
6. Refresh a private evidence index only when newer evidence matters:

```bash
python3 scripts/intent/update_intent_ledger.py --docs --skip-fts-rebuild
```

The refresh is maintenance, not a blocker before every edit.
7. Verify fixes with focused tests, a normal hint-free phone-owned cycle, the
   private runtime receipts, and visible behavior on display 0.

## Non-Negotiable Intent Checks

- Deterministic mechanics present every eligible accepted-but-unviewed primary
  row to the runtime editor. They do not decide freshness or value by age,
  source, type, or output count.
- The hint-free runtime agent privately judges what is valuable now and records
  explicit interest/freshness evidence for shipped primary rows.
- The primary slate has a hard ceiling of 50. It has no minimum item count,
  source quota, item-type quota, or required analysis count. A smaller or empty
  slate is valid when that is the agent's truthful judgment.
- Every shipped primary row keeps a stable shipment thread ID. A thread is
  contiguous and never cut into separate blocks; a genuine singleton retains
  its own identity instead of being pooled under a synthetic topic.
- Completion is a receipt, not a volume test: terminal status, accepted count,
  and reason must agree. Failed or empty runs stay honestly failed or empty.
- Connector headings and short curator reasons remain visible, and primary
  items never disappear behind child/context rows.

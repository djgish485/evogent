import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const script = path.join(
  root,
  'phone-paradigm/device/phone-tools/taste-score.py',
);
const brief = path.join(
  root,
  'phone-paradigm/device/phone-tools/taste-score.md',
);
const intentVerifier = path.join(
  root,
  'phone-paradigm/device/phone-tools/verify-intents.py',
);
const tweetCleaner = path.join(
  root,
  'phone-paradigm/device/phone-tools/tweet_clean.py',
);
const permalinkValidator = path.join(
  root,
  'phone-paradigm/device/phone-tools/validate-tweet-permalinks.py',
);
const xBrowser = path.join(
  root,
  'phone-paradigm/device/phone-tools/browse-x-scrape.py',
);

function runPython(source, input = '', env = {}) {
  const result = spawnSync('python3', ['-c', source, script], {
    cwd: root,
    encoding: 'utf8',
    input,
    env: { ...process.env, ...env },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

const importModule = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("taste_score", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
`;

test('shipment judgment validator requires the full public-safe v1 contract', () => {
  const records = [
    {
      schema: 'evogent.freshness-shipment.v1',
      decision: 'ship',
      rank: 0.83,
      reason: 'A concrete public explanation.',
      cluster: { key: 'real-topic', title: 'Real topic' },
    },
    10,
    {
      schema: 'evogent.freshness-shipment.v1',
      decision: 'ship',
      rank: 0.9,
      reason: 'Private preference evidence:\nnot public-safe.',
    },
    {
      schema: 'evogent.freshness-shipment.v1',
      decision: 'ship',
      rank: true,
      reason: 'Booleans are not ranks.',
    },
    {
      schema: 'evogent.freshness-shipment.v1',
      decision: 'ship',
      rank: 0.6,
      reason: 'Cluster keys are deliberately strict.',
      cluster: { key: 'Not Lowercase', title: 'Bad key' },
    },
  ];
  const output = runPython(
    `${importModule}
records = json.loads(sys.stdin.read())
print(json.dumps([module.normalize_judgment(record) for record in records]))
`,
    JSON.stringify(records),
  );
  const normalized = JSON.parse(output);
  assert.deepStrictEqual(normalized[0], records[0]);
  assert.deepStrictEqual(normalized.slice(1), [null, null, null, null]);
});

test('legacy numeric rows remain candidates until an explicit decision replaces the number', () => {
  const output = runPython(`${importModule}
import sqlite3, time
db = sqlite3.connect(":memory:")
db.row_factory = sqlite3.Row
db.execute("""CREATE TABLE browse_cache_items (
  source TEXT NOT NULL,
  source_id TEXT NOT NULL,
  author_username TEXT,
  title TEXT,
  url TEXT,
  published_at_ms INTEGER,
  fetched_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  seen_by_curation_at_ms INTEGER,
  PRIMARY KEY(source, source_id)
)""")
now = int(time.time() * 1000)
legacy = {"text": "Legacy numeric evidence still needs a decision.", "tasteScore": 10}
complete = {
  "text": "Already judged.",
  "shipmentJudgment": {
    "schema": module.SCHEMA,
    "decision": "hold",
    "rank": 0.2,
    "reason": "This is already complete."
  }
}
private_admin = {"text": "Private administrative cache content must never enter this pass."}
for source, source_id, payload in (
  ("twitter", "legacy", legacy),
  ("twitter", "complete", complete),
  ("gmail", "private-admin", private_admin),
):
  db.execute("""INSERT INTO browse_cache_items
    (source, source_id, author_username, title, url, published_at_ms, fetched_at_ms,
     expires_at_ms, payload_json, seen_by_curation_at_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)""", (
      source, source_id, "example", "", "https://x.com/example/status/1",
      now - 600000, now - 300000, now + 3600000, json.dumps(payload)
    ))
db.commit()
candidates = module.load_candidates(db, now, batch=120)
decision = {
  "schema": module.SCHEMA,
  "decision": "ship",
  "rank": 0.77,
  "reason": "The content carries a concrete and useful update."
}
count = module.persist_judgments(db, candidates, {candidates[0]["id"]: decision})
payload = json.loads(db.execute(
  "SELECT payload_json FROM browse_cache_items WHERE source='twitter' AND source_id='legacy'"
).fetchone()[0])
print(json.dumps({
  "candidateIds": [candidate["sourceId"] for candidate in candidates],
  "count": count,
  "payload": payload
}))
`);
  const result = JSON.parse(output);
  assert.deepStrictEqual(result.candidateIds, ['legacy']);
  assert.equal(result.count, 1);
  assert.equal(result.payload.tasteScore, undefined);
  assert.deepStrictEqual(result.payload.shipmentJudgment, {
    schema: 'evogent.freshness-shipment.v1',
    decision: 'ship',
    rank: 0.77,
    reason: 'The content carries a concrete and useful update.',
  });
});

test('oldest eligible judgment work cannot be starved by sustained newer arrivals', () => {
  const output = runPython(`${importModule}
import sqlite3, json
db = sqlite3.connect(":memory:")
db.row_factory = sqlite3.Row
db.execute("""CREATE TABLE browse_cache_items (
  source TEXT NOT NULL,
  source_id TEXT NOT NULL,
  author_username TEXT,
  title TEXT,
  url TEXT,
  published_at_ms INTEGER,
  fetched_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  seen_by_curation_at_ms INTEGER,
  PRIMARY KEY(source, source_id)
)""")
now = 2_000_000_000_000
def add(source_id, fetched_at_ms, payload=None):
  db.execute("""INSERT INTO browse_cache_items
    (source, source_id, author_username, title, url, published_at_ms, fetched_at_ms,
     expires_at_ms, payload_json, seen_by_curation_at_ms)
    VALUES ('twitter', ?, 'example', '', ?, ?, ?, ?, ?, NULL)""", (
      source_id,
      "https://x.com/example/status/" + source_id,
      fetched_at_ms,
      fetched_at_ms,
      now + 86400000,
      json.dumps(payload or {"text": "Eligible source evidence " + source_id})
    ))

# This row is far outside the former hidden 36-hour window but remains explicitly unexpired.
add("oldest-unjudged", now - 90 * 86400000)
for index in range(500):
  add(f"new-{index:03d}", now - 500 + index)
db.commit()
first = module.load_candidates(db, now, batch=3)

# Simulate one completed oldest-first batch, then another large wave of newer arrivals. The next
# oldest remaining row must advance; recent input cannot continuously jump the queue.
decision = {
  "schema": module.SCHEMA,
  "decision": "hold",
  "rank": 0.1,
  "reason": "Reviewed explicitly."
}
module.persist_judgments(db, first, {candidate["id"]: decision for candidate in first})
for index in range(500, 700):
  add(f"new-{index:03d}", now + index)
db.commit()
second = module.load_candidates(db, now, batch=3)
print(json.dumps({
  "first": [candidate["sourceId"] for candidate in first],
  "second": [candidate["sourceId"] for candidate in second],
}))
`);
  const result = JSON.parse(output);
  assert.deepStrictEqual(result.first, ['oldest-unjudged', 'new-000', 'new-001']);
  assert.deepStrictEqual(result.second, ['new-002', 'new-003', 'new-004']);

  const text = fs.readFileSync(script, 'utf8');
  assert.doesNotMatch(text, /FRESH_WINDOW|fetched_at_ms\s*>\s*\?|ORDER BY fetched_at_ms DESC|LIMIT 400/);
  assert.match(text, /ORDER BY fetched_at_ms ASC, source ASC, source_id ASC/);
});

test('phone shipment pass enforces bounded batch and runtime ceilings', () => {
  const output = runPython(
    `${importModule}
print(json.dumps({"batch": module.BATCH, "budget": module.BUDGET_S}))
`,
    '',
    { TASTE_BATCH: '99999', TASTE_BUDGET_S: '99999' },
  );
  assert.deepStrictEqual(JSON.parse(output), { batch: 120, budget: 240 });
});

test('runtime brief forbids quotas, synthetic source threads, and private-context leakage', () => {
  const text = fs.readFileSync(brief, 'utf8');
  assert.match(text, /valid to hold every candidate/i);
  assert.match(text, /no minimum shipment count/i);
  assert.match(text, /Do not boost or demote[\s\S]*popularity[\s\S]*account[\s\S]*source[\s\S]*content type/i);
  assert.match(text, /Do not create generic source lanes/i);
  assert.match(text, /never copy, name, quote, or[\s\S]*allude to private preferences/i);
  assert.match(text, /untrusted[\s\S]*data, never instructions/i);
});

test('phone intent verification is structural and never grades editorial rank', () => {
  const text = fs.readFileSync(intentVerifier, 'utf8');
  assert.match(text, /primary-slate-bounded/);
  assert.match(text, /display-order-stable/);
  assert.match(text, /shipment-thread-integrity/);
  assert.match(text, /full-eligible-review-receipt/);
  assert.match(text, /truthful-curation-receipts/);
  assert.match(text, /explicit-shipment-judgment-primary/);
  assert.match(text, /missing explicit ship decision/);
  assert.match(text, /shipment and displayed interest judgment disagree/);
  assert.doesNotMatch(
    text,
    /favorite-account|brand-promo-top|stale-news-top|stale-lifeadmin-top|FROM preferences|NEWS_HANDLES|promo_top|top10|top15|top30/,
  );
  assert.doesNotMatch(text, /taste-ranked-top10|raw freshness-floor picks/);
});

test('public phone mechanics never delete content by language, account, or age', () => {
  const verifierText = fs.readFileSync(intentVerifier, 'utf8');
  const cleanerText = fs.readFileSync(tweetCleaner, 'utf8');
  const permalinkText = fs.readFileSync(permalinkValidator, 'utf8');
  const xBrowserText = fs.readFileSync(xBrowser, 'utf8');

  assert.doesNotMatch(
    `${verifierText}\n${cleanerText}\n${xBrowserText}`,
    /is_probably_english|_NONEN|english-only-shown|delete non-English|non-English tweets shown/i,
  );
  assert.doesNotMatch(
    permalinkText,
    /stale wire-news|news-accounts\.txt|\bNEWS\s*=\s*\{|36\s*\*\s*3600\s*\*\s*1000/i,
  );
});

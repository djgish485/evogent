#!/usr/bin/env node
/**
 * Interest metadata backfill: stamps metadata.interest on historical curated
 * items that lack supporting judgment evidence, using private context (or the
 * public template) through the local codex CLI. This metadata never decides
 * shipment or display order.
 *
 * Only fills NULL interest — never overwrites curator or bootstrap scores.
 * Run via evogent-interest-backstop.timer (or manually).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const dbPath = process.env.MEDIA_AGENT_DB_PATH || path.join(repoRoot, 'data', 'media-agent.db');
const userRubricPath = path.join(repoRoot, 'data', 'interestingness-rubric.md');
const templateRubricPath = path.join(repoRoot, 'data', 'interestingness-rubric.default.md');
const batchLimit = Number(process.env.INTEREST_BACKSTOP_LIMIT || 150);

const db = new Database(dbPath);
const rows = db.prepare(`
  SELECT id, type, source, substr(created_at,1,10) AS d, coalesce(author_username,'') AS au,
    substr(coalesce(nullif(title,''), text, ''),1,160) AS t, substr(coalesce(text,''),1,700) AS tx,
    substr(coalesce(reason,''),1,110) AS rs,
    substr(coalesce(json_extract(metadata,'$.bridge'),''),1,110) AS br
  FROM feed
  WHERE type IN ('tweet','article','analysis','youtube','hackernews')
    AND parent_id IS NULL
    AND json_extract(metadata,'$.interest.score') IS NULL
    AND id NOT LIKE 'reflection-%'
    AND COALESCE(json_extract(metadata,'$.reflectionCycle'),0) != 1
    AND COALESCE(json_extract(metadata,'$.mode'),'') != 'reflection'
    AND COALESCE(thread_id, json_extract(metadata,'$.thread.threadId'), json_extract(metadata,'$.threadId'),'') NOT LIKE '%transparency%'
    AND COALESCE(thread_id, json_extract(metadata,'$.thread.threadId'), json_extract(metadata,'$.threadId'),'') NOT LIKE 'curation-readout-%'
  ORDER BY created_at DESC
  LIMIT ?
`).all(batchLimit);

if (rows.length === 0) {
  console.log('interest-backstop: nothing unscored');
  process.exit(0);
}

const rubric = readFileSync(
  existsSync(userRubricPath) ? userRubricPath : templateRubricPath,
  'utf8',
);
const lines = rows.map((r) => JSON.stringify(r)).join('\n');
const prompt = `${rubric}

---
Record one supporting content-value judgment for each feed item below using the
private context above. This backfill does not ship, hold, promote, or reorder
anything. Do not force a score distribution or translate account, source,
content type, popularity, or age into a formula.
Items (one JSON per line; fields: id, type, source, d=date, au=author, t=title, tx=body excerpt, rs=reason, br=bridge).
Judge the actual content in t+tx, not the container.

${lines}

OUTPUT FORMAT (strict): one JSON object per line, one line per input item, nothing else:
{"id":"<exact input id>","s":<int 0-100 ordinal supporting judgment>,"dur":"evergreen"|"dated"|"news"}
Do not wrap in code fences. Do not add commentary.`;

let output;
try {
  output = execFileSync('codex', ['exec', '--skip-git-repo-check', prompt], {
    encoding: 'utf8',
    timeout: 10 * 60 * 1000,
    maxBuffer: 16 * 1024 * 1024,
    cwd: repoRoot,
  });
} catch (error) {
  console.error('interest-backstop: codex exec failed:', error.message?.slice(0, 300));
  process.exit(1);
}

const validIds = new Set(rows.map((r) => r.id));
const update = db.prepare(`
  UPDATE feed SET metadata = json_set(
    COALESCE(metadata, '{}'),
    '$.interest.score', ?,
    '$.interest.durability', ?,
    '$.interest.scoredBy', 'rubric-backstop',
    '$.interest.scoredAtMs', ?
  )
  WHERE id = ? AND json_extract(metadata, '$.interest.score') IS NULL
`);

let applied = 0;
const nowMs = Date.now();
for (const raw of output.split('\n')) {
  const line = raw.trim().replace(/^```(json)?|```$/g, '');
  if (!line.startsWith('{"id"')) continue;
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    continue;
  }
  if (!validIds.has(parsed.id)) continue;
  const score = Math.max(0, Math.min(100, Math.round(Number(parsed.s)))) / 100;
  if (!Number.isFinite(score)) continue;
  const dur = ['evergreen', 'dated', 'news'].includes(parsed.dur) ? parsed.dur : 'dated';
  applied += update.run(score, dur, nowMs, parsed.id).changes;
}

console.log(`interest-backstop: ${rows.length} unscored found, ${applied} stamped`);
process.exit(applied > 0 || rows.length === 0 ? 0 : 1);

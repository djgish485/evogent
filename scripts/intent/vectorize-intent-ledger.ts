#!/usr/bin/env tsx
import Database from 'better-sqlite3';
import { generateEmbedding } from '../../src/lib/vectors/embeddings';

const EMBEDDING_DIM = 384;
const EMBEDDING_VERSION = 'turn-text-v2';
const DEFAULT_DB = '.intent-ledger/evogent-intent-ledger.sqlite';
const AUDIT_ARTIFACT_MARKER = '/data/intent-audits/';
const AUDIT_ARTIFACT_PREFIX = 'data/intent-audits/';
const RETRIEVAL_TEST_MARKER = 'scripts/intent/ledger_search_experiments.py';

type CandidateRow = {
  id: string;
  source_table: string;
  source_id: string;
  title: string | null;
  text: string;
  timestamp: string | null;
  source_role: string | null;
};

type SearchRow = {
  id: string;
  source_table: string;
  source_id: string;
  title: string | null;
  timestamp: string | null;
  source_role: string | null;
  excerpt: string;
  distance: number;
  adjusted_distance: number;
};

function readFlagValue(args: string[], flag: string): string | undefined {
  const equals = args.find((arg) => arg.startsWith(`${flag}=`));
  if (equals) return equals.slice(flag.length + 1);
  const index = args.indexOf(flag);
  if (index >= 0) return args[index + 1];
  return undefined;
}

function readLimit(args: string[], fallback: number): number {
  const raw = readFlagValue(args, '--limit');
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readSearchQuery(args: string[]): string {
  const explicit = readFlagValue(args, '--query');
  if (explicit) return explicit.trim();
  const positional = args
    .filter((arg, index) => {
      if (arg === '--limit' || arg === '--query') return false;
      const previous = args[index - 1];
      if (previous === '--limit' || previous === '--query') return false;
      return !arg.startsWith('--limit=') && !arg.startsWith('--query=');
    })
    .join(' ')
    .trim();
  return positional;
}

async function loadSqliteVec(db: Database.Database): Promise<boolean> {
  try {
    const sqliteVec = await import('sqlite-vec') as {
      default?: { load?: (db: Database.Database) => void };
      load?: (db: Database.Database) => void;
    };
    const load = sqliteVec.load || sqliteVec.default?.load;
    if (!load) throw new Error('sqlite-vec load() export not found');
    load(db);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[intent-vector] sqlite-vec unavailable: ${message}`);
    return false;
  }
}

async function init(db: Database.Database): Promise<boolean> {
  db.exec(`
    CREATE TABLE IF NOT EXISTS intent_vector_docs (
      id TEXT PRIMARY KEY,
      source_table TEXT NOT NULL,
      source_id TEXT NOT NULL,
      title TEXT,
      text TEXT NOT NULL,
      timestamp TEXT,
      source_role TEXT,
      text_hash TEXT NOT NULL
    );
  `);
  try {
    db.exec(`ALTER TABLE intent_vector_docs ADD COLUMN source_role TEXT;`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('duplicate column name')) throw error;
  }

  const ok = await loadSqliteVec(db);
  if (!ok) return false;

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS intent_vec USING vec0(
      id TEXT PRIMARY KEY,
      embedding float[${EMBEDDING_DIM}]
    );
  `);
  return true;
}

function candidateRows(db: Database.Database, limit: number): CandidateRow[] {
  return db.prepare(`
    WITH ranked_signals AS (
      SELECT
        'signal:' || s.id AS id,
        s.source_table,
        s.source_id,
        s.title,
        trim(coalesce(s.title, '') || char(10) || coalesce(s.excerpt, '')) AS text,
        s.timestamp,
        t.role AS source_role,
        CASE s.category
          WHEN 'contract' THEN 1
          WHEN 'user_pain' THEN 2
          WHEN 'regression' THEN 3
          WHEN 'feed_ui' THEN 4
          ELSE 9
        END AS category_rank
      FROM signals s
      LEFT JOIN turns t
        ON s.source_table = 'turns'
       AND t.id = CAST(
         CASE
           WHEN instr(coalesce(s.source_id, ''), ':') > 0
             THEN substr(s.source_id, instr(s.source_id, ':') + 1)
           ELSE coalesce(s.source_id, '')
         END AS INTEGER
       )
      WHERE s.category IN ('contract', 'user_pain', 'regression', 'feed_ui')
        AND length(coalesce(s.excerpt, '')) > 40
        AND instr(coalesce(s.source_id, ''), '${AUDIT_ARTIFACT_MARKER}') = 0
        AND coalesce(s.source_id, '') NOT LIKE '${AUDIT_ARTIFACT_PREFIX}%'
        AND coalesce(s.title, '') NOT LIKE '${AUDIT_ARTIFACT_PREFIX}%'
      ORDER BY category_rank ASC, s.timestamp DESC
      LIMIT ?
    ),
    doc_rows AS (
      SELECT
        'doc:' || path AS id,
        'docs' AS source_table,
        path AS source_id,
        title,
        substr(content, 1, 4000) AS text,
        mtime AS timestamp,
        'doc' AS source_role
      FROM docs
      WHERE rel_path IN (
        'AGENTS.md',
        'docs/intent-ledger.md',
        '.agents/skills/evogent-intent-audit/SKILL.md',
        '.claude/commands/curate.md',
        'data/curation-prompt.md',
        'data/preference-insights.md',
        'data/config.md'
      )
    ),
    recent_commits AS (
      SELECT
        'commit:' || sha AS id,
        'commits' AS source_table,
        sha AS source_id,
        subject AS title,
        substr(
          trim(coalesce(subject, '') || char(10) || coalesce(body, '') || char(10) || coalesce(diffstat, '')),
          1,
          4000
        ) AS text,
        commit_date AS timestamp,
        'commit' AS source_role
      FROM commits
      WHERE length(coalesce(subject, '')) > 0
      ORDER BY coalesce(commit_ts, 0) DESC
      LIMIT 250
    )
    SELECT id, source_table, source_id, title, text, timestamp, source_role FROM ranked_signals
    UNION ALL
    SELECT id, source_table, source_id, title, text, timestamp, source_role FROM doc_rows
    UNION ALL
    SELECT id, source_table, source_id, title, text, timestamp, source_role FROM recent_commits
  `).all(limit) as CandidateRow[];
}

function embeddingInput(row: CandidateRow, text: string): string {
  if (row.source_table === 'turns') return text;
  return `${row.title || ''}\n${text}`;
}

function hashText(text: string): string {
  // Keep this dependency-free; a stable idempotence hash is enough here.
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i += 1) {
    h1 ^= text.charCodeAt(i);
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= text.charCodeAt(text.length - i - 1);
    h2 = Math.imul(h2, 0x811c9dc5);
  }
  return `${(h1 >>> 0).toString(16)}${(h2 >>> 0).toString(16)}`;
}

async function build(db: Database.Database, limit: number) {
  const hasVec = await init(db);
  if (!hasVec) {
    console.warn('[intent-vector] vector table unavailable; build skipped');
    return;
  }

  const upsertDoc = db.prepare(`
    INSERT OR REPLACE INTO intent_vector_docs(id, source_table, source_id, title, text, timestamp, source_role, text_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const hasExisting = db.prepare(`SELECT text_hash FROM intent_vector_docs WHERE id = ?`);
  const hasVector = db.prepare(`SELECT id FROM intent_vec WHERE id = ?`);
  const deleteVec = db.prepare(`DELETE FROM intent_vec WHERE id = ?`);
  const insertVec = db.prepare(`INSERT INTO intent_vec(id, embedding) VALUES (?, ?)`);
  const rows = candidateRows(db, limit);
  let vectorized = 0;
  for (const row of rows) {
    const text = row.text.slice(0, 4000);
    const embeddingText = embeddingInput(row, text);
    const textHash = hashText(`${EMBEDDING_VERSION}\n${embeddingText}`);
    const existing = hasExisting.get(row.id) as { text_hash: string } | undefined;
    upsertDoc.run(row.id, row.source_table, row.source_id, row.title, text, row.timestamp, row.source_role, textHash);
    if (existing?.text_hash === textHash && hasVector.get(row.id)) continue;
    const embedding = await generateEmbedding(embeddingText);
    deleteVec.run(row.id);
    insertVec.run(row.id, new Float32Array(embedding));
    vectorized += 1;
    if (vectorized % 100 === 0) {
      console.log(`[intent-vector] vectorized ${vectorized}/${rows.length}`);
    }
  }
  console.log(`[intent-vector] candidates=${rows.length} vectorized=${vectorized}`);
}

async function search(db: Database.Database, query: string, limit: number) {
  const hasVec = await init(db);
  if (!hasVec) {
    console.warn('[intent-vector] vector table unavailable; search skipped');
    return;
  }
  const embedding = await generateEmbedding(query);
  const rawRows = db.prepare(`
    WITH scored AS (
      SELECT
        d.id,
        d.source_table,
        d.source_id,
        d.title,
        d.timestamp,
        d.source_role,
        substr(d.text, 1, 500) AS excerpt,
        vec_distance_L2(v.embedding, ?) AS distance
      FROM intent_vec v
      JOIN intent_vector_docs d ON d.id = v.id
      WHERE instr(coalesce(d.source_id, ''), '${AUDIT_ARTIFACT_MARKER}') = 0
        AND coalesce(d.source_id, '') NOT LIKE '${AUDIT_ARTIFACT_PREFIX}%'
        AND coalesce(d.title, '') NOT LIKE '${AUDIT_ARTIFACT_PREFIX}%'
        AND instr(coalesce(d.source_id, ''), '${RETRIEVAL_TEST_MARKER}') = 0
    )
    SELECT
      *,
      distance
        - CASE WHEN source_role = 'user' THEN 0.03 ELSE 0 END
        + CASE WHEN source_role = 'assistant' THEN 0.03 ELSE 0 END
        - CASE WHEN source_role = 'doc' OR source_table = 'docs' THEN 0.05 ELSE 0 END
        AS adjusted_distance
    FROM scored
    ORDER BY adjusted_distance ASC, distance ASC
    LIMIT ?
  `).all(new Float32Array(embedding), Math.max(limit * 6, limit + 12)) as SearchRow[];
  const rows = uniqueSearchRows(rawRows, limit);
  console.log(JSON.stringify({ query, raw_count: rawRows.length, rows }, null, 2));
}

function uniqueSearchRows(rows: SearchRow[], limit: number): SearchRow[] {
  const seen = new Set<string>();
  const unique: SearchRow[] = [];
  for (const row of rows) {
    const key = searchDedupeKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(row);
    if (unique.length >= limit) break;
  }
  return unique;
}

function searchDedupeKey(row: SearchRow): string {
  const compactExcerpt = row.excerpt.replace(/\s+/g, ' ').trim().slice(0, 280);
  if (row.source_table === 'docs') {
    return `${row.source_table}:${row.source_id}`;
  }
  return [
    row.source_table,
    row.title || '',
    row.timestamp || '',
    compactExcerpt,
  ].join(':');
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'search';
  const dbPath = process.env.EVOGENT_INTENT_LEDGER_DB || DEFAULT_DB;
  const db = new Database(dbPath);
  try {
    if (command === 'build') {
      const limit = readLimit(args.slice(1), 2500);
      await build(db, limit);
      return;
    }
    if (command === 'search') {
      const searchArgs = args.slice(1);
      const query = readSearchQuery(searchArgs);
      const limit = readLimit(searchArgs, 10);
      if (!query) throw new Error('usage: vectorize-intent-ledger.ts search [--query] <query> [--limit N]');
      await search(db, query, limit);
      return;
    }
    throw new Error(`unknown command: ${command}`);
  } finally {
    db.close();
  }
}

void main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});

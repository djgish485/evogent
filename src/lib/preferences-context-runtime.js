const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const dataDir = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data'));
const defaultDbPath = path.join(dataDir, 'media-agent.db');
const outputPath = path.join(dataDir, 'preferences-context.md');
const MAX_CONTEXT_BYTES = 16 * 1024;
const CONTEXT_COMPACTION_NOTE = 'Raw preference and attention evidence remains in the private SQLite database; this file is a bounded neutral evidence window.';
const PHONE_NOTIFICATION_FEED_EVIDENCE_EXCLUSION = `
  NOT (
    COALESCE(feed.type, '') = 'notification'
    AND COALESCE(feed.source, '') = 'phone-notification'
  )
`;
const PHONE_NOTIFICATION_PREFERENCE_EVIDENCE_EXCLUSION = `
  NOT (
    (
      COALESCE(feed.type, '') = 'notification'
      AND COALESCE(feed.source, '') = 'phone-notification'
    )
    OR COALESCE(preferences.source_id, '') LIKE 'phone-notification:%'
  )
`;

function getDbPath() {
  return process.env.MEDIA_AGENT_DB_PATH || defaultDbPath;
}

function truncateText(text, maxLength = 220) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

function formatAuthorHandle(username) {
  const normalized = String(username || '').trim();
  if (!normalized) return null;
  return normalized.startsWith('@') ? normalized : `@${normalized}`;
}

function tableExists(db, tableName) {
  const row = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name = ?
  `).get(tableName);
  return !!row;
}

function tableHasColumn(db, tableName, columnName) {
  return db.prepare(`PRAGMA table_info("${tableName}")`).all()
    .some((row) => row.name === columnName);
}

function parseJsonStringArray(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry) => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function readRecentThreadFeedback(db) {
  if (!tableExists(db, 'thread_feedback')) return [];
  return db.prepare(`
    SELECT
      thread_feedback.thread_id,
      thread_feedback.cycle_id,
      thread_feedback.vote,
      thread_feedback.thread_title,
      thread_feedback.reason,
      thread_feedback.category,
      thread_feedback.probe_reason,
      thread_feedback.probe_uncertainty,
      thread_feedback.source_item_ids,
      thread_feedback.origin_session_id,
      thread_feedback.created_at
    FROM thread_feedback
    LEFT JOIN feed ON feed.id = thread_feedback.feed_item_id
    WHERE ${PHONE_NOTIFICATION_FEED_EVIDENCE_EXCLUSION}
    ORDER BY datetime(thread_feedback.created_at) DESC, thread_feedback.id DESC
    LIMIT 12
  `).all().map((row) => ({
    ...row,
    source_item_ids: parseJsonStringArray(row.source_item_ids),
  }));
}

function readBehavioralAttention(db) {
  if (!tableExists(db, 'feed_engagement_sessions')) return [];
  const userScrolledSql = tableHasColumn(db, 'feed_engagement_sessions', 'user_scrolled')
    ? 'sessions.user_scrolled'
    : '0';
  return db.prepare(`
    SELECT
      sessions.feed_item_id,
      COALESCE(feed.type, json_extract(
        CASE WHEN json_valid(sessions.item_snapshot) THEN sessions.item_snapshot ELSE '{}' END,
        '$.type'
      )) AS item_type,
      COALESCE(feed.source, json_extract(
        CASE WHEN json_valid(sessions.item_snapshot) THEN sessions.item_snapshot ELSE '{}' END,
        '$.source'
      )) AS item_source,
      COALESCE(feed.author_username, json_extract(
        CASE WHEN json_valid(sessions.item_snapshot) THEN sessions.item_snapshot ELSE '{}' END,
        '$.authorUsername'
      )) AS author_username,
      COALESCE(feed.title, json_extract(
        CASE WHEN json_valid(sessions.item_snapshot) THEN sessions.item_snapshot ELSE '{}' END,
        '$.title'
      )) AS title,
      COALESCE(feed.text, json_extract(
        CASE WHEN json_valid(sessions.item_snapshot) THEN sessions.item_snapshot ELSE '{}' END,
        '$.text'
      )) AS text,
      COUNT(*) AS visit_count,
      SUM(sessions.is_return) AS return_count,
      SUM(sessions.active_dwell_ms) AS total_dwell_ms,
      MAX(sessions.max_scroll_depth_pct) AS max_scroll_depth_pct,
      MAX(${userScrolledSql}) AS user_scrolled,
      MAX(sessions.opened_at) AS last_opened_at
    FROM feed_engagement_sessions AS sessions
    LEFT JOIN feed ON feed.id = sessions.feed_item_id
    WHERE NOT (
      COALESCE(
        feed.type,
        json_extract(
          CASE WHEN json_valid(sessions.item_snapshot) THEN sessions.item_snapshot ELSE '{}' END,
          '$.type'
        ),
        ''
      ) = 'notification'
      AND COALESCE(
        feed.source,
        json_extract(
          CASE WHEN json_valid(sessions.item_snapshot) THEN sessions.item_snapshot ELSE '{}' END,
          '$.source'
        ),
        ''
      ) = 'phone-notification'
    )
    GROUP BY sessions.feed_item_id
    ORDER BY datetime(last_opened_at) DESC, sessions.feed_item_id ASC
    LIMIT 12
  `).all();
}

function readPreferenceRows(db) {
  const recentThreadFeedback = readRecentThreadFeedback(db);
  const behavioralAttention = readBehavioralAttention(db);
  if (!tableExists(db, 'preferences')) {
    return {
      total: 0,
      statsByType: {},
      explicitSignals: [],
      recentThreadFeedback,
      behavioralAttention,
    };
  }

  const total = Number(db.prepare(`
    SELECT COUNT(*) AS count
    FROM preferences
    LEFT JOIN feed ON feed.id = preferences.feed_item_id
    WHERE ${PHONE_NOTIFICATION_PREFERENCE_EVIDENCE_EXCLUSION}
  `).get().count) || 0;
  const byTypeRows = db.prepare(`
    SELECT signal_type, COUNT(*) AS count
    FROM preferences
    LEFT JOIN feed ON feed.id = preferences.feed_item_id
    WHERE ${PHONE_NOTIFICATION_PREFERENCE_EVIDENCE_EXCLUSION}
    GROUP BY signal_type
  `).all();
  const statsByType = Object.fromEntries(
    byTypeRows.map((row) => [row.signal_type, row.count]),
  );
  const explicitSignals = db.prepare(`
    SELECT
      preferences.id,
      preferences.signal_type,
      preferences.source,
      preferences.text,
      preferences.reason,
      preferences.author_username,
      preferences.created_at,
      feed.reason AS agent_reason
    FROM preferences
    LEFT JOIN feed ON feed.id = preferences.feed_item_id
    WHERE ${PHONE_NOTIFICATION_PREFERENCE_EVIDENCE_EXCLUSION}
    ORDER BY datetime(preferences.created_at) DESC, preferences.id DESC
    LIMIT 40
  `).all();

  return {
    total,
    statsByType,
    explicitSignals,
    recentThreadFeedback,
    behavioralAttention,
  };
}

function formatDwellTime(milliseconds) {
  const totalSeconds = Math.max(0, Math.round((Number(milliseconds) || 0) / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function truncateUtf8Bytes(value, maxBytes) {
  const text = String(value || '');
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  if (maxBytes <= 3) return '';
  let output = '';
  for (const character of text) {
    if (Buffer.byteLength(`${output}${character}...`, 'utf8') > maxBytes) break;
    output += character;
  }
  return `${output}...`;
}

function compactEvidenceSection(heading, evidenceLines, emptyLine, byteBudget, label) {
  if (evidenceLines.length === 0) {
    return truncateUtf8Bytes(`${heading}\n${emptyLine}`, byteBudget);
  }

  const marker = `- [${label} compacted; additional rows remain in private SQLite.]`;
  const accepted = [heading];
  for (let index = 0; index < evidenceLines.length; index += 1) {
    const line = evidenceLines[index];
    const hasMore = index < evidenceLines.length - 1;
    const candidate = [...accepted, line, ...(hasMore ? [marker] : [])].join('\n');
    if (Buffer.byteLength(candidate, 'utf8') <= byteBudget) {
      accepted.push(line);
      continue;
    }

    // A pathological multibyte/identifier-heavy first row must still leave real evidence from
    // this class, not just its heading. Fit a byte-safe prefix alongside the compaction marker.
    if (accepted.length === 1) {
      const fixedBytes = Buffer.byteLength(`${heading}\n\n${marker}`, 'utf8');
      const clipped = truncateUtf8Bytes(line, Math.max(16, byteBudget - fixedBytes));
      if (clipped) accepted.push(clipped);
    }
    accepted.push(marker);
    break;
  }
  return accepted.join('\n');
}

function buildContextMarkdown(data) {
  const liked = data.statsByType.liked ?? 0;
  const disliked = data.statsByType.disliked ?? 0;
  const explicit = data.statsByType.explicit ?? 0;
  const hidden = data.statsByType.hidden ?? 0;
  const preamble = [
    '# Current Preference Evidence',
    '',
    'This is a bounded neutral evidence window. Signal types, reasons, sources, timestamps, and attention facts are descriptive inputs for an agent; this file does not infer favorites, relevance, or what to select or avoid.',
    '',
    `Stats: ${data.total} total (${liked} liked, ${disliked} disliked, ${explicit} explicit, ${hidden} hidden)`,
  ].join('\n');
  const explicitLines = [];

  if (data.explicitSignals.length > 0) {
    for (const row of data.explicitSignals) {
      const signal = String(row.signal_type || 'unknown').toUpperCase();
      const source = row.source ? ` source=${truncateText(row.source, 60)}` : '';
      const author = formatAuthorHandle(row.author_username);
      const attribution = author ? ` ${author}:` : '';
      const createdAt = row.created_at ? ` (${row.created_at})` : '';
      const userReason = row.reason && String(row.reason).trim()
        ? ` userReason="${truncateText(row.reason, 90)}"`
        : '';
      const agentReason = row.agent_reason && String(row.agent_reason).trim()
        ? ` itemReason="${truncateText(row.agent_reason, 90)}"`
        : '';
      explicitLines.push(`- [${signal}]${source}${attribution} "${truncateText(row.text, 180)}"${userReason}${agentReason}${createdAt}`);
    }
  }

  const attentionLines = [];
  if (data.behavioralAttention.length > 0) {
    for (const row of data.behavioralAttention) {
      const visits = Math.max(0, Number(row.visit_count) || 0);
      const returns = Math.max(0, Number(row.return_count) || 0);
      const source = truncateText(row.item_source || row.item_type || '', 50);
      const author = formatAuthorHandle(row.author_username);
      const attribution = [source, author].filter(Boolean).join('/');
      const content = row.title || row.text || row.feed_item_id;
      const lastOpened = row.last_opened_at ? ` (${row.last_opened_at})` : '';
      attentionLines.push(
        `- [ATTENTION] ${attribution ? `${attribution}: ` : ''}"${truncateText(content, 150)}" — `
        + `${visits} opens, ${returns} returns, ${formatDwellTime(row.total_dwell_ms)} active dwell, `
        + `${Math.max(0, Number(row.max_scroll_depth_pct) || 0)}% max depth, `
        + `userScrolled=${Number(row.user_scrolled) > 0}${lastOpened}`,
      );
    }
  }

  const threadLines = [];
  if (data.recentThreadFeedback.length > 0) {
    for (const row of data.recentThreadFeedback) {
      const title = row.thread_title || row.thread_id;
      const reason = row.reason && String(row.reason).trim()
        ? ` userReason="${truncateText(row.reason, 90)}"`
        : '';
      const category = row.category ? ` category=${truncateText(row.category, 60)}` : '';
      const uncertainty = row.probe_uncertainty
        ? ` uncertainty="${truncateText(row.probe_uncertainty, 80)}"`
        : '';
      const probeReason = row.probe_reason
        ? ` probe="${truncateText(row.probe_reason, 90)}"`
        : '';
      const sourceItems = Array.isArray(row.source_item_ids) && row.source_item_ids.length > 0
        ? ` sourceItems=${truncateText(row.source_item_ids.slice(0, 4).join(','), 220)}`
        : '';
      const createdAt = row.created_at ? ` (${row.created_at})` : '';
      threadLines.push(`- [${String(row.vote || 'unknown').toUpperCase()}] "${truncateText(title, 120)}" threadId=${truncateText(row.thread_id, 100)}${category}${uncertainty}${probeReason}${sourceItems}${reason}${createdAt}`);
    }
  }

  const footer = `_${CONTEXT_COMPACTION_NOTE}_`;
  // Reserve neutral representation for every evidence class before applying the global byte
  // boundary. Explicit signals receive half the payload and attention/thread facts one quarter
  // each; these are storage reservations, not relevance weights.
  const separators = '\n\n';
  const fixedBytes = Buffer.byteLength(
    `${preamble}${separators}${separators}${separators}${footer}\n`,
    'utf8',
  );
  const sectionBytes = Math.max(0, MAX_CONTEXT_BYTES - fixedBytes);
  const explicitBudget = Math.floor(sectionBytes / 2);
  const attentionBudget = Math.floor(sectionBytes / 4);
  const threadBudget = sectionBytes - explicitBudget - attentionBudget;
  const sections = [
    compactEvidenceSection(
      '## Explicit Signal Evidence (newest first)',
      explicitLines,
      '- No explicit signal evidence captured yet.',
      explicitBudget,
      'Explicit signal evidence',
    ),
    compactEvidenceSection(
      '## Behavioral Attention Facts (newest item-open first; not approval)',
      attentionLines,
      '- No detail-view sessions captured yet.',
      attentionBudget,
      'Behavioral attention evidence',
    ),
    compactEvidenceSection(
      '## Thread Feedback Evidence (newest first)',
      threadLines,
      '- No thread feedback captured yet.',
      threadBudget,
      'Thread feedback evidence',
    ),
  ];
  const markdown = `${preamble}${separators}${sections.join(separators)}${separators}${footer}\n`;
  if (Buffer.byteLength(markdown, 'utf8') > MAX_CONTEXT_BYTES) {
    throw new Error('Preference context section compaction exceeded its private byte boundary');
  }
  return markdown;
}

async function writePrivateFileAtomically(filePath, content) {
  const directory = path.dirname(filePath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  let handle = null;
  await fs.promises.mkdir(directory, { recursive: true });
  try {
    handle = await fs.promises.open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.promises.rename(temporaryPath, filePath);
    await fs.promises.chmod(filePath, 0o600);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fs.promises.unlink(temporaryPath).catch(() => {});
  }
}

async function regeneratePreferenceContext() {
  const dbPath = getDbPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  try {
    const markdown = buildContextMarkdown(readPreferenceRows(db));
    await writePrivateFileAtomically(outputPath, markdown);
    return outputPath;
  } finally {
    db.close();
  }
}

module.exports = {
  regeneratePreferenceContext,
  preferencesContextPath: outputPath,
};

if (require.main === module) {
  regeneratePreferenceContext()
    .then((writtenPath) => {
      process.stdout.write(`${writtenPath}\n`);
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}

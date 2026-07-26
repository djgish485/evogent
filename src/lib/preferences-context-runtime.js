const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const dataDir = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data'));
const defaultDbPath = path.join(dataDir, 'media-agent.db');
const outputPath = path.join(dataDir, 'preferences-context.md');
const MAX_CONTEXT_BYTES = 16 * 1024;
const CONTEXT_COMPACTION_NOTE = 'Raw preference and engagement evidence remains in the private SQLite database; this file is a bounded current profile.';

function getDbPath() {
  return process.env.MEDIA_AGENT_DB_PATH || defaultDbPath;
}

function truncateText(text, maxLength = 220) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

function formatAgentReason(reason) {
  const normalized = String(reason || '').trim();
  if (!normalized) return '';
  return ` (agent reason: "${truncateText(normalized, 90)}")`;
}

function formatPreferenceLine(row) {
  const author = row.author_username ? `@${row.author_username}: ` : '';
  const reason = row.reason && String(row.reason).trim()
    ? ` (user said: "${truncateText(row.reason, 90)}")`
    : '';
  return `- ${author}"${truncateText(row.text, 180)}"${reason}`;
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
  if (!tableExists(db, 'thread_feedback')) {
    return [];
  }

  return db.prepare(`
    SELECT
      thread_id,
      cycle_id,
      vote,
      thread_title,
      reason,
      category,
      probe_reason,
      probe_uncertainty,
      source_item_ids,
      origin_session_id,
      created_at
    FROM thread_feedback
    ORDER BY datetime(created_at) DESC, id DESC
    LIMIT 6
  `).all().map((row) => ({
    ...row,
    source_item_ids: parseJsonStringArray(row.source_item_ids),
  }));
}

function getDecayWeight(createdAt) {
  if (!createdAt) return 0.1;
  const timestamp = new Date(createdAt).getTime();
  if (Number.isNaN(timestamp)) return 0.1;

  const ageMs = Date.now() - timestamp;
  const sixMonths = 6 * 30 * 24 * 60 * 60 * 1000;
  const oneYear = 365 * 24 * 60 * 60 * 1000;
  const twoYears = 2 * oneYear;
  const fourYears = 4 * oneYear;

  if (ageMs < sixMonths) return 1.0;
  if (ageMs < oneYear) return 0.7;
  if (ageMs < twoYears) return 0.4;
  if (ageMs < fourYears) return 0.2;
  return 0.1;
}

function readBehavioralAttention(db) {
  if (!tableExists(db, 'feed_engagement_sessions')) {
    return [];
  }

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
    WHERE sessions.opened_at >= datetime('now', '-30 days')
    GROUP BY sessions.feed_item_id
    HAVING
      MAX(sessions.active_dwell_ms) >= 15000
      OR MAX(
        CASE
          WHEN sessions.active_dwell_ms >= 5000
            AND ${userScrolledSql} = 1
            AND sessions.max_scroll_depth_pct >= 25
          THEN 1
          ELSE 0
        END
      ) = 1
      OR (
        SUM(sessions.is_return) > 0
        AND SUM(sessions.active_dwell_ms) >= 10000
      )
    ORDER BY datetime(last_opened_at) DESC, sessions.feed_item_id ASC
    LIMIT 6
  `).all();
}

function readPreferenceRows(db) {
  if (!tableExists(db, 'preferences')) {
    return {
      total: 0,
      positives: [],
      negatives: [],
      statsByType: {},
      topAccounts: [],
      topAccountSamples: new Map(),
      topAccountReplySamples: new Map(),
      recentEngagement: [],
      recentThreadFeedback: readRecentThreadFeedback(db),
      behavioralAttention: readBehavioralAttention(db),
    };
  }

  const recentThreadFeedback = readRecentThreadFeedback(db);
  const behavioralAttention = readBehavioralAttention(db);

  const likedAccountRows = db.prepare(`
    SELECT
      author_username,
      COUNT(*) AS raw_cnt,
      SUM(
        CASE
          WHEN created_at >= datetime('now', '-6 months') THEN 1.0
          WHEN created_at >= datetime('now', '-1 year') THEN 0.7
          WHEN created_at >= datetime('now', '-2 years') THEN 0.4
          WHEN created_at >= datetime('now', '-4 years') THEN 0.2
          ELSE 0.1
        END
      ) AS cnt
    FROM preferences
    WHERE signal_type = 'liked'
      AND author_username IS NOT NULL
      AND author_username != ''
      AND author_username NOT LIKE 'e2e_%'
    GROUP BY author_username
    ORDER BY cnt DESC
  `).all();

  const ownTweetRows = db.prepare(`
    SELECT text, author_username, created_at
    FROM preferences
    WHERE source = 'twitter_archive_tweet'
      AND text IS NOT NULL
      AND text != ''
    ORDER BY datetime(created_at) DESC, id DESC
    LIMIT 5000
  `).all();

  const mentionRegex = /@([A-Za-z0-9_]+)/g;
  const utilityHandles = new Set(['threadreaderapp', 'threadreader', 'tweetpik', 'twtextapp']);
  const mentionCounts = new Map();
  const mentionDecayScores = new Map();
  const mentionDisplayHandles = new Map();
  const ownTweetAuthorHandles = new Set();

  for (const row of ownTweetRows) {
    const authorUsername = String(row.author_username || '').trim().replace(/^@/, '').toLowerCase();
    if (authorUsername && !authorUsername.startsWith('e2e_')) {
      ownTweetAuthorHandles.add(authorUsername);
    }

    const text = String(row.text || '');
    mentionRegex.lastIndex = 0;
    let match = mentionRegex.exec(text);

    while (match) {
      const rawHandle = String(match[1] || '').trim();
      const handle = rawHandle.toLowerCase();

      if (!handle || handle.startsWith('e2e_') || utilityHandles.has(handle)) {
        match = mentionRegex.exec(text);
        continue;
      }

      const decayWeight = getDecayWeight(row.created_at);
      mentionCounts.set(handle, (mentionCounts.get(handle) || 0) + 1);
      mentionDecayScores.set(handle, (mentionDecayScores.get(handle) || 0) + decayWeight);
      if (!mentionDisplayHandles.has(handle)) {
        mentionDisplayHandles.set(handle, rawHandle);
      }

      match = mentionRegex.exec(text);
    }
  }

  for (const handle of ownTweetAuthorHandles) {
    mentionCounts.delete(handle);
    mentionDecayScores.delete(handle);
    mentionDisplayHandles.delete(handle);
  }

  const accountStats = new Map();
  for (const row of likedAccountRows) {
    const authorUsername = String(row.author_username || '').trim();
    if (!authorUsername) continue;

    const authorKey = authorUsername.replace(/^@/, '').toLowerCase();
    const existing = accountStats.get(authorKey) || {
      author_key: authorKey,
      author_username: authorUsername,
      likeCount: 0,
      mentionCount: 0,
      decayedLikeScore: 0,
      decayedMentionScore: 0,
      composite: 0,
    };

    existing.likeCount += Number(row.raw_cnt) || 0;
    existing.decayedLikeScore += Number(row.cnt) || 0;
    existing.composite = existing.decayedLikeScore + existing.decayedMentionScore;
    if (!existing.author_username) {
      existing.author_username = authorUsername;
    }

    accountStats.set(authorKey, existing);
  }

  for (const [authorKey, mentionCount] of mentionCounts.entries()) {
    const existing = accountStats.get(authorKey) || {
      author_key: authorKey,
      author_username: mentionDisplayHandles.get(authorKey) || authorKey,
      likeCount: 0,
      mentionCount: 0,
      decayedLikeScore: 0,
      decayedMentionScore: 0,
      composite: 0,
    };

    const mentionDecayScore = Number(mentionDecayScores.get(authorKey)) || 0;
    existing.mentionCount += mentionCount;
    existing.decayedMentionScore += mentionDecayScore;
    existing.composite = existing.decayedLikeScore + existing.decayedMentionScore;
    if (!existing.author_username) {
      existing.author_username = mentionDisplayHandles.get(authorKey) || authorKey;
    }

    accountStats.set(authorKey, existing);
  }

  const topAccounts = Array.from(accountStats.values())
    .filter((row) => row.composite > 0)
    .sort((a, b) => {
      if (b.composite !== a.composite) return b.composite - a.composite;
      if (b.decayedMentionScore !== a.decayedMentionScore) return b.decayedMentionScore - a.decayedMentionScore;
      if (b.decayedLikeScore !== a.decayedLikeScore) return b.decayedLikeScore - a.decayedLikeScore;
      if (b.mentionCount !== a.mentionCount) return b.mentionCount - a.mentionCount;
      if (b.likeCount !== a.likeCount) return b.likeCount - a.likeCount;
      return String(a.author_username || '').localeCompare(String(b.author_username || ''));
    })
    .slice(0, 10);

  const likedTopAccountKeys = topAccounts
    .filter((row) => row.likeCount > 0)
    .map((row) => String(row.author_key || '').trim())
    .filter((authorKey) => authorKey.length > 0);
  const topAccountSamples = new Map();
  const topAccountReplySamples = new Map();

  if (likedTopAccountKeys.length > 0) {
    const placeholders = likedTopAccountKeys.map(() => '?').join(', ');
    const sampleRows = db.prepare(`
      SELECT author_username, text
      FROM preferences
      WHERE signal_type = 'liked'
        AND LOWER(LTRIM(author_username, '@')) IN (${placeholders})
        AND text IS NOT NULL
        AND text != ''
      ORDER BY weight DESC, created_at DESC
    `).all(...likedTopAccountKeys);

    for (const row of sampleRows) {
      const username = String(row.author_username || '').trim().replace(/^@/, '').toLowerCase();
      const text = String(row.text || '').trim();
      if (!username || !text) continue;

      const currentSamples = topAccountSamples.get(username) || [];
      if (currentSamples.includes(text) || currentSamples.length >= 3) continue;
      currentSamples.push(text);
      topAccountSamples.set(username, currentSamples);
    }
  }

  for (const row of topAccounts) {
    if (row.mentionCount <= 0) continue;
    const existingLikedSamples = topAccountSamples.get(row.author_key) || [];
    if (existingLikedSamples.length > 0) continue;

    const handle = String(row.author_username || '').replace(/^@/, '').trim();
    if (!handle) continue;

    const replyRows = db.prepare(`
      SELECT text
      FROM preferences
      WHERE source = 'twitter_archive_tweet'
        AND text IS NOT NULL
        AND text != ''
        AND LOWER(text) LIKE LOWER(?)
      ORDER BY datetime(created_at) DESC, id ASC
      LIMIT 1
    `).all(`@${handle}%`);

    const uniqueSamples = [];
    for (const replyRow of replyRows) {
      const text = String(replyRow.text || '').trim();
      if (!text || uniqueSamples.includes(text)) continue;
      uniqueSamples.push(text);
    }

    if (uniqueSamples.length > 0) {
      topAccountReplySamples.set(row.author_key, uniqueSamples);
    }
  }

  const recentEngagement = db.prepare(`
    SELECT
      preferences.author_username,
      preferences.text,
      preferences.created_at,
      preferences.signal_type,
      preferences.reason,
      feed.reason AS agent_reason
    FROM preferences
    LEFT JOIN feed ON feed.id = preferences.feed_item_id
    WHERE (
      (preferences.signal_type IN ('liked', 'explicit')
        AND preferences.source IN ('app_like', 'app_thumbsup', 'twitter_like', 'twitter_bookmark'))
      OR (
        preferences.signal_type = 'disliked'
        AND preferences.source IN ('app_dislike', 'app_thumbsdown')
      )
      OR preferences.source = 'app_thread_feedback_probe'
    )
      AND (preferences.author_username IS NULL OR preferences.author_username NOT LIKE 'e2e_%')
    ORDER BY preferences.created_at DESC
    LIMIT 6
  `).all();

  const totalRow = db.prepare(`SELECT COUNT(*) AS count FROM preferences`).get();
  const total = totalRow.count;

  const byTypeRows = db.prepare(`
    SELECT signal_type, COUNT(*) AS count
    FROM preferences
    GROUP BY signal_type
  `).all();

  const statsByType = Object.fromEntries(byTypeRows.map((row) => [row.signal_type, row.count]));

  if (total < 100) {
    const rows = db.prepare(`
      SELECT id, signal_type, text, reason, author_username, weight, created_at
      FROM preferences
      ORDER BY weight DESC, created_at DESC
    `).all();

    return {
      total,
      positives: rows.filter((row) => ['liked', 'bookmarked', 'explicit'].includes(row.signal_type)),
      negatives: rows.filter((row) => ['disliked', 'hidden'].includes(row.signal_type)),
      statsByType,
      topAccounts,
      topAccountSamples,
      topAccountReplySamples,
      recentEngagement,
      recentThreadFeedback,
      behavioralAttention,
    };
  }

  // Sample diversely across signal sources for a useful context window.
  const appLikes = db.prepare(`
    SELECT id, signal_type, text, reason, author_username, weight, created_at
    FROM preferences
    WHERE signal_type = 'liked' AND source IN ('app_like', 'app_thumbsup', 'app_thread_feedback_probe', 'twitter_like', 'twitter_bookmark')
    ORDER BY weight DESC, created_at DESC
    LIMIT 5
  `).all();

  const interests = db.prepare(`
    SELECT id, signal_type, text, reason, author_username, weight, created_at
    FROM preferences
    WHERE signal_type = 'explicit' AND source = 'twitter_archive_interest'
    ORDER BY weight DESC, datetime(created_at) DESC, id ASC
    LIMIT 4
  `).all();

  const likedTweets = db.prepare(`
    SELECT id, signal_type, text, reason, author_username, weight, created_at
    FROM preferences
    WHERE signal_type = 'liked' AND source = 'twitter_archive_like'
      AND LENGTH(text) > 40
    ORDER BY weight DESC, datetime(created_at) DESC, id ASC
    LIMIT 4
  `).all();

  const ownTweets = db.prepare(`
    SELECT id, signal_type, text, reason, author_username, weight, created_at
    FROM preferences
    WHERE signal_type = 'explicit' AND source = 'twitter_archive_tweet'
      AND LENGTH(text) > 30
    ORDER BY weight DESC, datetime(created_at) DESC, id ASC
    LIMIT 3
  `).all();

  const positives = [...appLikes, ...interests, ...likedTweets, ...ownTweets];

  const appDislikes = db.prepare(`
    SELECT id, signal_type, text, reason, author_username, weight, created_at
    FROM preferences
    WHERE signal_type IN ('disliked', 'hidden') AND source IN ('app_dislike', 'app_hide', 'app_thumbsdown', 'app_thread_feedback_probe')
    ORDER BY weight DESC, created_at DESC
    LIMIT 5
  `).all();

  const blockCount = db.prepare(`
    SELECT COUNT(*) AS count FROM preferences
    WHERE source IN ('twitter_archive_block', 'twitter_archive_mute')
  `).get().count;

  const negatives = appDislikes;

  return {
    total,
    positives,
    negatives,
    statsByType,
    blockCount,
    topAccounts,
    topAccountSamples,
    topAccountReplySamples,
    recentEngagement,
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

function enforceContextByteLimit(markdown) {
  if (Buffer.byteLength(markdown, 'utf8') <= MAX_CONTEXT_BYTES) {
    return markdown;
  }

  const marker = `\n\n_[Profile compacted to ${MAX_CONTEXT_BYTES} bytes. ${CONTEXT_COMPACTION_NOTE}]_\n`;
  const accepted = [];
  for (const line of markdown.split('\n')) {
    const nextLines = [...accepted, line].join('\n');
    if (Buffer.byteLength(`${nextLines}${marker}`, 'utf8') > MAX_CONTEXT_BYTES) break;
    accepted.push(line);
  }
  return `${accepted.join('\n')}${marker}`;
}

function buildContextMarkdown(data) {
  const liked = data.statsByType.liked ?? 0;
  const disliked = data.statsByType.disliked ?? 0;
  const explicit = data.statsByType.explicit ?? 0;
  const hidden = data.statsByType.hidden ?? 0;

  const lines = [
    '# Current User Preference Profile',
    '',
    'Explicit votes and user-written reasons are preference evidence. Behavioral attention below is descriptive curiosity, not approval; use repeated or long attention only as weak supporting evidence.',
    '',
    `Stats: ${data.total} total (${liked} liked, ${disliked} disliked, ${explicit} explicit, ${hidden} hidden)`,
    '',
    '## Recent Explicit Engagement (newest first):',
  ];

  if ((data.recentEngagement || []).length === 0) {
    lines.push('- No recent likes/votes captured yet.');
  } else {
    for (const row of data.recentEngagement.slice(0, 6)) {
      const author = formatAuthorHandle(row.author_username);
      const authorPrefix = author ? `${author}: ` : '';
      const createdAt = row.created_at ? ` (${row.created_at})` : '';
      const agentReason = formatAgentReason(row.agent_reason);
      const reason = row.reason && String(row.reason).trim()
        ? ` (user said: "${truncateText(row.reason, 90)}")`
        : '';
      const engagementLabel = row.signal_type === 'disliked'
        ? '[DISLIKED] '
        : row.signal_type === 'liked'
          ? '[LIKED] '
          : row.signal_type === 'explicit'
            ? '[EXPLICIT] '
            : '';
      lines.push(`- ${engagementLabel}${authorPrefix}"${truncateText(row.text, 180)}"${agentReason}${reason}${createdAt}`);
    }
  }

  lines.push('');
  lines.push('## Behavioral Attention (last 30 days; weak evidence):');

  if ((data.behavioralAttention || []).length === 0) {
    lines.push('- No meaningful detail-view sessions captured yet.');
  } else {
    for (const row of data.behavioralAttention.slice(0, 6)) {
      const visits = Math.max(1, Number(row.visit_count) || 1);
      const returns = Math.max(0, Number(row.return_count) || 0);
      const author = formatAuthorHandle(row.author_username);
      const source = truncateText(row.item_source || row.item_type || '', 50);
      const attribution = [source, author].filter(Boolean).join('/');
      const content = row.title || row.text || row.feed_item_id;
      const evidence = [
        `${visits} ${visits === 1 ? 'open' : 'opens'}`,
        returns > 0 ? `${returns} ${returns === 1 ? 'return' : 'returns'}` : null,
        `${formatDwellTime(row.total_dwell_ms)} active dwell`,
        `${Math.max(0, Number(row.max_scroll_depth_pct) || 0)}% max depth`,
      ].filter(Boolean).join(', ');
      const prefix = attribution ? `${attribution}: ` : '';
      const lastOpened = row.last_opened_at ? ` (${row.last_opened_at})` : '';
      lines.push(`- [ATTENTION] ${prefix}"${truncateText(content, 150)}" — ${evidence}${lastOpened}`);
    }
  }

  lines.push('');
  lines.push('## Recent Thread Feedback Probes:');

  if ((data.recentThreadFeedback || []).length === 0) {
    lines.push('- No feedback-probe thread votes captured yet.');
  } else {
    for (const row of data.recentThreadFeedback.slice(0, 4)) {
      const vote = row.vote === 'more' ? '[MORE]' : '[LESS]';
      const title = row.thread_title || row.thread_id;
      const reason = row.reason && String(row.reason).trim()
        ? ` (user said: "${truncateText(row.reason, 90)}")`
        : '';
      const category = row.category ? ` category=${truncateText(row.category, 60)}` : '';
      const uncertainty = row.probe_uncertainty ? ` uncertainty="${truncateText(row.probe_uncertainty, 80)}"` : '';
      const probeReason = row.probe_reason ? ` probe="${truncateText(row.probe_reason, 90)}"` : '';
      const sourceItems = Array.isArray(row.source_item_ids) && row.source_item_ids.length > 0
        ? ` sourceItems=${row.source_item_ids.slice(0, 4).join(',')}`
        : '';
      const createdAt = row.created_at ? ` (${row.created_at})` : '';
      lines.push(`- ${vote} "${truncateText(title, 120)}" threadId=${row.thread_id}${category}${uncertainty}${probeReason}${sourceItems}${reason}${createdAt}`);
    }
  }

  lines.push('');
  lines.push('## Top Engaged Accounts:');

  if ((data.topAccounts || []).length === 0) {
    lines.push('- No engaged accounts captured yet.');
  } else {
    const topAccountSamples = data.topAccountSamples instanceof Map ? data.topAccountSamples : new Map();
    const topAccountReplySamples = data.topAccountReplySamples instanceof Map ? data.topAccountReplySamples : new Map();
    for (const row of data.topAccounts.slice(0, 8)) {
      const author = formatAuthorHandle(row.author_username) || '@unknown';
      const likes = Number(row.likeCount || row.cnt || 0);
      const replies = Number(row.mentionCount || 0);
      const countParts = [];
      if (replies > 0) countParts.push(`${replies} ${replies === 1 ? 'reply' : 'replies'}`);
      if (likes > 0) countParts.push(`${likes} ${likes === 1 ? 'liked item' : 'liked items'}`);
      lines.push(`- ${author} (${countParts.join(', ')}):`);

      const authorKey = String(row.author_key || row.author_username || '').trim().toLowerCase();
      const likedSamples = topAccountSamples.get(authorKey) || [];
      const replySamples = topAccountReplySamples.get(authorKey) || [];
      const samples = likedSamples.length > 0 ? likedSamples.slice(0, 1) : replySamples.slice(0, 1);
      for (const sample of samples) {
        lines.push(`  - "${truncateText(sample, 130)}"`);
      }
    }
  }

  lines.push('');
  lines.push('## Content the user LIKES (select similar):');
  if (data.positives.length === 0) {
    lines.push('- No positive preference signals captured yet.');
  } else {
    for (const row of data.positives.slice(0, 6)) {
      lines.push(formatPreferenceLine(row));
    }
  }

  lines.push('');
  lines.push('## Content the user DISLIKES (avoid similar):');
  if (data.negatives.length === 0) {
    lines.push('- No negative preference signals captured yet.');
  } else {
    for (const row of data.negatives.slice(0, 5)) {
      lines.push(formatPreferenceLine(row));
    }
  }

  if (data.blockCount && data.blockCount > 0) {
    lines.push('');
    lines.push(`Note: ${data.blockCount} blocked/muted accounts from Twitter archive are also tracked but omitted here.`);
  }

  lines.push('');
  lines.push(`_${CONTEXT_COMPACTION_NOTE}_`);
  return enforceContextByteLimit(`${lines.join('\n')}\n`);
}

async function writePrivateFileAtomically(filePath, content) {
  const directory = path.dirname(filePath);
  const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
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
    if (handle) {
      await handle.close().catch(() => {});
    }
    await fs.promises.unlink(temporaryPath).catch(() => {});
  }
}

async function regeneratePreferenceContext() {
  const dbPath = getDbPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  try {
    const data = readPreferenceRows(db);
    const markdown = buildContextMarkdown(data);
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

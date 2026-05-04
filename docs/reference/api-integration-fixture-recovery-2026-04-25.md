# API Integration Fixture Recovery: 2026-04-25

Run this only after the integration-test isolation guard is deployed and reviewed.

The selection is bounded by the leak window plus known fixture message IDs, message ID prefixes, and session titles. Do not broaden it to title-only deletes.

## Review

```sql
WITH
known_titles(title) AS (
  VALUES
    ('First session'), ('Second session'), ('Older session'),
    ('Curator Session'), ('Normal Session'), ('Morning Dispatch'),
    ('Iran-only curator'), ('Codex Session'), ('Claude Session'),
    ('Claude Reasoning Test'), ('Docs Review'), ('General Chat'),
    ('Session 87'), ('Session 88')
),
known_message_ids(id) AS (
  VALUES
    ('api-chat-sessions-first'),
    ('api-chat-sessions-second'),
    ('api-chat-session-filter-1'),
    ('api-chat-session-filter-2')
),
known_message_prefixes(prefix) AS (
  VALUES ('msg-2a10'), ('msg-a94d'), ('msg-4b7c'), ('msg-4ebc'), ('msg-58d')
),
fixture_sessions(id) AS (
  SELECT DISTINCT s.id
  FROM chat_sessions AS s
  LEFT JOIN chat_messages AS m ON m.session_id = s.id
  WHERE (
      s.title IN (SELECT title FROM known_titles)
      AND datetime(s.created_at) BETWEEN datetime('2026-04-25 16:07:41') AND datetime('2026-04-25 16:07:52')
    )
    OR m.id IN (SELECT id FROM known_message_ids)
    OR (
      datetime(m.timestamp) BETWEEN datetime('2026-04-25 16:07:41') AND datetime('2026-04-25 16:07:52')
      AND EXISTS (
        SELECT 1
        FROM known_message_prefixes
        WHERE m.id LIKE prefix || '%'
      )
    )
)
SELECT s.id, s.title, s.created_at, s.updated_at, COUNT(m.id) AS message_count
FROM fixture_sessions AS f
JOIN chat_sessions AS s ON s.id = f.id
LEFT JOIN chat_messages AS m ON m.session_id = f.id
GROUP BY s.id, s.title, s.created_at, s.updated_at
ORDER BY s.created_at, s.title;
```

## Delete

After the review query returns only the leaked fixtures, run the same `WITH` block inside this transaction:

```sql
BEGIN;

CREATE TEMP TABLE api_fixture_sessions_20260425 (id TEXT PRIMARY KEY);

INSERT OR IGNORE INTO api_fixture_sessions_20260425 (id)
WITH
known_titles(title) AS (
  VALUES
    ('First session'), ('Second session'), ('Older session'),
    ('Curator Session'), ('Normal Session'), ('Morning Dispatch'),
    ('Iran-only curator'), ('Codex Session'), ('Claude Session'),
    ('Claude Reasoning Test'), ('Docs Review'), ('General Chat'),
    ('Session 87'), ('Session 88')
),
known_message_ids(id) AS (
  VALUES ('api-chat-sessions-first'), ('api-chat-sessions-second'), ('api-chat-session-filter-1'), ('api-chat-session-filter-2')
),
known_message_prefixes(prefix) AS (
  VALUES ('msg-2a10'), ('msg-a94d'), ('msg-4b7c'), ('msg-4ebc'), ('msg-58d')
)
SELECT DISTINCT s.id
FROM chat_sessions AS s
LEFT JOIN chat_messages AS m ON m.session_id = s.id
WHERE (
    s.title IN (SELECT title FROM known_titles)
    AND datetime(s.created_at) BETWEEN datetime('2026-04-25 16:07:41') AND datetime('2026-04-25 16:07:52')
  )
  OR m.id IN (SELECT id FROM known_message_ids)
  OR (
    datetime(m.timestamp) BETWEEN datetime('2026-04-25 16:07:41') AND datetime('2026-04-25 16:07:52')
    AND EXISTS (SELECT 1 FROM known_message_prefixes WHERE m.id LIKE prefix || '%')
  );

DELETE FROM chat_messages WHERE session_id IN (SELECT id FROM api_fixture_sessions_20260425);
DELETE FROM chat_session_brain_settings WHERE session_id IN (SELECT id FROM api_fixture_sessions_20260425);
DELETE FROM chat_sessions WHERE id IN (SELECT id FROM api_fixture_sessions_20260425);
DROP TABLE api_fixture_sessions_20260425;

COMMIT;
```

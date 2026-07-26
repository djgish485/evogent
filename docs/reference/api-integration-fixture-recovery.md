# API integration fixture recovery

Integration tests must use an isolated database. They must never point at a
deployment's private runtime database. The isolation guard is the primary
control; cleanup is an exceptional incident-response procedure.

If test fixtures reach a private runtime database:

1. Stop the test path that caused the leak and deploy its isolation guard.
2. Take a checked private backup before changing runtime data.
3. Derive an exact candidate set from private incident evidence: bounded
   timestamps, fixture-generated identifiers, and test-only relationships.
4. Review every candidate alongside its parent session and related rows.
5. Delete only the reviewed identifiers inside one transaction.
6. Verify normal sessions still exist, rerun the isolation test against a
   disposable database, and record the live evidence in private operations
   notes.

Do not commit incident timestamps, session titles, message fragments, account
identifiers, or generated fixture IDs. Do not use title-only or time-only
deletion predicates: either can match legitimate private data.

A safe cleanup should materialize the reviewed identifiers explicitly before
deletion:

```sql
BEGIN;

CREATE TEMP TABLE reviewed_fixture_sessions (
  id TEXT PRIMARY KEY
);

-- Populate only with identifiers copied from the privately reviewed candidate
-- set. Never derive this table from a broad title or timestamp predicate.
INSERT INTO reviewed_fixture_sessions (id)
VALUES ('<reviewed-fixture-session-id>');

DELETE FROM chat_messages
WHERE session_id IN (SELECT id FROM reviewed_fixture_sessions);

DELETE FROM chat_session_brain_settings
WHERE session_id IN (SELECT id FROM reviewed_fixture_sessions);

DELETE FROM chat_sessions
WHERE id IN (SELECT id FROM reviewed_fixture_sessions);

DROP TABLE reviewed_fixture_sessions;
COMMIT;
```

Run the review query and final verification in private operator tooling. The
public repository should retain the isolation mechanism and source-neutral
procedure, not the deployment incident.

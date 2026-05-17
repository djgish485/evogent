---
name: archive-import
description: Import your Twitter/X data export to teach the agent your content preferences. Imports likes, interests, tweets, blocks, and mutes as preference signals that guide future curation.
user-invocable: true
metadata:
  evogent:
    heartbeat-task: false
    requires:
      env: []
---
# Twitter Archive Import

Import your Twitter/X data export to teach the agent your preferences. Your likes, interests, and tweets become positive signals. Your blocks and mutes become negative signals. These preference signals guide every future curation cycle.

## For the User

### Step 1: Request your Twitter archive
1. Go to x.com (or the X app)
2. Settings -> Your Account -> Download an archive of your data
3. Enter your password and confirm
4. Twitter will email you when the archive is ready (usually 24-48 hours)
5. Download the zip file when you get the email

### Step 2: Upload to the server
Upload the zip file to the VM where evogent runs:
```bash
scp ~/Downloads/twitter-archive.zip user@your-server:/tmp/
```

### Step 3: Tell the agent to import
In the inline chat, say: "Import my Twitter archive from /tmp/twitter-archive.zip"

The agent will handle extraction, import, and cleanup.

## For the Brain (execution steps)

When a user asks you to import their Twitter archive:

0. Resolve the active app base first:
```bash
API_BASE="${MEDIA_AGENT_INTERNAL_BASE_URL:-http://127.0.0.1:${PORT:-3001}}"
```

1. Resolve the archive path from the user message or uploaded attachment metadata. Chat setup may provide an uploaded zip path directly.

2. Extract the zip:
```bash
ARCHIVE_PATH="/path/from-the-user-message-or-attachment"
EXTRACT_DIR="$(mktemp -d /tmp/twitter-archive.XXXXXX)"
unzip -o "$ARCHIVE_PATH" -d "$EXTRACT_DIR/"
```

3. Find the data directory. It may be at `$EXTRACT_DIR/data/` or nested inside another directory. Look for files like like.js, tweets.js, personalization.js.

4. Call the import API:
```bash
curl -s -X POST "$API_BASE/api/import-archive" \
  -H 'Content-Type: application/json' \
  -d "{\"archivePath\": \"$EXTRACT_DIR\"}"
```

5. Report the results to the user in chat, including how many items were imported per category.

6. If the vectorize-preferences script exists, run it for bulk embedding generation:
```bash
npx tsx scripts/vectorize-preferences.ts
```

7. After a successful import, mark the setup step complete:
```bash
curl -s -X PATCH "$API_BASE/api/setup/import_archive" \
  -H 'Content-Type: application/json' \
  -d '{"status":"complete"}'
```

8. Clean up:
```bash
rm -rf "$EXTRACT_DIR" "$ARCHIVE_PATH"
```

## What Gets Imported

| Data | What it teaches the agent | Weight | Signal |
|------|--------------------------|--------|--------|
| Your interests (personalization.js) | Topics you follow on Twitter | 2.0 (strongest) | Positive |
| Your likes (like.js) | Content you engaged with positively | 1.0 | Positive |
| Your tweets (tweets.js) | Topics you care enough to post about | 0.8 | Positive |
| Your blocks (block.js) | Accounts/content to strongly avoid | 2.0 | Negative |
| Your mutes (mute.js) | Content to quietly deprioritize | 1.5 | Negative |

## After Import

- preferences-context.md auto-regenerates with the new signals
- The next OpenClaw curator run will use these preferences to guide content selection
- You can check the stats: GET /api/preferences
- Typical import size: 17,000-20,000 preferences from an active Twitter account

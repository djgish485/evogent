# Development

Evogent is a Next.js app with a custom Node runtime. Android is the canonical
production environment; local and VM profiles remain useful for development,
tests, and the public demo. Read
[`docs/phone-production.md`](phone-production.md) before changing phone runtime
ownership.

The orchestrator runs queued tasks as ephemeral brain-provider sessions. Those
tasks submit feed and chat output through local internal APIs backed by SQLite.

## Commands

```bash
npm run build
npm run test
npm run lint
npx tsx scripts/seed-test-data.ts
```

For local development:

```bash
npm run build && npm start
node worker.js
```

The optional worker needs Redis in a local/VM profile. A phone profile deliberately
does not run Redis or a worker:

```bash
EVOGENT_RUNTIME_PROFILE=phone \
LISTEN_HOST=127.0.0.1 \
MEDIA_AGENT_DISABLE_BACKGROUND_JOBS=1 \
npm start
```

Use `phone-paradigm/device/start-prod.sh` on the device so all provider and
runtime variables come from one canonical start path.

## Runtime Shape

```text
Phone scheduler signal -> one leased cycle
  -> source mechanics + runtime-agent judgment
  -> local internal APIs
  -> SQLite -> WebSocket -> Android HOME WebView
```

In the phone profile, adaptive heartbeat writes a durable scheduler signal.
Accepted code-fix suggestions wait for host review; the phone does not launch
software-development agents.

## Key Runtime Files

- `data/feed-output.jsonl` is the curated feed item and background analysis fallback output.
- `data/chat-output.jsonl` is an audit log for chat replies already persisted through `/api/internal/chat/submit`.
- `data/preference-insights.md` stores synthesized preference patterns maintained by the daily private overseer.
- `data/tracked-events.json` stores current event tracking lifecycle data.

These are deployment-private instances. Commit general mechanisms and
`.default.md` templates, never a user's populated data, account identifiers, or
device connection details.

## Phone release and verification

The current direct-copy and `.next` deploy scripts are transitional. The release
contract is one immutable, versioned bundle containing compatible web, server,
library, skills, mechanics, and APK state, with atomic activation, health check,
and rollback. Do not invent a new release command until that workflow has a
canonical implementation.

For user-visible phone work, automated checks are followed by a normal
scheduler-owned browse → cache → score → curate → arrange cycle, inspection on
physical display 0, and observation of a naturally scheduled cycle.

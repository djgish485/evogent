# Security Hardening: Removing Bash from the Ephemeral Runtime

## Why This Matters

Evogent executes queued work by spawning ephemeral `claude -p` tasks. If those tasks run with `--permission-mode dontAsk` and Bash enabled, any reachable chat/ping surface can become a command-execution path.

If the app is network-exposed without auth, this is effectively unauthenticated remote code execution.

Removing Bash from default task tools is the highest-impact control. It reduces attack surface from shell execution to controlled file/web operations.

## Current Bash Dependencies (Audit)

| Use Case | Current Implementation | Replacement |
|---|---|---|
| **Bird CLI (Twitter)** | `node .../bird/dist/cli.js ...` via Bash | Internal Twitter proxy API on localhost |
| **Nested task spawning in commands** | `claude -p ... &` in command docs | Remove nesting; orchestrator already spawns tasks |
| **Credential loading in task process** | Shell export patterns | Keep creds server-side; task uses internal API |
| **Dedup checking** | `grep -c sourceId feed-output.jsonl` | Grep tool or dedup API |
| **JSONL appending** | `echo '{...}' >> ...` | Write tool |
| **Status file I/O** | shell/file writes for `*-status.json` | Read/Write tools |
| **Skill install calls** | `curl` from task process | WebFetch tool |

After removing nested spawn patterns, Bird CLI remains the primary hard Bash dependency.

## Implementation Steps

### Step 1: Bird CLI Proxy

Build localhost-only internal endpoints that execute Bird server-side with env credentials:

```text
GET /api/internal/twitter/home?n=40&following=false
GET /api/internal/twitter/search?q=AI+agents&n=15
GET /api/internal/twitter/user-tweets?username=karpathy&n=10
GET /api/internal/twitter/news
GET /api/internal/twitter/whoami
```

Requirements:
- Process executes in server context with `AUTH_TOKEN`/`CT0`
- Return parsed JSON only
- Restrict to localhost requests

Security gain:
- Runtime tasks no longer need direct cookie access
- Prompt-injected task output cannot leak raw Twitter credentials

### Step 2: Eliminate Nested Spawning in Command Instructions

Ensure command files (`/curate`, `/reflect`) execute work inline instead of launching child `claude -p` processes.

Security gain:
- Removes recursion and uncontrolled process trees
- Centralizes all task spawning in orchestrator queue logic (`server.js`)

### Step 3: Remove Bash from Default Task Tools

When Steps 1 and 2 are complete, set runtime tool policy in `server.js`/env so default task tools exclude Bash:

```text
Read,Write,WebFetch,WebSearch,Glob,Grep
```

Update runtime guidance (`CLAUDE.md` and command files):
- Bird calls move to internal API fetches
- JSONL append via Write tool
- Dedup via Grep tool or dedicated API

### Step 4: Additional Hardening (Recommended)

- [ ] Bind to localhost by default (`HOST=127.0.0.1` when not intentionally exposed)
- [ ] Put auth above the app for network-exposed deployments with Cloudflare Access, proxy-level basic auth, IP allowlists, a VPN, or an equivalent deployment-layer control
- [ ] Run service as dedicated non-root user (`evogent`)
- [ ] Rate-limit chat/ping/enqueue endpoints
- [ ] Validate import paths for `/api/import-archive`
- [ ] Restrict skill install source to registry only
- [ ] Redact credential-like patterns from logs/transcripts

## Verification Checklist

1. Runtime tasks start without Bash in `--allowedTools`
2. `POST /api/ping` with shell-injection prompt cannot execute shell commands
3. Twitter access still works through internal proxy
4. Curation/reflection/enrichment still complete successfully
5. `.env.local` secrets do not appear in task outputs/logs
6. Mutating endpoints require auth in network-exposed deployments

## Risk Assessment

| State | Attack via chat/ping | Impact |
|---|---|---|
| **Current** (Bash + root + no auth) | Full host command execution | Critical |
| **After Steps 1-3** (no Bash) | File/web misuse within task sandbox | Low-Medium |
| **After Step 4** (+ auth + non-root + rate limits) | Auth required and reduced privilege | Low |

## Source

Based on research analyses from 2026-03-03. Reference logs:
- `/root/.clawdbot/logs/research/research-security-setup-claude/output.txt`
- `/root/.clawdbot/logs/research/research-security-setup-codex/output.txt`
- `/root/.clawdbot/logs/research/research-security-setup-gemini/output.txt`

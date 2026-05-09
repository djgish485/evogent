# Setup Guide for Coding Agents

If you are a coding agent (Claude Code, Codex, Gemini) installing Evogent for a user, follow this guide. It covers everything from system setup to personalization.

Before you run commands, tell the user what Evogent is in plain product language: a personal AI-curated feed that learns what they are trying to understand. Then state that setup will cover install -> sources -> skills -> archive import -> launch. If you can only describe the tech stack, stop and reread this section first.

The hard readiness command for coding agents is:

```bash
npm run setup:agent
```

Run it after dependency/build setup and again before declaring the install complete. It prints `READY`, `PENDING`, and `REQUIRED` lines and exits nonzero while a runnable brain provider or content source is missing. Do not call the install complete until it has no `REQUIRED` lines.

In `.evogent-mode.md`, `mergeTarget: <branch>` retargets `suggestion-remote` auto-merge and push from `main` to that branch when `mergeAfterGates: true`.

### Phase 1: System Setup

Choose the platform path that matches the machine. `scripts/setup.sh` is Linux-only because it installs systemd services and cron jobs.

#### Linux / systemd install

These steps require no user input:

```bash
git clone https://github.com/djgish485/evogent.git evogent
cd evogent
npm install
npm run build
cp .env.example .env.local
npm run setup:agent
sudo bash scripts/setup.sh
```

#### macOS local install

Do not run `scripts/setup.sh` on macOS. For a local install, use the same repo setup steps, then run the app and worker directly:

```bash
git clone https://github.com/djgish485/evogent.git evogent
cd evogent
npm install
npm run build
cp .env.example .env.local
mkdir -p data
npm run setup:agent
npm start
```

The worker needs Redis for background jobs. On macOS, install and start it with `brew install redis && brew services start redis` before running `node worker.js`.

In a second terminal from the same repo:

```bash
cd evogent
node worker.js
```

Then continue to Phase 2. That phase asks for explicit user choices, writes `data/config.md`, configures only the selected sources, and completes the install.

During browser-backed source login on macOS, keep `npm start` running so the app stays available, but make background source browsing quiet before the user enters credentials. Turn **Background Source Browsing** off in Settings, or set `## Background Source Browsing` to `Off` in `data/config.md`. The worker can stay running with that setting off; it will not enqueue scheduled source refreshes, but it can still process the one explicit setup-smoke refresh after login.

#### Windows local install

Do not run `scripts/setup.sh` on Windows either. Follow the same manual local path as macOS: install dependencies, copy `.env.example` to `.env.local`, then run the web app and `node worker.js` separately.

The worker needs Redis for background jobs. On Windows, use Redis in WSL2 or a Windows-compatible Redis service such as Memurai before running `node worker.js`.

Run `npm run setup:agent` on Windows before and after configuring sources. It will print the remaining required setup and the local commands to use instead of systemd.

Browser-backed sources such as Twitter browse mode and YouTube require a Chrome instance with persistent cookies. Local Mac and Windows setups can use Chrome directly; Linux VMs and Docker need the desktop/keyring-backed path. See [reference/browser-setup-guide.md](reference/browser-setup-guide.md) for the platform-specific setup details.

### Phase 2: Interactive Configuration

Phase 2 is a hard consent gate. Before writing `data/config.md`, writing custom curation steering, installing a source skill, enabling Background Source Browsing, or running a source smoke test, ask the user one question at a time. Ask exactly three REQUIRED questions plus one optional closing question:

1. **Required: Brain Provider**: Claude Code or Codex CLI. Show detected `claude --version` and `codex --version` results, the recommendation, and the recommendation's reasons in the visible question text. If the selected browser-backed setup path currently has provider-specific limitations, state them plainly before changing config and ask permission to continue.
2. **Required: Usage Level**: Low, Medium, or High. Show what each level means in the visible question text.
3. **Required: Content source or sources to configure now**. At least one is required; X/Twitter is recommended for most users, but it is not implied consent. Show X/Twitter, YouTube, Substack, and Hacker News with one line each on what login or setup they need.
4. **Optional etc**: "Optional: name your agent (otherwise I'll pick one), add custom curation interests, or import a Twitter/X archive. You can also skip all three and set them up any time later from chat or by editing data/config.md."

The optional etc question defaults to skip-all. On skip-all, pick a sensible default agent name and write it to `data/config.md`; do not write custom curation steering and do not import an archive. On a partial answer, persist only the items the user mentioned and skip the rest. Do not ask about optional skills or Background Source Browsing in the upfront consent prompt. Skills require the app to be running (see Phase 2f). Background Source Browsing belongs inside the browser-backed source login flow in Phase 2c.

Do not choose defaults for required choices unless the user explicitly says they do not care about that choice. Agent Name is the exception: it is optional, but `data/config.md` must still end with a sensible `## Agent Name` value. Phase 2 is not complete until at least one user-selected content source is configured and ready to feed the app. Content sources, imported archives, and thumbs up/down feedback are the primary way Evogent learns interests; manual Interests text is only backup context for explicit steering or a true cold start.

#### 2a. Brain Provider

Before asking, run `claude --version` and `codex --version`.

Ask one visible question like: "Which brain should power Evogent: Claude Code or Codex CLI? I detected Claude Code: [result]. I detected Codex CLI: [result]. My recommendation is [provider] because [reasons]. Any setup limitation to know before you choose: [limitation or none]."

Recommendation when both are installed: recommend Claude Code because browser-backed setup paths for X/Twitter, YouTube, and Substack ship with Claude-supported Playwright MCP wiring out of the box, and Claude Code tends to produce simpler, easier-to-understand feed and chat output. Codex CLI is supported once a Codex Playwright MCP server is configured; surface that limitation before writing config either way.

Either provider runs on the user's existing subscription: Claude Code uses the user's Claude account, and Codex CLI uses the user's ChatGPT/Codex account. No separate API billing is required for normal use. If the user prefers direct API billing, both providers can also work with an Anthropic or OpenAI API key.

The recommendation is informational only. Never silently default to either provider; always ask the user to pick before writing `data/config.md`, even when only one CLI is installed.

If the user chooses Codex but the chosen browser-backed setup path cannot be completed with Codex browser tooling on this machine, say that plainly before writing config. Ask whether they want to switch to Claude Code for setup or pause while Codex Playwright MCP support is configured. Do not silently override a Codex choice.

Write the chosen value to `data/config.md`:

```markdown
## Brain Provider
Claude Code|Codex CLI
```

If the user chooses Codex CLI, do not ask a separate reasoning-effort question. After Usage Level is chosen, write:

```markdown
## Codex Reasoning Effort
low|medium|high
```

Use the chosen Usage Level to derive that value: Low -> `low`, Medium -> `medium`, High -> `high`. If the user chooses Claude Code, do not write a Codex Reasoning Effort section during install.

#### 2b. Usage Level

Ask one visible question and include these option descriptions in the question text: "How much API usage should your Evogent use? This affects curation frequency and model quality."

- **Low**: Minimal usage, uses faster/cheaper models, curates every 4-8 hours. Good for casual use or limited subscription budgets.
- **Medium (recommended)**: Balanced usage, curates every 90 minutes to 4 hours. Good for most users.
- **High**: Maximum quality, uses the most capable model for everything, curates every 45 minutes to 2 hours. Best results but highest usage.

Subscription guidance:

- **Low**: comfortable on $20/mo tiers (Claude Pro or ChatGPT Plus).
- **Medium**: comfortable on Claude Max 5x ($100/mo) or higher.
- **High**: best for Claude Max 20x or ChatGPT Pro ($200/mo), or direct API use.

Observed token usage on HIGH mode, from a heavily-tested install: about 70 curation-related tasks/day, about 180M input tokens with 88%+ served from prompt cache, about 60K output tokens, and about $130/day at Sonnet API rates. Lower tiers scale roughly 30%/60%/100% of HIGH cadence.

Source caches refresh ahead of visible curation so each cycle has a fresh pool to draw from. Medium cache defaults stay source-specific: Twitter/X every 30 minutes, Hacker News every 60 minutes, and Substack/YouTube every 120 minutes. Curation turns that pool into feed updates on a slower but aligned cadence, so a fresh Medium install reaches a visible update by 4 hours instead of waiting up to 6 hours.

Write the chosen value to `data/config.md`:

```markdown
## Usage Level
Low|Medium|High
```

#### 2c. Content Sources (required: configure at least one)

Tell the user: "You must configure at least one content source or the feed will be empty."

Ask one visible question that includes these options: X/Twitter (recommended, needs browser login), YouTube (needs browser login), Substack (needs browser login), and Hacker News (needs no login or browser setup). Then install only the matching source skill after the source-specific setup path. Installing a source skill is the enablement signal for that source. Automatic refresh runs for installed source skills with completed setup proof, unless **Background Source Browsing** is off.

Recommended first path for most users:

1. Use `/setup-source x.com` to authenticate X in the shared Chrome browse profile. X has three equivalent login paths: DevTools cookie copy from local Chrome, local-agent cookie copy with Chrome/Playwright MCP, or noVNC interactive login on the VM. See [reference/browser-setup-guide.md](reference/browser-setup-guide.md#twitter--x-setup) for details.
2. Before credential entry, turn **Background Source Browsing** off so the worker does not enqueue scheduled source browsing against the shared browser while the user is logging in.
3. For an interactive path, open the login page once, tell the user credentials stay in Chrome/noVNC, and wait for the user to confirm login is complete. Do not poll, reload, navigate, or run cache refreshes against the login tab while they type.
4. After confirmation, verify the selected provider's Playwright MCP wiring points at the shared Chrome CDP endpoint on `9222`.
5. Install `tweet-cache` after that browser login is verified.
6. Run exactly one packaged bounded `/cache-refresh twitter` setup-smoke path and verify the matching `browse_cache_refresh_runs` evidence row plus rows in `browse_cache_items`.
7. Turn **Background Source Browsing** back ON after the source-smoke evidence is verified. ON is the expected end state because automatic refreshes are required for the feed to keep getting fresh material. If the user explicitly wants it permanently OFF as a steady-state preference, ask first and surface that this disables auto-refresh.
8. Treat the shared Chrome profile as the X auth source of truth.

Offer YouTube and Substack the same way if the user prefers those sources instead:

- For YouTube, use `/setup-source youtube.com`, then install `youtube-cache` and verify packaged setup-smoke `/cache-refresh youtube`.
- For Substack, use `/setup-source substack.com`, then install `substack-cache` and verify packaged setup-smoke `/cache-refresh substack`.
- For Hacker News, install `hackernews-cache` after the user chooses Hacker News, then verify packaged setup-smoke `/cache-refresh hackernews`.

On local macOS and Windows installs, the web app can stay open while background source refreshes are quiet during login. Keep `npm start` running. Keep `node worker.js` running only if `## Background Source Browsing` is `Off`; otherwise stop the worker before credential entry and restart it only after the user confirms login is done.

Only if the deployment explicitly wants Bird-backed X fetching, walk the user through adding:

```bash
AUTH_TOKEN=<value>
CT0=<value>
```

Then verify with:

```bash
source .env.local
node node_modules/@steipete/bird/dist/cli.js whoami
```

Do not end setup with zero sources configured. Individual sources are optional; at least one user-selected working source is required. Do not install, enable, or smoke unselected sources.

After installing the chosen source skill, run:

```bash
npm run setup:agent
```

The `content_source` line must be `READY` before setup is complete.

#### 2d. Optional Etc

Ask one visible optional question after the three required questions are answered:

"Optional: name your agent (otherwise I'll pick one), add custom curation interests, or import a Twitter/X archive. You can also skip all three and set them up any time later from chat or by editing data/config.md."

Default to skip-all. Parse whichever items the user provides:

- If they provide an agent name, write that value to `data/config.md`. If they skip the name, pick one: Atlas, Nova, Echo, Sage, Scout, Pixel, Ember, or Orion.
- If they provide custom curation interests or steering, write only that steering to `data/curation-prompt.md`.
- If they provide a Twitter/X archive path or attached archive, import that archive through the existing import flow.

Always leave `data/config.md` with an agent name:

```markdown
## Agent Name
[chosen or default name]
```

If the user gives explicit steering, write their response to `data/curation-prompt.md` under sections like:

```markdown
## Interests and Topics
## Content to Avoid
## Tweet Selection Criteria
## Analysis Style Preferences
```

If they give a brief answer like "AI and tech", expand it into a concrete curation profile. If they skip custom steering, leave manual Interests blank or keep the default template and continue. On Linux `setup.sh` already creates `data/curation-prompt.md`; on macOS and Windows manual installs can copy `data/curation-prompt.default.md` to `data/curation-prompt.md` first or write the sections directly. Do not block setup just because `data/config.md` has an empty `## Interests` section when source, archive, preference, feedback, cache, or curation evidence exists.

If skip-all:

- Write the default agent name to `data/config.md`.
- Do not add user-specific steering to `data/curation-prompt.md`.
- Do not attempt archive import.

If the user provides a Twitter/X archive, import it only after the app is running. Start it if needed:

```bash
# Linux / systemd install
sudo systemctl start evogent evogent-worker
```

For local macOS or Windows installs, make sure `npm start` and `node worker.js` are already running in separate terminals.

Import:

```bash
curl -X POST http://localhost:3001/api/import-archive \
  -H 'Content-Type: application/json' \
  -d '{"archivePath":"/path/to/archive"}'
```

Vectorize:

```bash
npx tsx scripts/vectorize-preferences.ts
```

If the user skips the archive but wants to request one later, tell them they can request it on X/Twitter web from the profile menu (top-left avatar on mobile, sidebar on desktop) -> Settings and privacy -> Your Account -> Download an archive of your data -> Request archive. X emails a download link in roughly 24-48 hours, sometimes longer. The archive is a `.zip`; pass the extracted folder path to the import API when they import it later.

Post-launch, keep all three optional items tunable. Agent Name can be changed from chat session config or `data/config.md`. Curation steering can be changed by chat or `data/curation-prompt.md`. Archives can be imported later through the same import flow.

#### 2e. Network Security

Detect if this is a network-exposed deployment:

- Check if `HOST` is set to `0.0.0.0` in `.env.local`.
- Check if the machine has a public IP or hostname.
- Check for tunnel configurations.

If network-exposed:

Authentication for network-exposed deployments is the deployer's responsibility; use Cloudflare Access, proxy-level basic auth, IP allowlists, a VPN, or an equivalent deployment-layer control.

If localhost only: no password needed.

#### 2f. Skills

The app needs to be running for skill installation. Start if needed:

```bash
# Linux / systemd install
sudo systemctl start evogent evogent-worker
```

For local macOS or Windows installs, make sure `npm start` and `node worker.js` are already running in separate terminals.

Show available skills and ask which to install:

| Skill | Description | Requires |
|-------|-------------|----------|
| **tweet-cache** | Browser-backed X/Twitter cache for cache-first curation | Shared Chrome profile |
| **tweet-cache-bird** | Bird-authenticated X/Twitter cache for deployments that explicitly choose Bird | `AUTH_TOKEN` + `CT0` |
| **youtube-cache** | Browser-backed YouTube source for cache-first curation | Shared Chrome profile |
| **substack-cache** | Browser-backed Substack source for cache-first curation | Shared Chrome profile |
| **hackernews-cache** | Hacker News source for cache-first curation | Nothing |
| **full-text** | Fetches full article text for richer summaries | Nothing |
| **account-mirror** | Mirrors specific Twitter accounts into the feed | Twitter auth |
| **archive-import** | Import Twitter data export as preferences | Nothing |
| **current-event-tracker** | Adds structured tracking for developing situations and current events | Nothing |

Recommend **full-text** for everyone. Recommend the source skill that matches the user's chosen source: **tweet-cache** for X/Twitter, **youtube-cache** for YouTube, **substack-cache** for Substack, or **hackernews-cache** for Hacker News. Installing a source skill enables automatic refresh after setup proof. Only recommend **tweet-cache-bird** when the deployment explicitly wants Bird-backed fetching. Only offer **account-mirror** if Twitter auth is configured.

Install via:

```bash
curl -s -X POST http://localhost:3001/api/skills/install \
  -H 'Content-Type: application/json' \
  -d '{"registry":"<skill-name>"}'
```

For **account-mirror**, also ask which Twitter handles to mirror and write config:

```bash
mkdir -p .claude/skills/account-mirror
cat > .claude/skills/account-mirror/config.json << 'EOF_CONFIG'
{"accounts": ["handle1", "handle2"], "limitPerAccount": 15}
EOF_CONFIG
```

### Phase 3: Launch and Verify

If you used the local macOS or Windows path, make sure both `npm start` and `node worker.js` are still running before you verify.

After Evogent is running, create the default chat sessions once:

```bash
node scripts/create-default-sessions.mjs
```

For coding-agent-only installs, use `node scripts/create-default-sessions.mjs --coding-agent-only` instead.

```bash
# Verify
curl -s http://localhost:3001/api/status | jq .
# Should show: orchestrator + working/session fields
npm run setup:agent
# Must have no REQUIRED lines
```

Tell the user:

- "Evogent is running at http://localhost:3001"
- "Your agent [name] will start curating shortly."

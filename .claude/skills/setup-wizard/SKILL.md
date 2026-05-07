---
name: setup-wizard
description: Chat-guided first-run onboarding skill that introduces the skills system, checks environment readiness, suggests useful skills, and helps the user configure preferences in config.md. Use when a user is new to evogent, asks for setup help, or wants to validate tool/API readiness.
user-invocable: true
metadata:
  evogent:
    heartbeat-task: false
---
# Setup Wizard Chat Assistant

Verification-first onboarding. Detect existing setup before asking any questions. This skill reports live evidence; it does not use setup checklist rows, step totals, or a React setup flow.

## Step 0: Collect Live Evidence

For deploying Evogent to a fresh VM behind Cloudflare Access (the public-feed demo pattern), read `docs/deploy-vm-demo.md` before improvising.

Run these checks first, before any interactive prompts:

```bash
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
API_BASE="${MEDIA_AGENT_INTERNAL_BASE_URL:-${ORCHESTRATOR_INTERNAL_URL:-http://127.0.0.1:${PORT:-3001}}}"

node <<'NODE'
const fs = require('fs');
const config = fs.existsSync('data/config.md') ? fs.readFileSync('data/config.md', 'utf8') : '';
function section(name) {
  const lines = config.split(/\r?\n/);
  const start = lines.findIndex((line) => new RegExp(`^##\\s+${name}\\s*$`, 'i').test(line.trim()));
  if (start === -1) return '';
  const out = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s+/.test(lines[i].trim())) break;
    out.push(lines[i]);
  }
  return out.join('\n').trim();
}
console.log(JSON.stringify({
  agentName: section('Agent Name'),
  interests: section('Interests') || section('Interests and Topics'),
  brainProvider: section('Brain Provider'),
  codexReasoningEffort: section('Codex Reasoning Effort'),
  usageLevel: section('Usage Level'),
}, null, 2));
NODE

curl -s "$API_BASE/api/skills" || true
curl -s "$API_BASE/api/preferences" || true
ls .claude/skills/ 2>/dev/null || true
grep -R "feed-source" .claude/skills/*/SKILL.md 2>/dev/null || true
```

When SQLite is available, inspect:

```bash
sqlite3 data/media-agent.db "SELECT source, COUNT(*) FROM preferences GROUP BY source ORDER BY source;" 2>/dev/null || true
sqlite3 data/media-agent.db "SELECT signal_type, source, COUNT(*) FROM preferences GROUP BY signal_type, source ORDER BY source, signal_type;" 2>/dev/null || true
sqlite3 data/media-agent.db "SELECT id, source, triggered_by, status, items_added FROM browse_cache_refresh_runs ORDER BY started_at DESC LIMIT 10;" 2>/dev/null || true
sqlite3 data/media-agent.db "SELECT source, COUNT(*) FROM browse_cache_items GROUP BY source ORDER BY source;" 2>/dev/null || true
sqlite3 data/media-agent.db "SELECT request_id, triggered_by, completion_status FROM curation_log ORDER BY started_at DESC LIMIT 5;" 2>/dev/null || true
sqlite3 data/media-agent.db "SELECT source, COUNT(*) FROM feed GROUP BY source ORDER BY source;" 2>/dev/null || true
sqlite3 data/media-agent.db "SELECT session_type, COUNT(*) FROM chat_sessions WHERE session_type IS NULL OR session_type = 'curator' GROUP BY session_type ORDER BY session_type;" 2>/dev/null || true
test -s data/feed-output.jsonl && tail -n 3 data/feed-output.jsonl || true
```

If the live evidence shows zero `chat_sessions` rows for the required role(s), run `node scripts/create-default-sessions.mjs` after Evogent is reachable. Add `--coding-agent-only` if the install is coding-agent-only.

Also check provider availability without exposing credentials:

```bash
claude --version 2>/dev/null || true
codex --version 2>/dev/null || true
```

If the user attached a Twitter archive zip to this chat turn, import it through `POST $API_BASE/api/import-archive` using the attached file path from the prompt and report counts. Never ask for token, cookie, or password values in chat.

## Step 1: Report The Six Setup Areas

Use live evidence to report each area as `ready`, `missing`, `confirm`, or `optional`:

Before judging manual Interests, compute interest inference evidence:

- Source evidence: installed source skills with feed-source metadata. For browser-backed sources, require packaged `/setup-source` smoke evidence in `browse_cache_refresh_runs` and matching `browse_cache_items` rows.
- Preference evidence: non-empty `/api/preferences` or SQLite `preferences` rows, including imported archive signals, explicit app feedback, likes, dislikes, hides, bookmarks, follows, or similar user signals.
- Curation evidence: `curation_log` plus `feed` rows, or fallback `data/feed-output.jsonl`, showing completed feed output.

1. **Optional agent name and manual Interests**: `Agent Name` is optional but must have a value in `data/config.md`; report it as `optional` when absent or still the default `Evo`, and `ready` when personalized or a default name has been written. Manual Interests are optional backup/context when source, preference, archive, feedback, cache, or curation evidence exists; report interest inference as `ready` from that evidence. Manual Interests are a cold-start fallback only when there is no usable source/preference evidence.
2. **Optional Twitter/X archive request**: Optional user action. Do not ask as a separate first-run question; include it only in the combined optional etc question after required setup choices.
3. **Import Twitter/X archive**: Ready when uploaded/import evidence exists or preference rows include `twitter_archive_interest`, `twitter_archive_like`, `twitter_archive_tweet`, `twitter_archive_following`, `twitter_archive_bookmark`, `twitter_archive_block`, or `twitter_archive_mute`. If an archive is attached before required setup is complete, note it and defer import until the user reaches the optional etc step or explicitly asks to import it.
4. **Brain configuration**: Report Brain Provider, Codex Reasoning Effort, Usage Level, and whether the selected provider binary is available. If Codex Reasoning Effort is missing for Codex CLI, derive it from Usage Level: Low=low, Medium=medium, High=high.
5. **Source skills and source health**: Report configured source skills and source evidence. Browser-backed sources need packaged `/setup-source` smoke evidence in `browse_cache_refresh_runs` with `triggered_by='setup-source-smoke'` and matching `browse_cache_items` rows.
6. **First curation**: Ready when `curation_log` plus `feed` rows, or fallback `data/feed-output.jsonl`, show a curation produced output.

## Step 2: Ask The Next Concrete Question

Ask only about the earliest missing required item first: Brain Provider, then Usage Level, then source health. After required setup choices are handled, ask one combined optional etc question if agent name is absent/default, cold-start steering could help, or an archive is available. Do not ask agent name, manual interests, and archive as separate first-run questions.

Missing-item prompts:
- **No brain provider**: "Which brain should power Evogent: Claude Code or Codex CLI?"
- **No usage level**: "How much API usage should Evogent use?
- **Low**: comfortable on $20/mo tiers (Claude Pro or ChatGPT Plus). Curates every 4-8 hours.
- **Medium (recommended)**: comfortable on Claude Max 5x ($100/mo) or higher. Curates every 90 min to 4 hours.
- **High**: best for Claude Max 20x or ChatGPT Pro ($200/mo), or direct API. Curates every 45 min to 2 hours.

Choose Low, Medium, or High."
- **No source health evidence**: "Which source should we set up first? I recommend `/setup-source x.com` with `tweet-cache`, unless you prefer YouTube, Substack, or Hacker News."
- **Browser-backed source lacks smoke evidence**: "Please run `/setup-source <site>` and complete the shared Chrome login; credentials stay in the browser, never in chat."
- **Optional etc available**: "Optional: name your agent (otherwise I'll pick one), add custom curation interests, or import a Twitter/X archive. You can also skip all three and set them up any time later from chat or by editing data/config.md."
- **No first curation**: "Ready to run the first curation cycle now?"

If the brain provider is missing and the user answers, write the selected value under:

```markdown
## Brain Provider
Claude Code|Codex CLI
```

If Codex is selected and Usage Level is known but Codex Reasoning Effort is missing, write the derived value under:

```markdown
## Codex Reasoning Effort
low|medium|high
```

Use the Usage Level mapping Low -> `low`, Medium -> `medium`, High -> `high`. Do not ask a separate Codex reasoning question during first-run setup.

If usage level is missing and the user answers, write the selected value under:

```markdown
## Usage Level
Low|Medium|High
```

If Brain Provider is already Codex CLI, also write `## Codex Reasoning Effort` from that Usage Level with the same Low -> `low`, Medium -> `medium`, High -> `high` mapping.

If the user answers the optional etc question:

- On skip-all, write a sensible default `## Agent Name` to `data/config.md`, do not add user-specific steering, and do not import an archive.
- If they provide an agent name, write only that name to `data/config.md`.
- If they provide custom curation interests or steering, write only that steering to `data/curation-prompt.md`.
- If they provide a Twitter/X archive path or attached archive, import only that archive through `POST $API_BASE/api/import-archive`.

Skill install flow (only if needed):
1. Show available skills and brief descriptions.
2. Recommend source/cache skills first, based on the source the user wants to configure.
3. Do not recommend `full-text` as a proven default while it is not installed. Describe it only as optional experimental article enrichment for users who already see shallow article cards and understand it relies on fetchable article pages.
4. Recommend available browse sources explicitly:
   - `tweet-cache` for X/Twitter when the user wants the browser-backed shared Chrome profile path
   - `tweet-cache-bird` only for deployments that explicitly want Bird-backed fetching and are willing to maintain `AUTH_TOKEN` + `CT0`
   - `youtube-cache`, `substack-cache`, or `hackernews-cache` when the user wants those source surfaces
5. Mention `full-text` only after source health exists or the user explicitly asks for deeper article summaries. Say it is experimental/optional, updates existing feed rows through current APIs when possible, and may fail on paywalled or script-heavy pages.
6. Tell the user to use `/setup-source <site>` for any site that needs login in the shared Chrome browse profile before installing a browser-backed cache skill such as `tweet-cache`.
7. Only offer `account-mirror` when Twitter auth exists.
8. Ask before installing each selected skill.
9. Install with `POST /api/skills/install`.

Keep language soft and state-based:
- Use: "I notice X isn't set up yet..."
- Avoid: full from-scratch walkthrough for already-complete setup.

## Step 3: Summary

If any gaps were handled, summarize:
- Configured now
- Still pending
- Optional next steps

If everything already looks ready, say what is ready and offer the first curation cycle. Do not submit feed items, code_fix suggestions, curation candidates, or notifications unless the user explicitly asks for that follow-up.

## Rules

- Detection-first: always run checks before asking questions.
- Skip completed areas.
- Never expose token/cookie values.
- `data/config.md` is gitignored personal runtime config. If the user gives an explicit concrete setup value, write it directly with the smallest section change, such as setting `## Agent Name` to `Bob`.
- Ask before changing `data/config.md` when the value is ambiguous, broad, or destructive.
- Treat the installed X source skill as the setup source of truth. Do not mix browser and Bird guidance in the same active recommendation.
- Ask before installing skills.
- Keep the reply short: Ready now, Missing or blocked, Optional, and the next concrete question.

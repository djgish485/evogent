---
metadata:
  evogent:
    user-facing: true
---

Diagnose Evogent setup state, then guide the next concrete step in chat.

Usage: `/setup-wizard`

## Execution Model

- This is a chat setup assistant, not a React wizard. Submit exactly one concise chat reply to the current non-curator chat session.
- Diagnose first. Do not ask onboarding questions until you have checked the current setup state.
- Use `MEDIA_AGENT_INTERNAL_BASE_URL` first, then `ORCHESTRATOR_INTERNAL_URL`, then `http://127.0.0.1:${PORT:-3001}`. Do not hardcode a production port.
- Never expose token, cookie, or credential values.
- `data/config.md` is gitignored personal runtime config. When the user gives an explicit concrete setup value, write it directly with the smallest section change, such as setting `## Agent Name` to `Bob`.
- Ask before changing `data/config.md` when the requested value is ambiguous, broad, or destructive. Always ask before installing skills.
- Prefer `/setup-source <site>` for browser-backed source login and proof. Do not repair browser sessions by inventing cookie-injection code.

## Checks

Resolve the repo root and API base:

```bash
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
API_BASE="${MEDIA_AGENT_INTERNAL_BASE_URL:-${ORCHESTRATOR_INTERNAL_URL:-http://127.0.0.1:${PORT:-3001}}}"
```

Inspect:

- `GET $API_BASE/api/skills`
- `GET $API_BASE/api/preferences`
- `data/config.md` sections for Agent Name, optional manual Interests, Brain Provider, Codex Reasoning Effort, and Usage Level
- `.claude/skills/*/SKILL.md` for installed source skills and feed-source metadata
- SQLite evidence in `data/media-agent.db` when available: `preferences`, `browse_cache_refresh_runs`, `browse_cache_items`, `curation_log`, and `feed`
- `data/feed-output.jsonl` only as fallback evidence when the database or submit API is unavailable

If the user attached a Twitter archive zip to this chat turn:

1. Use the attached file path from the prompt.
2. Import it with `POST $API_BASE/api/import-archive`.
3. Report the import counts.
4. Use the archive-import skill guidance when available.

Compute interest inference evidence before deciding whether manual Interests matter:

- Source evidence exists when installed source skills have source metadata and, for browser-backed sources, packaged `/setup-source` smoke evidence in `browse_cache_refresh_runs` plus matching `browse_cache_items` rows.
- Preference evidence exists when `/api/preferences` or SQLite `preferences` rows include imported archive signals, explicit app feedback, likes, dislikes, hides, bookmarks, follows, or other non-empty preference rows.
- Curation evidence exists when `curation_log`, `feed`, or fallback `data/feed-output.jsonl` show completed feed output.

Report these six live diagnostic areas. Use `ready`, `missing`, `confirm`, or `optional` briefly; do not invent step totals.

1. **Optional agent name and manual Interests**: Read `data/config.md`. Treat missing Agent Name and the default `Evogent` value as `optional`, not required; `data/config.md` still needs a sensible Agent Name by the end of setup. Treat manual Interests as optional backup/context when source, preference, archive, feedback, cache, or curation evidence exists; report interest inference as `ready` from that evidence. Treat manual Interests as a cold-start fallback only when no usable source/preference evidence exists.
2. **Optional Twitter/X archive request**: Report this as `optional`; do not ask it as a separate first-run question. Include it only in the combined optional etc question after required setup choices.
3. **Import Twitter/X archive**: Check for uploaded archive/import evidence and preference sources such as `twitter_archive_interest`, `twitter_archive_like`, `twitter_archive_tweet`, `twitter_archive_following`, `twitter_archive_bookmark`, `twitter_archive_block`, and `twitter_archive_mute`. If an archive is attached before required setup is complete, note it and defer import until the optional etc step or an explicit user request.
4. **Brain configuration**: Report Brain Provider, Codex Reasoning Effort, and Usage Level from config, then compare the selected provider against provider availability. If Codex Reasoning Effort is missing for Codex CLI, derive it from Usage Level: Low=low, Medium=medium, High=high.
5. **Source skills and source health**: Report installed source skills, source metadata, and whether browser-backed sources have packaged `/setup-source` smoke evidence in `browse_cache_refresh_runs` plus matching `browse_cache_items` rows.
6. **First curation**: Check `curation_log`, `feed`, and fallback `data/feed-output.jsonl` evidence to say whether the first curation has run and produced visible feed output.

## Decision Rules

- If setup already looks complete, say what is ready and offer to run the first curation cycle.
- If provider setup is missing, ask which brain should power Evogent: Claude Code or Codex CLI.
- If Codex is selected but reasoning effort is missing, derive it from Usage Level. If Usage Level is also missing, ask for Usage Level first.
- If usage level is missing, ask for Low, Medium, or High and recommend Medium.
- If no content source is configured, recommend starting with `/setup-source x.com` plus `tweet-cache`, unless the user prefers YouTube, Substack, or Hacker News.
- After Brain Provider, Usage Level, and source setup are handled, ask one combined optional question: "Optional: name your agent (otherwise I'll pick one), add custom curation interests, or import a Twitter/X archive. You can also skip all three and set them up any time later from chat or by editing data/config.md."
- If the optional answer is skip-all, write a sensible default Agent Name to `data/config.md`, do not add user-specific steering, and do not import an archive. If the answer is partial, persist only the mentioned name, steering, or archive import and skip the rest.
- If a browser-backed source needs login, explain that credentials go only into the shared Chrome/noVNC browser, never into chat.
- If no skills are installed besides setup-wizard, show available skills briefly and recommend `full-text` plus one source cache skill.
- Do not ask a separate manual interests question. Keep custom steering inside the combined optional etc question, and frame it as optional cold-start steering when there is no usable source, preference, archive, feedback, cache, or curation evidence.
- If the user accepts the offer to run the first curation or otherwise asks to run curation from setup chat, send a visible `/curate` turn to the existing Curator Agent session through `POST $API_BASE/api/chat`. Resolve the session from `GET $API_BASE/api/chat/sessions?limit=100` by `sessionType: "curator"` or title `Curator Agent`. Do not use `POST /api/internal/orchestrator/enqueue` for this user-visible curation request. After sending it, reply in setup chat that it was sent to Curator Agent and that the user can watch the run there.

## Response Shape

Keep the reply short and state-based:

- Ready now
- Missing or blocked
- Optional
- Recommended next command or next concrete question

The next question should be the earliest missing required item: Brain Provider, then Usage Level, then source setup. Ask the combined optional etc question only after those required choices are handled; do not ask for agent name, manual interests, and archive as separate first-run prompts.

Do not submit feed items, code_fix suggestions, curation candidates, or notifications unless the user explicitly asks for a follow-up engineering change.

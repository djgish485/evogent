---
metadata:
  evogent:
    user-facing: true
---
Create or update an app chat session through Evogent session API.

Usage: `/new-chat-session provider=claude title="..." color=amber workingDirectory="/root/project" [optional free text]`

`$ARGUMENTS` may be structured `key=value` tokens, free text, or both. Structured values win. Parse `provider`, `title`, `color`, `workingDirectory`, and an optional target `sessionId`; valid providers are `claude`, `codex`, and `gemini`. Also understand free text such as "Claude Code session", "Codex session", "Gemini session", "called Snow Forecaster2", "amber", "retarget this session to /root/foo", or "for a new snow forecaster project".

## Rules

- This is app session configuration, not tmux, shell, or CLI runtime orchestration.
- Use `POST /api/chat/sessions` to create a new app chat session.
- Use `PATCH /api/chat/sessions/{id}` to rename, recolor, or retarget an existing app chat session. If the user means the current session, use `SessionId` from the chat prompt; if the target is unclear, ask.
- Session config fields include `provider`, `title`, `color`, and `workingDirectory`.
- Parse provider phrases as `Claude Code session` -> `claude`, `Codex session` -> `codex`, and `Gemini session` -> `gemini`; include `provider` in the same `POST /api/chat/sessions` body when set.
- Valid colors are `blue`, `purple`, `teal`, `amber`, `rose`, `green`, `indigo`, and `pink`. Omit `color` when no valid color is requested.
- Resolve `API_BASE="${MEDIA_AGENT_INTERNAL_BASE_URL:-${ORCHESTRATOR_INTERNAL_URL:-http://127.0.0.1:${PORT:-3001}}}"` before calling internal endpoints.
- Do not edit the database directly; call the HTTP endpoints.

## New Project Working Directory

This command may create a project directory as a narrow exception to the normal chat write boundary.

- Run this flow when `workingDirectory` names a path that does not exist, or when the user explicitly says the session is for a new project.
- If the user gave `workingDirectory`, use that path. Otherwise derive a kebab-case directory name under `/root` from the project/session title, e.g. `Snow Forecaster2` -> `/root/snow-forecaster2`.
- Check for collisions. For a derived path that already exists, choose the next clear suffix such as `/root/snow-forecaster2-2`; do not overwrite an existing project.
- Create the directory with `mkdir -p` and run `git init` inside it before creating the chat session.
- Include the chosen `workingDirectory` in the same `POST /api/chat/sessions` request.
- Reply with the session id and chosen path after the API call succeeds.

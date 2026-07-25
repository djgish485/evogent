# Pixel Dev Loop — how a coding agent works on Evogent-on-device

This is the complete development environment and workflow for working on the phone
paradigm from a host machine (macOS in practice). It is written for a coding agent
picking up the project cold. Device-specific values (serial, ports, hostnames) are
NOT in this public file — they live in a local, uncommitted notes file on the host
(see "Local secrets file" below).

Read first: the repo root `CLAUDE.md` (mission, laws, runtime instructions),
`MIGRATE-TO-NEW-PHONE.md` (full device provisioning), `AGENTS.phone-browse.md`
(on-device browsing). The intent ledger practice in `CLAUDE.md` is MANDATORY:
grep `.intent/contracts.jsonl` + `.intent/backlog.jsonl` before changing behavior,
append entries after.

## Local secrets file (host-side, never committed)

All device-specific facts — ADB serial, SSH port/user, host paths, current open
decisions — live in a plain-markdown notes file OUTSIDE this git checkout on the
host machine, conventionally at `../PIXEL-DEV-LOCAL.md` relative to the checkout
(i.e. a sibling of the repo directory). If you are an agent starting fresh: read
that file first; if it is missing, ask the user for the device serial and SSH
forward, then recreate it. Never paste its contents into committed files, commit
messages, or public artifacts.

## The two roles (LAW — role hierarchy)

- **You (the dev agent on the host)** build the FRAMEWORK: product code, skills,
  mechanics scripts, guards, prompts. You never do the runtime work by hand.
- **Evogent's own on-device agents** do the runtime work: cards, browses,
  extractions, curation. When a runtime agent fails, fix the CONTAINER (its skill,
  prompt, mechanics, budget) and re-run the agent. Capability tests are GENERAL
  and hint-free ("Run the sweep per the skill" — never "add a cancel button to X").

## Connecting to the device

Termux sshd listens on device port 8022. Bridge it over USB ADB:

```bash
adb -s <DEVICE_SERIAL> forward tcp:<LOCAL_PORT> tcp:8022
ssh -p <LOCAL_PORT> -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null <SSH_USER>@127.0.0.1
```

The host's SSH key must be in Termux `~/.ssh/authorized_keys` (done during
provisioning). Everything below assumes this SSH works. On-device layout:

- `~/evogent` — the app (repo checkout + `.next` build + `data/` incl. SQLite DB)
- `~/phone-tools` — mechanics scripts (browse drivers, cycle, scheduler);
  `~/evogent/phone-sources` symlinks here (never let them drift apart)
- `~/deploy-next.sh`, `~/restart-evo.sh` — deploy/restart entry points
- tmux sessions: `evo` (node server.js, port 3001), `evo-sched` (scheduler)
- logs: `~/evo-boot.log` (server), `~/deploy.log`, `~/evogent-watchdog.log`

## Ship loops (host → device)

**Server/UI code** (anything under `src/`, `server.js`):
```bash
npm run build                      # in the checkout, on the host
tar czf /path/to/scratch/next-deploy2.tar.gz .next
scp -P <LOCAL_PORT> .../next-deploy2.tar.gz <SSH_USER>@127.0.0.1:next-deploy2.tar.gz
ssh ... 'nohup ~/deploy-next.sh >/dev/null 2>&1 &'    # atomic swap + restart + health check
```
deploy-next.sh KILLS the server: wait for any in-flight life-execution agent
(check for a codex process / `[chat-streaming] task life-exec-*` in `~/evo-boot.log`)
before deploying. Verify with `tail ~/deploy.log` ("swapped to BUILD_ID …",
"server UP").

**Skills** (`skills-library/*/SKILL.md`): scp the file to BOTH
`~/evogent/skills-library/<name>/SKILL.md` and (if present)
`~/evogent/.claude/skills/<name>/SKILL.md`; verify by hash. No restart needed —
agents read skills per task.

**Mechanics scripts** (`phone-paradigm/device/phone-tools/*`): scp to
`~/phone-tools/`. NEVER scp over a script that is currently executing (a running
bash/python re-reads its file mid-run) — check `pgrep -f <script>` first, or write
to `.new` and `mv`.

**APK** (`android-shell/`): `build.sh` (anonymous-classes-only javac constraints —
see comments in it); after `pm install` re-add the HOME role
(`cmd role add-role-holder`) and re-arm the a11y service.

## Verify at the glass (LAW)

API state and rendered state DIVERGE (proven repeatedly). Any user-visible change
must be verified on the RENDERED feed, on the device's real display 0:

```bash
adb -s <DEVICE_SERIAL> exec-out screencap -p > shot.png     # look at it
adb -s <DEVICE_SERIAL> shell input -d 0 tap X Y             # -d 0 ALWAYS (hidden
adb -s <DEVICE_SERIAL> shell input -d 0 swipe 540 1700 540 500 400   # displays steal focus)
```

Screenshot immediately before any tap — live feed updates shift tap targets under
you (known race; a "N items reorganized / Show new order" banner gates reorders
when scrolled below top). Force the full pipeline first (cycle → arrange) rather
than trusting a component-level fix: scheduler lag makes deployed-but-unexercised
fixes look broken.

## Running the runtime agents (never do their job yourself)

Dispatch through the app's chat API on-device:

```bash
# create a session
curl -s -X POST http://127.0.0.1:3001/api/chat/sessions -H 'Content-Type: application/json' \
  -d '{"provider":"codex","title":"<label>","color":"emerald"}'
# send the task (hint-free!)
curl -s -X POST http://127.0.0.1:3001/api/chat -H 'Content-Type: application/json' \
  -d '{"sessionId":"<id>","message":"Run the phone-life-admin sweep now, per the skill."}'
```

Replies land in `~/evogent/data/chat-output.jsonl` (grep by sessionId). The
full cycle is `~/phone-tools/evogent-cycle.sh` (run it in tmux, log to `$HOME` —
see gotchas). DB truth: `~/evogent/data/media-agent.db` (sqlite3 via ssh; the
`feed` table has no `status` column — suggestion lifecycle lives in
`metadata.suggestionStatus`).

## Gotchas (each one cost real time)

- **Termux has no `/tmp`** — a tmux command redirecting there dies instantly and
  silently. Log to `$HOME`.
- Fresh tmux sessions sometimes lack the env a browse driver needs; the
  cycle script path or a plain detached ssh (`nohup ... &`) both work reliably.
- **zsh eats words starting with `=`** (`echo ====` fails) on the host.
- `input` without `-d 0` may go to a hidden display; `see 0` + keyevents can lie —
  use the shot op / screencap to know what display 0 shows.
- Hidden-display browsing is blocked by **Doze** when the device sleeps
  (`phone.sh launch` lands on no display) — overnight app-browses fail silently;
  whether to hold a wakelock is a product decision (check the intent backlog).
- Never kill a wedged browse mid-run to test something: it leaves a stale
  DISPFILE and pushes the open-aware scheduler's next full cycle to its max gap.
- codex thread ids are SERVER-assigned; never fabricate them.
- The Workflow-style temptation to batch-verify by API only: **don't** — glass only.
- WebView `localhost` resolves to `::1`: server must listen dual-stack.
- On-device brains: codex (light) is the right default; Claude is too heavy.

## Where things are decided

- `.intent/contracts.jsonl` — laws in force (status:"law").
- `.intent/backlog.jsonl` — every intention + current open items (status:"open").
- `data/browse-notes/*.md` (on device) — the diagnosis agents' findings; when a
  browse breaks, read these BEFORE debugging yourself; they usually already know.
- `data/failure-modes.jsonl` + chaos-drill runbook — the resilience registry.

# Phone paradigm — on-device operational scripts

Evogent running **fully on an Android device** (proven on the `evogent` AVD, Android 15 arm64):
the Next.js server, DB, and Claude Code CLI all run on the phone under Termux, and the chat
agent drives the user's real logged-in apps (Gmail, YouTube, …) **in the background** on a hidden
virtual display, so the user's feed on display 0 is never disturbed.

These are the runtime/recovery scripts. None of them contain secrets — tokens live only in
device-local files (`~/.evogent-oauth-token`, `data/control-token.txt`) that are never committed.

## Auth — runs off the user's Claude SUBSCRIPTION, not a pay-per-use API key

Claude Code resolves credentials as: `ANTHROPIC_AUTH_TOKEN` > `ANTHROPIC_API_KEY` > `apiKeyHelper`
> `CLAUDE_CODE_OAUTH_TOKEN` > subscription OAuth. In `-p` (non-interactive) mode the **API key
always wins when present** — so a stray `ANTHROPIC_API_KEY` silently overrides the subscription,
and if that key is out of credits every agent call fails `"Credit balance is too low"`.

Therefore `device/start-prod.sh` **unsets `ANTHROPIC_API_KEY`** and exports
`CLAUDE_CODE_OAUTH_TOKEN` from `~/.evogent-oauth-token`. Generate that token once:

```bash
claude setup-token        # one-time browser approval; prints an sk-ant-oat01-... token
printf '%s' '<token>' > ~/.evogent-oauth-token && chmod 600 ~/.evogent-oauth-token
```

Do **not** run `claude` with `--bare` (it ignores `CLAUDE_CODE_OAUTH_TOKEN`).

## The scripts

| File | Runs on | What it does |
|---|---|---|
| `restore-device.sh` | Mac (adb + ssh) | **One-command recovery after any (re)boot.** Non-rooted images kill Shizuku/sshd/server on boot; this restarts them, re-asserts settings (phantom-killer off, BAL appop, default home), starts `shizuku_server`, restarts the server, and **loops until the home page serves AND the accessibility service actually responds** before declaring done. |
| `device/start-prod.sh` | Termux | Launches the server in production mode on the subscription token (see Auth). |
| `device/restart-evo.sh` | Termux | Kills node (by exact name — never `pkill -f "node server.js"`, which self-matches) and restarts the server in a detached `tmux` session so it survives ssh logout. |
| `device/phone-tools/phone.sh` | Termux | The on-device computer-use toolkit: `launch <pkg>` (Shizuku hidden display), `see` (dump that display's node tree over the 127.0.0.1:8790 loopback), `tap`/`scroll`/`swipe`. Display 0 stays on Evogent. |
| `device/phone-tools/a11y-check.sh` | Termux | Health probe: prints the byte count the a11y service pushes for an `op=nodes` — `>0` means it's actually connected (not just that the setting string is set). Frees a leaked 8790 listener first. |
| `device/termux-boot/10-evogent.sh` | Termux | Auto-starts the server on boot — **requires the Termux:Boot addon** to fire. |
| `device/skills/phone-browse/SKILL.md` | agent | The chat-agent skill for background app browsing, fully on-device (no adb) via `phone.sh`. |

## Why a reboot needs `restore-device.sh` (not an Evogent bug)

The AVD is a **production ("user") Google Play image** — deliberately, so real apps behave like a
real phone — which means it is **non-rooted**. `shizuku_server` (the shell-uid broker that creates
the hidden trusted display) can only be (re)started via an ADB command each boot; Termux's server
and the a11y service don't auto-start either. So a reboot resets them, and `restore-device.sh`
brings the whole stack back. The durable, zero-touch end state is a **system/platform-signed
Evogent** on a flashed image (no Shizuku, everything auto-starts) — the phase-2 product tier.

## Alternative brain provider: Codex CLI (subscription-powered)

Evogent's brain provider is switchable (`## Brain Provider` in `data/config.md`: `Claude Code` or
`Codex CLI`). Codex runs on the device off the user's **ChatGPT subscription**:

- The Codex CLI ships a **static-musl aarch64** binary that runs directly on Android (no grun).
- Being static it bypasses Android/bionic, so it needs a `resolv.conf` (DNS, via a `proot`
  bind-mount) and an explicit CA bundle (`SSL_CERT_FILE`) — both handled by `device/bin/codex`.
- Auth: copy `~/.codex/auth.json` from a machine where `codex login` (ChatGPT) succeeded.
- Codex reads `AGENTS.md` (not `.claude/skills`), so the phone-browse capability is added there —
  see `device/AGENTS.phone-browse.md` (appended to `~/evogent/AGENTS.md`).
- See `device/setup-codex.sh`. Verified live: the "Spark" codex session browsed Gmail on a hidden
  display and returned the latest email with the feed undisturbed.

---
name: setup-source
description: Detect the user's platform and guide them through authenticating a browser-backed source in the Chrome profile Evogent will actually reuse.
user-invocable: true
metadata:
  evogent:
    heartbeat-task: false
---
# Setup Source

Use this when the user wants to set up a logged-in browser source such as X/Twitter or YouTube.

Goal: authenticate the site in the exact Chrome profile the runtime will keep using, verify the selected provider's Playwright MCP wiring points at that profile, then prove the packaged cache-refresh path persists rows.

Critical login-safety rule: while the user is entering credentials, leave the shared browser tab alone. Do not poll it, reload it, navigate it, or start cache refresh tasks. Quiet background source browsing first, open the login page once, wait for the user to confirm login is complete, then run verification.

## Step 0: Detect The Target And Platform

1. Parse the site from `$ARGUMENTS`. If it is missing, ask which site they want to set up.
2. Detect the host platform before giving instructions:

```bash
uname -s
command -v google-chrome >/dev/null 2>&1 && google-chrome --version || true
command -v systemctl >/dev/null 2>&1 && echo SYSTEMD_PRESENT || echo SYSTEMD_MISSING
test -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" && echo MAC_CHROME_PRESENT || true
```

3. Map the site before launching Chrome:
   - `x.com`, `twitter.com`, `twitter`: `SOURCE=twitter`, `TARGET_URL=https://x.com/home`, `SKILL=tweet-cache`
   - `youtube.com`, `youtube`: `SOURCE=youtube`, `TARGET_URL=https://www.youtube.com/feed/subscriptions`, `SKILL=youtube-cache`
   - `substack.com`, `substack`: `SOURCE=substack`, `TARGET_URL=https://substack.com/home`, `SKILL=substack-cache`

4. Resolve and keep these values visually distinct:

```bash
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
API_BASE="${MEDIA_AGENT_INTERNAL_BASE_URL:-http://127.0.0.1:${PORT:-3001}}"
CDP_URL="${MEDIA_AGENT_SHARED_BROWSER_CDP_URL:-${SHARED_BROWSER_CDP_URL:-http://127.0.0.1:9222}}"
PROFILE_DIR="${CHROME_BROWSE_PROFILE_DIR:-${X_BROWSER_PROFILE_DIR:-${DATA_DIR:-$REPO_ROOT/data}/chrome-browse-profile}}"
```

Explain simply:

- `API_BASE` / port `3001` is Evogent app and API.
- `CDP_URL` / port `9222` is Chrome remote debugging for the shared browser profile.

5. If the environment is Linux, check whether this is the desktop-backed VM setup Evogent expects:

```bash
command -v lightdm >/dev/null 2>&1 && echo LIGHTDM_PRESENT || echo LIGHTDM_MISSING
test -S /tmp/.X11-unix/X0 && echo X_DISPLAY_READY || echo X_DISPLAY_MISSING
test -S /run/user/0/bus && echo DBUS_READY || echo DBUS_MISSING
test -d /root/.local/share/keyrings && echo KEYRING_DIR_PRESENT || echo KEYRING_DIR_MISSING
systemctl is-enabled chrome-browse.service 2>/dev/null || true
systemctl is-active chrome-browse.service 2>/dev/null || true
```

Interpretation:

- `Darwin` means local macOS. Use direct Chrome GUI setup.
- Linux with the desktop/keyring checks above is the managed desktop VM flow.
- Windows or other local desktop setups should follow the same direct GUI path as macOS.

Before any login instructions, warn the user:

- never type credentials into chat
- use the site login page directly in Chrome or in `noVNC`
- chat history is stored in the app

Before opening the login page:

1. Turn **Background Source Browsing** off in the app Settings panel, or set `data/config.md` to:

   ```markdown
   ## Background Source Browsing
   Off
   ```

2. Keep the web app open. On local macOS and Windows, `npm start` can keep running while the user logs in.
3. The worker can also stay running. With background source browsing off, it will not enqueue scheduled source browsing, but it can still process the one explicit setup-smoke `/cache-refresh <source>` job after login.

## Step 1: Choose The Correct Flow

### X/Twitter Login Path Options

If `SOURCE=twitter`, tell the user there are three equivalent login paths and let them choose. Do not present one as the correct path; choose by trade-off:

| Path | Use when | Trade-off |
|------|----------|-----------|
| DevTools cookie copy from local Chrome | They are already signed in to X locally and want no new login event on the VM. | Manual, but avoids typing credentials into the VM. Dies if X revokes the local session. |
| Local-agent cookie copy with Chrome/Playwright MCP | They have a local agent that can read their already-signed-in Chrome profile. | Quickest cookie-copy path, but still depends on the local X session staying valid. |
| noVNC interactive login on the VM | Existing cookies were revoked, password rotation invalidated sessions, or they want a fresh VM-held session. | Requires an interactive login event, but creates the session directly in the runtime profile. |

DevTools recipe:

1. In local Chrome where X is already signed in, open `https://x.com/home`, then press `Cmd-Option-I` on macOS or `Ctrl-Shift-I` on Windows/Linux.
2. Open **Application** -> **Storage** -> **Cookies** -> `https://x.com`.
3. Sort by **Name** alphabetically. `auth_token` and `ct0` are above the `guest_*` rows; `kdt` and `twid` are below them.
4. Copy exactly these cookie values: `auth_token`, `ct0`, `kdt`, `twid`.
5. Write `/root/.config/x-auth-cookies.json`, then run `npx tsx .claude/skills/twitter-auth-repair/scripts/restore-x-auth.ts` from the repo root.

Local-agent prompt:

```text
Use Playwright `context.cookies(['https://x.com', 'https://twitter.com'])` to dump my x.com cookies to ~/Downloads/x-cookies.json. Keep the cookies named auth_token, ct0, kdt, and twid, including their domain, path, secure, httpOnly, sameSite, and expires fields.
```

`restore-x-auth.ts` accepts either a JSON array of cookie objects or an object with a `cookies` array. Each cookie needs `name` and `value`; include `domain`, `path`, `secure`, `httpOnly`, `sameSite`, and `expires` or `expirationDate` when available. The required cookie names are `auth_token`, `ct0`, `kdt`, and `twid`; default `domain` to `.x.com` and `path` to `/` if manually writing from pasted values.

Minimal manual format:

```json
[
  { "name": "auth_token", "value": "...", "domain": ".x.com", "path": "/", "secure": true, "httpOnly": true },
  { "name": "ct0", "value": "...", "domain": ".x.com", "path": "/", "secure": true },
  { "name": "kdt", "value": "...", "domain": ".x.com", "path": "/", "secure": true, "httpOnly": true },
  { "name": "twid", "value": "...", "domain": ".x.com", "path": "/", "secure": true, "httpOnly": true }
]
```

Cookie staleness note: do not judge `/root/.config/x-auth-cookies.json` by age or mtime. X/Twitter can revoke the session server-side before the cookie's expiration date, especially when the user logs out of X in the local Chrome profile that supplied the copied cookies. Local logout means the VM copy of the same `auth_token` is dead too.

### Local macOS Or Windows

Use the native Chrome GUI. Do not route the user through `Xvfb`, `dbus`, or `gnome-keyring` instructions.

Guide them to:

1. Open the Chrome profile Evogent will use with remote debugging on `CDP_URL`.
2. Visit the target site and log in interactively.
3. Keep using that same profile for runtime access.

Concrete macOS launch:

```bash
mkdir -p "$PROFILE_DIR"
open -na "Google Chrome" --args \
  --remote-debugging-port=9222 \
  --user-data-dir="$PROFILE_DIR" \
  "$TARGET_URL"
```

Concrete Windows launch:

```powershell
$ProfileDir = if ($env:CHROME_BROWSE_PROFILE_DIR) { $env:CHROME_BROWSE_PROFILE_DIR } elseif ($env:X_BROWSER_PROFILE_DIR) { $env:X_BROWSER_PROFILE_DIR } else { "$PWD\data\chrome-browse-profile" }
Start-Process "$env:ProgramFiles\Google\Chrome\Application\chrome.exe" -ArgumentList "--remote-debugging-port=9222", "--user-data-dir=$ProfileDir", "$env:TARGET_URL"
```

After opening Chrome, stop and wait for the user to say login is complete. Do not run `/cache-refresh`, repeat CDP `/json/list`, reload the target page, or inspect the login tab while they are entering credentials.

After the user confirms login is complete, restart that Evogent Chrome profile and open the same target URL again. On macOS, quit Chrome with `osascript -e 'tell application "Google Chrome" to quit' || true`, wait two seconds, and rerun the `open -na` command above.

Source-specific guidance:

- For X/Twitter:
  - offer the three login paths above and let the user pick
  - direct login in Chrome is fine when they choose an interactive local profile path
  - browser-backed `tweet-cache` depends only on this Chrome profile
  - do not ask for `AUTH_TOKEN` and `CT0` unless the user explicitly wants the separate `tweet-cache-bird` skill
- For YouTube or other Google properties:
  - require interactive login in Chrome
  - do not suggest CDP login automation, cookie injection, or user-agent spoofing

### Desktop Linux VM

Use the shared persistent Chrome profile and verify the service chain first.

Required chain:

`LightDM/desktop session -> D-Bus session bus -> gnome-keyring -> chrome-browse`

If any service is missing or inactive, stop and tell the user the browser stack is not ready. Point them to `docs/reference/browser-setup-guide.md` for the full explanation of why cookie persistence depends on that chain.

Rules for this flow:

- Chrome must run non-headless inside the desktop session on `DISPLAY=:0`
- do not use `--headless` for the persistent browse profile
- `gnome-keyring` must stay available or cookies will disappear on Chrome restart

Source-specific guidance:

- For X/Twitter:
  - offer the three login paths above and let the user pick
  - if they choose noVNC, guide interactive login through the desktop Chrome session
  - if they choose cookie copy, write `/root/.config/x-auth-cookies.json`, import it with `restore-x-auth.ts`, and then verify the shared Chrome session
- For YouTube or Google:
  - always use interactive login through `noVNC`
  - explicitly say Google blocks CDP login flows, cookie injection, and user-agent spoofing
  - after sign-in, open the YouTube avatar menu, check `Location`, and set it to the user's preferred region because YouTube may pin recommendations to the VM IP's country

## Step 2: Desktop Linux noVNC Flow

Use this for YouTube and for X/Twitter when the user chooses the VM noVNC path.

1. Confirm the desktop session, D-Bus session bus, and keyring are present.
2. Leave `chrome-browse.service` as the owner of the shared profile.
3. Start or confirm `x11vnc` and `noVNC` for the existing desktop session.
4. Direct the user to complete login inside that exact Chrome window/profile.
5. For YouTube, open the avatar menu, verify `Location`, and set it to the user's preferred region before leaving the session.
6. After login, restart `chrome-browse.service` once and verify auth still persists.

Between steps 4 and 6, wait for explicit user confirmation. Do not inspect, reload, or navigate the shared tab while credentials are being entered.

Use the existing repo command guidance for the concrete shell commands when needed:

- `.claude/commands/setup-source.md`

## Step 3: Verification

Always verify after setup. Do not stop at "login completed".

For every platform:

1. Reload the target site in the runtime profile and confirm it is still logged in.
2. Restart Chrome or `chrome-browse.service`.
3. Open the site again and confirm the session survived the restart.
4. Verify Chrome CDP is reachable:
   ```bash
   curl -fsS "$CDP_URL/json/version" >/dev/null && echo READY chrome_cdp: "$CDP_URL"
   ```
5. Verify `/json/list` shows the target page, without printing cookies.
6. Run `npm run setup:agent` and require a `READY browser_provider` line for the selected brain provider before claiming setup is complete.

Extra checks:

- For X/Twitter:
  - browser-backed setup is complete only after the packaged setup-smoke `/cache-refresh twitter` path stores rows
  - install `tweet-cache` if missing with `curl -s -X POST "$API_BASE/api/skills/install" -H 'Content-Type: application/json' -d '{"registry":"tweet-cache"}'`
  - enqueue the normal refresh with `POST "$API_BASE/api/internal/orchestrator/enqueue"`, source `setup-source`, metadata `{"cacheSource":"twitter","triggerSource":"setup-source","setupSourceSmoke":true}`, and message `/cache-refresh twitter`
  - verify rows through `GET "$API_BASE/api/internal/browse-cache/items?source=twitter&limit=5"` and, for validation, SQLite `browse_cache_refresh_runs` plus `browse_cache_items`
  - keep background source browsing off until this one setup-smoke run has finished, so no scheduled refresh competes for the same shared browser session
  - only if the user explicitly chose `tweet-cache-bird`, run:
    ```bash
    source .env.local
    node node_modules/@steipete/bird/dist/cli.js whoami
    ```
- For YouTube:
  - confirm a signed-in page such as `https://www.youtube.com/feed/subscriptions` still loads after the restart
  - confirm the avatar-menu `Location` still matches the user's preferred region

Failure interpretation:

- VM reboot: login should survive when the desktop auto-login/keyring path is healthy
- `gnome-keyring` deletion or reset: re-login required
- normal Chrome restart: safe when Chrome is desktop-backed and the keyring is intact
- Chrome crash: safe when the profile and keyring session survive

## Step 4: Guardrails

- Never ask the user to paste passwords into chat. Treat pasted X session cookies as session credentials: only handle them when the user explicitly chooses a cookie-copy path, write them directly to `/root/.config/x-auth-cookies.json`, and do not echo them back.
- Do not claim Google login can be automated. It cannot be made reliable with CDP login, cookie injection, or user-agent tricks.
- Do not imply that browser-backed `tweet-cache` requires Bird auth. Bird is a separate X skill and should only appear when explicitly selected.
- Do not recommend `--password-store=basic` as a cookie persistence fix.
- Do not recommend `--disable-blink-features=AutomationControlled` as a Google login fix.
- Do not recommend `--headless` for the persistent Chrome profile.
- Do not use a one-off direct CDP extractor as source setup success. It is diagnostic only; the scheduler will use `/cache-refresh <source>`.
- Do not turn source setup into repeated login-tab probes. Passive checks are acceptable after user confirmation; credential entry must be an uninterrupted browser interaction.

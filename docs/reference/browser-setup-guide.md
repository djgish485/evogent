# Browser Setup Guide

Browser-backed sources such as Twitter browse mode and YouTube only work reliably when Evogent uses a real Chrome profile with persistent cookies. The setup is different on a Linux VM than it is on a local Mac or Windows machine, but the core rule is the same: the runtime must reuse the same Chrome profile after login.

The default shared-browser CDP endpoint is `http://127.0.0.1:9222`. Runtime probes and the Codex Playwright MCP launcher now resolve that endpoint from the same shared configuration and environment override path (`MEDIA_AGENT_SHARED_BROWSER_CDP_URL`, then `SHARED_BROWSER_CDP_URL`).

Keep the two local URLs distinct during setup:

- `http://127.0.0.1:3001` is Evogent app/API.
- `http://127.0.0.1:9222` is Chrome's CDP endpoint for the shared browser profile.

## Platform Matrix

| Platform | Recommended Chrome setup | Cookie persistence | Login method |
| --- | --- | --- | --- |
| **Linux VM (recommended)** | Install minimal desktop (XFCE + LightDM) with auto-login. Run `scripts/setup-desktop-browser.sh`. | Cookies persist across Chrome restarts AND VM reboots via gnome-keyring. | noVNC into the exact desktop Chrome session for every logged-in site. |
| Local macOS | Run Chrome natively with its normal GUI. | Chrome uses Keychain automatically. | Log in directly in Chrome. |
| Local Windows | Run Chrome natively with its normal GUI. | Chrome uses the OS credential store automatically. | Log in directly in Chrome. |
| Docker / containerized Linux | Same as Linux VM — the container must include the desktop layer. | Mount a persistent volume for `~/.config/chrome-browse-profile/` and `~/.local/share/keyrings/`. | noVNC into the containerized desktop. |

## Local macOS / Windows Quick Setup

Local desktop installs do not need LightDM, noVNC, or gnome-keyring. They do need Chrome launched with Evogent profile and remote debugging on the shared CDP endpoint.

Resolve the profile path from the same convention the runtime uses:

```bash
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
PROFILE_DIR="${CHROME_BROWSE_PROFILE_DIR:-${X_BROWSER_PROFILE_DIR:-${DATA_DIR:-$REPO_ROOT/data}/chrome-browse-profile}}"
CDP_URL="${MEDIA_AGENT_SHARED_BROWSER_CDP_URL:-${SHARED_BROWSER_CDP_URL:-http://127.0.0.1:9222}}"
```

On macOS:

```bash
mkdir -p "$PROFILE_DIR"
open -na "Google Chrome" --args \
  --remote-debugging-port=9222 \
  --user-data-dir="$PROFILE_DIR" \
  "https://x.com/home"
```

After login, restart that Evogent Chrome profile:

```bash
osascript -e 'tell application "Google Chrome" to quit' || true
sleep 2
open -na "Google Chrome" --args \
  --remote-debugging-port=9222 \
  --user-data-dir="$PROFILE_DIR" \
  "https://x.com/home"
```

On Windows PowerShell:

```powershell
$ProfileDir = if ($env:CHROME_BROWSE_PROFILE_DIR) { $env:CHROME_BROWSE_PROFILE_DIR } elseif ($env:X_BROWSER_PROFILE_DIR) { $env:X_BROWSER_PROFILE_DIR } else { "$PWD\data\chrome-browse-profile" }
Start-Process "$env:ProgramFiles\Google\Chrome\Application\chrome.exe" -ArgumentList "--remote-debugging-port=9222", "--user-data-dir=$ProfileDir", "https://x.com/home"
```

Then verify CDP without exposing cookies:

```bash
curl -fsS "$CDP_URL/json/version" >/dev/null && echo READY chrome_cdp: "$CDP_URL"
curl -fsS "$CDP_URL/json/list"
```

## Why Desktop Linux on VMs

Chrome on Linux encrypts cookies using `gnome-keyring`. On a normal desktop, gnome-keyring starts with the login session, stores its encryption key to disk (`~/.local/share/keyrings/`), and auto-unlocks on every login. Cookies persist forever — just like macOS Keychain.

On a headless server **without a desktop environment**, there is no login session. gnome-keyring generates a random in-memory key each time it starts. When Chrome restarts, the new key cannot decrypt the old cookies. The login is lost.

**The fix**: install a minimal desktop (XFCE + LightDM, ~500MB) with auto-login. This gives Chrome a real login session with a persistent gnome-keyring — cookies survive Chrome restarts, service restarts, and full VM reboots.

### Quick Setup

```bash
# On a fresh Ubuntu VM:
bash scripts/setup-desktop-browser.sh
sudo reboot
# After reboot: log into YouTube/Twitter via noVNC (see below)
```

## The Cookie Encryption Gotcha

Chrome on Linux does not just write usable cookies straight to disk. It encrypts them through the system secret store, which in practice means `gnome-keyring`.

That has one important consequence:

- If Chrome runs on Linux without a working, unlocked `gnome-keyring`, logins often appear to work until Chrome restarts, then the cookies are gone.
- On macOS, Chrome hands this off to Keychain automatically, so local Chrome login persistence is much simpler.
- On Windows, Chrome likewise uses the OS credential store.

`--password-store=basic` does **not** fix this. That flag changes password handling, not the encrypted cookie storage path.

## Linux VM: How It Works

When you run `setup-desktop-browser.sh`, it installs:

1. **XFCE + LightDM**: Minimal desktop environment with auto-login.
2. **gnome-keyring**: The system secret store Chrome uses for cookie encryption.
3. **Google Chrome**: The browser, running with `--remote-debugging-port=9222` for CDP access.
4. **noVNC + x11vnc**: For remote browser access when you need to log into sites.

On boot, LightDM auto-logs in as root, which creates a PAM session that unlocks gnome-keyring from the on-disk keyring file. Chrome starts in this session and can read/write encrypted cookies persistently.

### Service Architecture

```
LightDM (auto-login) → XFCE session → gnome-keyring (auto-unlocked by PAM)
                                     → chrome-browse.service (DISPLAY=:0, CDP on 9222)
```

Chrome runs as a systemd service (`chrome-browse.service`) inside the desktop session, using `DISPLAY=:0`. It auto-restarts on crash. The desktop session provides the keyring, so Chrome restarts are safe.

## How Agents Browse Authenticated Sites

Evogent spawns short-lived "nested browser tasks" through the configured brain provider (Codex or Claude). These tasks use the **Playwright MCP server** which connects to the desktop Chrome via CDP on port 9222. The agent reads Chrome's rendered pages — the same pages a human would see through noVNC.

**Important**: The `claude --chrome` flag (which uses the Claude Chrome extension via Anthropic's cloud relay) is NOT used for production browsing. The app uses local CDP via Playwright MCP, which keeps all browser communication on the VM with no external relay.

The Playwright MCP is configured in `.mcp.json` and `.claude/settings.local.json` with the managed launcher:

```json
{
  "mcpServers": {
    "playwright": {
      "command": "node",
      "args": ["scripts/start-playwright-mcp.js"]
    }
  }
}
```

That launcher resolves the CDP endpoint from `MEDIA_AGENT_SHARED_BROWSER_CDP_URL`, then `SHARED_BROWSER_CDP_URL`, then `http://127.0.0.1:9222`. Both Codex and Claude agents must expose the same `mcp__playwright__*` browser tools. `npm run setup:agent` prints a `browser_provider` line that reports whether the selected provider's Playwright MCP server targets the shared Chrome CDP endpoint.

## Twitter / X Setup

Browser-backed `tweet-cache` uses the shared Chrome profile as its primary auth source of truth. X/Twitter setup can reach that state through any of these equivalent paths; choose based on what the user can do most easily.

### Three Login Paths

| Path | Good fit | Trade-off |
|------|----------|-----------|
| Cookie copy from local Chrome via DevTools | User is already signed in to X in local Chrome and wants no new login event on the VM. | Manual, but avoids typing credentials into the VM. The copied session dies if X revokes that local session. |
| Cookie copy via local agent with Chrome/Playwright MCP | User has a local coding agent that can inspect their already-signed-in Chrome profile. | Quickest cookie-copy path when the local agent has browser access, but still depends on the local X session staying valid. |
| noVNC interactive login on the VM | Existing cookies are revoked, the user rotated their password, or the user wants a fresh VM-held session. | Requires an interactive login event, but creates a new session directly in the runtime profile. |

#### Path 1: DevTools Cookie Copy

1. In local Chrome where X is already signed in, open `https://x.com/home`, then press `Cmd-Option-I` on macOS or `Ctrl-Shift-I` on Windows/Linux.
2. In DevTools, open **Application** -> **Storage** -> **Cookies** -> `https://x.com`.
3. Sort the cookie table by **Name** alphabetically. `auth_token` and `ct0` are above the `guest_*` rows; `kdt` and `twid` are below them.
4. Copy the values for exactly these required cookies: `auth_token`, `ct0`, `kdt`, `twid`.
5. Save them on the VM as `/root/.config/x-auth-cookies.json` in the format accepted by `restore-x-auth.ts`:

```json
[
  { "name": "auth_token", "value": "...", "domain": ".x.com", "path": "/", "secure": true, "httpOnly": true },
  { "name": "ct0", "value": "...", "domain": ".x.com", "path": "/", "secure": true },
  { "name": "kdt", "value": "...", "domain": ".x.com", "path": "/", "secure": true, "httpOnly": true },
  { "name": "twid", "value": "...", "domain": ".x.com", "path": "/", "secure": true, "httpOnly": true }
]
```

Then run `npx tsx .claude/skills/twitter-auth-repair/scripts/restore-x-auth.ts` from the repo root to import the cookies into the shared Chrome profile.

#### Path 2: Local Agent Cookie Copy

Ask the user's local coding agent, where local Chrome is already signed in:

```text
Use Playwright `context.cookies(['https://x.com', 'https://twitter.com'])` to dump my x.com cookies to ~/Downloads/x-cookies.json. Keep the cookies named auth_token, ct0, kdt, and twid, including their domain, path, secure, httpOnly, sameSite, and expires fields.
```

Copy that JSON to `/root/.config/x-auth-cookies.json` on the VM, then run `npx tsx .claude/skills/twitter-auth-repair/scripts/restore-x-auth.ts` from the repo root.

#### Path 3: noVNC Interactive Login

1. Open the VM's Chrome through noVNC, or on local macOS/Windows open the dedicated Evogent Chrome profile with remote debugging on `9222`.
2. Before credential entry, turn **Background Source Browsing** off in Evogent so worker-scheduled source refreshes stay quiet during login.
3. Navigate to x.com once and complete the login flow in the shared desktop profile. Do not poll, reload, navigate, or run cache-refresh tasks against that tab while credentials are being entered.
4. After the user confirms login is complete, restart `chrome-browse.service` on Linux or restart the dedicated Evogent Chrome profile on local macOS/Windows, then confirm the session still survives.
5. Install `tweet-cache`.
6. Run exactly one packaged bounded `/cache-refresh twitter` setup-smoke path and verify the matching `browse_cache_refresh_runs` row plus rows in `browse_cache_items`.
7. Turn **Background Source Browsing** back on if automatic source refreshes should run after setup.

### Why Cookies Go Stale

X/Twitter can invalidate sessions server-side before the cookie's own expiration date. The common real-world case is logging out of X in local Chrome: if that local browser held the session copied to the VM, the VM's `auth_token` becomes invalid at the same time. Do not judge `/root/.config/x-auth-cookies.json` by file age alone; import and probe it. If the user wants the VM session preserved, recommend staying signed in to X in the local Chrome profile that supplied the copied cookies.

Notes:

- Source setup is not complete just because CDP can see X. It is complete when the normal packaged `/cache-refresh twitter` setup-smoke path persists rows through `/api/internal/browse-cache/submit` with `triggered_by='setup-source-smoke'` and a `setup-source-twitter-*` run id.
- If you separately use Bird-backed Twitter features, you also need `AUTH_TOKEN` and `CT0` in `.env.local` for the separate `tweet-cache-bird` provider path.
- `/root/.config/x-auth-cookies.json` is a Twitter-specific bootstrap/recovery file for the shared browser session. Do not generalize it to Google properties.
- Older cookie exports may come from Mac Chrome's Cookies SQLite DB using macOS Keychain decryption (AES-128-CBC v10 format with a 32-byte binary prefix that must be stripped), but DevTools or Playwright cookie export is simpler when available.
- With the desktop Linux keyring setup (XFCE + LightDM + gnome-keyring), Chrome cookies normally persist across Chrome restarts and VM reboots. The stored cookie file is insurance, not a regular requirement.
- Do not rely on ad hoc Chrome launches or alternate profiles. The shared desktop Chrome profile is the source of truth.

## YouTube / Google Setup

YouTube and other Google logins **must** be done interactively via noVNC.

Google properties do not use the Twitter stored-cookie recovery path. Keep Google auth entirely in the shared interactive desktop Chrome profile.

### Login Flow

```bash
# 1. Start noVNC on the VM (if not already running):
ssh root@your-vm 'x11vnc -display :0 -nopw -listen 0.0.0.0 -xkb -forever -bg && \
  websockify --daemon --web /usr/share/novnc 6080 localhost:5900'

# 2. SSH tunnel from your Mac:
ssh -L 6080:localhost:6080 root@your-vm

# 3. Open in your browser:
#    http://localhost:6080/vnc.html?autoconnect=true&resize=scale

# 4. In the VNC view, navigate Chrome to youtube.com and sign in.
# 5. Complete 2FA on your phone if prompted.
# 6. Open the YouTube avatar menu, check Location, and set it to your preferred region.
```

YouTube keeps a separate in-product `Location` preference under the avatar menu. On a remote VM, YouTube may auto-detect the VM IP's country on first use and keep that region for recommendations until you change it manually. This is separate from Chrome's `--lang` flag: `--lang=en-US` keeps the UI in English, but the YouTube `Location` setting still controls regional recommendation bias.

### What Does NOT Work for Google Login

Do not spend time on these approaches:

| Approach | Why it fails |
| --- | --- |
| CDP-driven login | Google detects `--remote-debugging-port` and blocks sign-in |
| Cookie injection from another machine | Splits auth away from the shared desktop profile and Google validates sessions against IP and browser fingerprint |
| `--disable-blink-features=AutomationControlled` | Google checks more than just `navigator.webdriver` |
| `navigator.webdriver` override | Google still detects automation via other signals |
| xdotool / synthetic input | Requires a window manager; Chrome ignores X11 events without one |

The only reliable path is a real interactive login in the exact Chrome profile the runtime will keep using.

## noVNC Reference

noVNC lets you see and interact with the VM's desktop through your web browser. It's only needed for initial login — once cookies are set, Evogent uses Chrome through CDP without any display access.

### Start noVNC

```bash
# On the VM:
x11vnc -display :0 -nopw -listen 0.0.0.0 -xkb -forever -bg
websockify --daemon --web /usr/share/novnc 6080 localhost:5900
```

### Connect

```bash
# From your Mac (SSH tunnel):
ssh -L 6080:localhost:6080 root@your-vm
# Then open: http://localhost:6080/vnc.html?autoconnect=true&resize=scale
```

### x11vnc Gotchas

- Do NOT use `-ncache` — it doubles the display height and makes noVNC show a tiny view.
- Use `-forever` so x11vnc stays running after the first VNC client disconnects.

### Stop noVNC

```bash
pkill x11vnc; pkill websockify
```

## What Breaks Logins

| Event | Desktop Linux VM | Headless Server (no desktop) |
| --- | --- | --- |
| Chrome restart / crash | **Safe** | Cookies lost |
| `systemctl restart chrome-browse` | **Safe** | Cookies lost |
| VM reboot | **Safe** (auto-login restores keyring) | Cookies lost |
| Keyring deletion (`rm ~/.local/share/keyrings/*`) | Re-login required | N/A |
| Google account password change | Re-login required | Re-login required |
| Cookie expiry (weeks/months) | Re-login required | Re-login required |

## Flags That Do Not Solve Cookie Persistence

| Flag | Why it does not help |
| --- | --- |
| `--password-store=basic` | Affects passwords, not cookie encryption |
| `--headless` | Triggers the Chromium cookie-clearing bug on restart |
| `--disable-gpu` | Can cause black screen rendering in Xvfb |

## Verification Checklist

After any login flow, verify the exact profile Evogent will use:

1. Open the target site in the managed desktop Chrome profile and confirm you are logged in.
2. Restart Chrome: `sudo systemctl restart chrome-browse.service`
3. Reopen the site and confirm you are **still** logged in.
4. Reboot the VM: `sudo reboot`
5. After reboot, reopen the site and confirm you are **still** logged in.
6. For YouTube, confirm `https://www.youtube.com/feed/subscriptions` loads personalized content.
7. For YouTube, open the avatar menu and confirm `Location` still matches the user's preferred region.

If step 3 or 5 clears the login on Linux, the desktop environment is not properly set up. Run `scripts/setup-desktop-browser.sh` and reboot.

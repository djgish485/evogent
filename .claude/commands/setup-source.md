Authenticate one browser-backed source in the shared Chrome profile, then prove the packaged cache-refresh path works.

Usage: `/setup-source <site>`
- Example: `/setup-source x.com`
- Example: `/setup-source youtube.com`

Rules:
- Never ask for passwords, cookies, `AUTH_TOKEN`, or `CT0` for browser-backed setup.
- Keep `http://127.0.0.1:3001` and `http://127.0.0.1:9222` visually distinct:
  - app/API URL: `http://127.0.0.1:${PORT:-3001}`
  - Chrome CDP URL: `http://127.0.0.1:9222`
- Do not use one-off direct CDP extraction as the success path. Success means the normal packaged setup-smoke `/cache-refresh <source>` worker path persisted rows and a matching refresh-run evidence row.
- During credential entry, do not poll, reload, navigate, or run cache refreshes against the shared Chrome tab. Make one user-visible login page available, then wait for the user to confirm login is done.

## 1. Resolve Inputs

1. Parse the target site from `$ARGUMENTS`. If empty, ask which source they want.
2. Resolve repo and runtime URLs:

```bash
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
API_BASE="${MEDIA_AGENT_INTERNAL_BASE_URL:-http://127.0.0.1:${PORT:-3001}}"
CDP_URL="${MEDIA_AGENT_SHARED_BROWSER_CDP_URL:-${SHARED_BROWSER_CDP_URL:-http://127.0.0.1:9222}}"
PROFILE_DIR="${CHROME_BROWSE_PROFILE_DIR:-${X_BROWSER_PROFILE_DIR:-${DATA_DIR:-$REPO_ROOT/data}/chrome-browse-profile}}"
uname -s
```

3. Map the site to its source, target URL, and skill:
   - `x.com`, `twitter.com`, `twitter`: `SOURCE=twitter`, `TARGET_URL=https://x.com/home`, `SKILL=tweet-cache`
   - `youtube.com`, `youtube`: `SOURCE=youtube`, `TARGET_URL=https://www.youtube.com/feed/subscriptions`, `SKILL=youtube-cache`
   - `substack.com`, `substack`: `SOURCE=substack`, `TARGET_URL=https://substack.com/home`, `SKILL=substack-cache`
4. Say this before login: credentials must be entered only in the Chrome/noVNC page, never in chat. Chat history is stored in the app.
5. Before opening the login page, make background source browsing quiet so the worker does not start scheduled cache refreshes while the user is typing:

   - Preferred: in the app Settings panel, turn **Background Source Browsing** off and leave the web app running.
   - If editing config directly, set `data/config.md` to:

     ```markdown
     ## Background Source Browsing
     Off
     ```

   Keep `npm start` running on local macOS/Windows. The worker may also keep running; with background source browsing off, it can still process the one explicit setup-smoke job later, but it will not enqueue scheduled source browsing during login.

## 2. Pick The Platform Path

### Local macOS

Use native Chrome with the dedicated Evogent profile:

```bash
mkdir -p "$PROFILE_DIR"
open -na "Google Chrome" --args \
  --remote-debugging-port=9222 \
  --user-data-dir="$PROFILE_DIR" \
  "$TARGET_URL"
```

Tell the user the opened Chrome window is the persistent Evogent browse profile. They should log into the target site there and leave that profile available for runtime use.

Stop here and wait for the user to say login is complete. Do not run `/cache-refresh`, repeat `/json/list`, reload the target page, or inspect the login tab while they are entering credentials.

Restart recipe after the user confirms login is complete:

```bash
osascript -e 'tell application "Google Chrome" to quit' || true
sleep 2
open -na "Google Chrome" --args \
  --remote-debugging-port=9222 \
  --user-data-dir="$PROFILE_DIR" \
  "$TARGET_URL"
```

### Local Windows

Use native Chrome with the dedicated Evogent profile:

```powershell
$ProfileDir = if ($env:CHROME_BROWSE_PROFILE_DIR) { $env:CHROME_BROWSE_PROFILE_DIR } elseif ($env:X_BROWSER_PROFILE_DIR) { $env:X_BROWSER_PROFILE_DIR } else { "$PWD\data\chrome-browse-profile" }
Start-Process "$env:ProgramFiles\Google\Chrome\Application\chrome.exe" -ArgumentList "--remote-debugging-port=9222", "--user-data-dir=$ProfileDir", "$env:TARGET_URL"
```

If Chrome is installed under `Program Files (x86)`, use that path instead. To restart, close that Chrome window and run the same `Start-Process` command again.

Stop here and wait for the user to say login is complete. Do not run `/cache-refresh`, repeat `/json/list`, reload the target page, or inspect the login tab while they are entering credentials.

### Linux Desktop VM

Use the systemd/noVNC desktop session only:

```bash
command -v google-chrome >/dev/null 2>&1 && echo CHROME_INSTALLED || echo CHROME_MISSING
command -v lightdm >/dev/null 2>&1 && echo LIGHTDM_PRESENT || echo LIGHTDM_MISSING
test -S /tmp/.X11-unix/X0 && echo X_DISPLAY_READY || echo X_DISPLAY_MISSING
test -S /run/user/0/bus && echo DBUS_READY || echo DBUS_MISSING
test -d /root/.local/share/keyrings && echo KEYRING_DIR_PRESENT || echo KEYRING_DIR_MISSING
systemctl is-enabled chrome-browse.service 2>/dev/null || true
systemctl is-active chrome-browse.service 2>/dev/null || true
```

If Chrome or desktop prerequisites are missing, tell the user to run `sudo bash "$REPO_ROOT/scripts/setup-desktop-browser.sh"` and stop.

Start the shared browser service if needed:

```bash
sudo systemctl enable --now chrome-browse.service
```

Start noVNC against the existing desktop session:

```bash
x11vnc -display :0 -nopw -forever -shared -bg
websockify --web=/usr/share/novnc/ 6080 localhost:5900 >/tmp/novnc.log 2>&1 &
```

Tell the user to tunnel `6080`, open noVNC, and log into the site inside the existing desktop Chrome session. Do not launch a temporary Chrome profile.

Stop here and wait for the user to say login is complete. Do not run `/cache-refresh`, repeat `/json/list`, reload the target page, or inspect the login tab while they are entering credentials.

Restart recipe after the user confirms login is complete:

```bash
sudo systemctl restart chrome-browse.service
```

## 3. Verify Chrome And Login

Only start this section after the user confirms login is complete.

Verify CDP is reachable:

```bash
curl -fsS "$CDP_URL/json/version" >/dev/null && echo READY chrome_cdp: "$CDP_URL"
```

Open or reuse an inspected target tab:

```bash
curl -fsS "$CDP_URL/json/new?$TARGET_URL" >/dev/null || true
```

Verify `/json/list` contains the target page without printing cookies:

```bash
curl -fsS "$CDP_URL/json/list" | TARGET_URL="$TARGET_URL" node -e '
const pages = JSON.parse(require("fs").readFileSync(0, "utf8"));
const target = new URL(process.env.TARGET_URL || "https://x.com/home");
const matches = pages.filter((p) => {
  try {
    const url = new URL(String(p.url || ""));
    return url.hostname === target.hostname || url.hostname.endsWith(`.${target.hostname}`);
  } catch {
    return false;
  }
});
if (!matches.length) process.exitCode = 1;
for (const page of matches) console.log(`READY chrome_target: ${page.title || "(untitled)"} ${page.url}`);
'
```

For X/Twitter, logged-in evidence is an X home page, visible profile/sidebar UI, or another post-login page. Do not print cookies or local storage.

## 4. Verify Provider Browser Wiring

Run setup readiness and read the `browser_provider` line:

```bash
npm run setup:agent
```

Expected:
- `READY browser_provider: ... Playwright MCP server "playwright" targets shared Chrome CDP http://127.0.0.1:9222`

If it prints `PENDING browser_provider`, fix that layer before installing the source skill. Common failures:
- Chrome missing: `CDP_URL/json/version` fails.
- Login missing: X page is login, signup, challenge, or consent-only.
- MCP endpoint mismatch: Claude/Codex Playwright target is not the shared `CDP_URL`.
- Tool allowlist mismatch: Claude cache-refresh tasks do not allow `mcp__playwright__browser_*`.

For Codex specifically, this direct diagnostic is available:

```bash
node -e 'require("./lib/codex-browser-prerequisites").checkCodexBrowserPrerequisites().then((r)=>{console.log(r.ok ? `READY codex_browser: ${r.serverName} ${r.configuredCdpUrl}` : `PENDING codex_browser: ${r.message}`); process.exitCode = r.ok ? 0 : 1})'
```

## 5. Install The Matching Skill

For `x.com`, `twitter.com`, or `twitter`:

```bash
curl -s -X POST "$API_BASE/api/skills/install" \
  -H 'Content-Type: application/json' \
  -d "{\"registry\":\"$SKILL\"}"
```

Bird-backed `tweet-cache-bird` is a separate opt-in source and is not part of browser-backed X setup.

## 6. Run Packaged Refresh And Verify Rows

Enqueue the normal cache-refresh worker path in bounded setup-smoke mode:

```bash
REQUEST_ID="setup-source-$SOURCE-$(date +%Y%m%d%H%M%S)"
EXPECTED_RUN_ID="setup-source-$SOURCE-$REQUEST_ID"
curl -s -X POST "$API_BASE/api/internal/orchestrator/enqueue" \
  -H 'Content-Type: application/json' \
  -d "{\"requestId\":\"$REQUEST_ID\",\"message\":\"/cache-refresh $SOURCE\",\"priority\":\"cache_refresh\",\"source\":\"setup-source\",\"metadata\":{\"cacheSource\":\"$SOURCE\",\"triggerSource\":\"setup-source\",\"setupSourceSmoke\":true}}"
```

The packaged task must submit a refresh run with `runId=$EXPECTED_RUN_ID`, `triggeredBy=setup-source-smoke`, and at least one item. Poll browse-cache rows through the app API as a quick visibility check:

```bash
curl -fsS "$API_BASE/api/internal/browse-cache/items?source=$SOURCE&limit=5" | node -e '
const body = JSON.parse(require("fs").readFileSync(0, "utf8"));
if (!body.ok || !body.count) {
  console.log("PENDING cache_refresh: no browse-cache rows yet");
  process.exitCode = 1;
} else {
  console.log(`READY cache_refresh: ${body.count} browse-cache rows visible through the app API`);
}
'
```

Then verify SQLite in the same `DATA_DIR`. This is the acceptance evidence; do not count older rows with a different run id:

```bash
sqlite3 "${DATA_DIR:-$REPO_ROOT/data}/media-agent.db" "
SELECT
  id,
  source,
  triggered_by,
  status,
  items_added,
  datetime(completed_at_ms / 1000, 'unixepoch') AS completed_at_utc,
  error
FROM browse_cache_refresh_runs
WHERE id = '$EXPECTED_RUN_ID'
  AND source = '$SOURCE'
  AND triggered_by = 'setup-source-smoke'
  AND status = 'completed'
  AND items_added > 0;
"
```

Also inspect the rows written for the same source:

```bash
sqlite3 "${DATA_DIR:-$REPO_ROOT/data}/media-agent.db" "
SELECT
  source,
  source_id,
  fetched_at_ms,
  datetime(fetched_at_ms / 1000, 'unixepoch') AS fetched_at_utc
FROM browse_cache_items
WHERE source = '$SOURCE'
ORDER BY fetched_at_ms DESC
LIMIT 5;
"
```

Only report source setup complete after:
- Chrome CDP on `9222` is reachable.
- The selected provider's Playwright MCP wiring targets that same CDP endpoint.
- The matching cache skill is installed.
- The packaged bounded `/cache-refresh <source>` setup-smoke path persisted browse-cache rows and the matching `browse_cache_refresh_runs` evidence row.
- Background source browsing is turned back on if the user wants automatic source refreshes after setup.

If setup fails, report the exact failed layer from the smoke run or observed prerequisite:
- `chrome_login`: shared Chrome is unreachable, logged out, challenged, or not on a post-login source page.
- `provider_mcp_endpoint`: selected provider's Playwright MCP is missing, disabled, pointed at a different CDP endpoint, or a different browser MCP was selected.
- `unsupported_provider_cli`: the selected CLI/model pairing cannot run browser-backed packaged tasks.
- `scraper_runtime`: the task reached the page but extraction failed.
- `submit_failure`: `/api/internal/browse-cache/submit` rejected or could not persist the run.
- `no_rows`: the task completed extraction/submission plumbing but no cache rows were written.

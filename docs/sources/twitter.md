# Twitter / X Access

Browser-first X access uses the shared Chrome browse profile and `tweet-cache`. That path does not require `AUTH_TOKEN` or `CT0`.

Setup is complete only after the packaged `/cache-refresh twitter` setup-smoke worker path persists browse-cache rows and a `setup-source-twitter-*` refresh run. Ad hoc CDP extraction is diagnostic only.

## Browser-Backed Setup

Use `/setup-source x.com` to authenticate X in the shared Chrome browse profile. X has three equivalent login paths: DevTools cookie copy from local Chrome, local-agent cookie copy with Chrome/Playwright MCP, or noVNC interactive login on the VM.

Before credential entry, turn **Background Source Browsing** off so the worker does not enqueue scheduled source browsing against the shared browser while the user is logging in.

For an interactive path, open the login page once, tell the user credentials stay in Chrome/noVNC, and wait for the user to confirm login is complete. Do not poll, reload, navigate, or run cache refreshes against the login tab while they type.

After confirmation, verify the selected provider's Playwright MCP wiring points at the shared Chrome CDP endpoint on `9222`, install `tweet-cache`, and run exactly one packaged bounded `/cache-refresh twitter` setup-smoke path.

Turn **Background Source Browsing** back on after the source-smoke evidence is verified unless the user explicitly wants it off as a steady-state preference.

See [../reference/browser-setup-guide.md](../reference/browser-setup-guide.md#twitter--x-setup) for platform-specific browser setup.

## Bird Access

Bird access is optional and lives behind the separate `tweet-cache-bird` skill. If that skill is installed and curation reports Bird auth errors, refresh `AUTH_TOKEN` and `CT0` in `.env.local`.

Only if the deployment explicitly wants Bird-backed X fetching, add:

```bash
AUTH_TOKEN=<value>
CT0=<value>
```

Then verify with:

```bash
source .env.local
node node_modules/@steipete/bird/dist/cli.js whoami
```

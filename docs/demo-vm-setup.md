# Public-Feed Demo VM Setup

Use this when you want a public demo where anyone can browse the Evogent feed, with optional read-only chat history, but only the owner can send chat messages or write. Chat is tool use against the host: if chat sending is public, a stranger can ask the agent to read secrets, run shell commands, or exfiltrate browser-source cookies. Keep chat writes and every write or internal endpoint behind Cloudflare Access even when reads are public.

## Paste Into a Coding Agent

Paste the prompt below into Claude Code, Codex, or any other coding agent on a machine that can SSH to the VM you want to use for the demo. The agent will work through the full doc end-to-end.

```text
Set up a public-feed Evogent demo for me on a small VM behind Cloudflare Access. I want anyone to browse the feed, but only my email should be allowed to chat or write.

I have ready: a Hetzner Cloud API token (or access to another VM provider), a domain managed by Cloudflare with Zero Trust enabled, the public hostname for the demo (ask me, e.g. `feed.example.com`), and the owner email allowed through Access (ask me). Confirm whether I also want anonymous visitors to read chat history (default: no).

Provision a small Ubuntu VM (2 to 4 GB RAM is plenty), lock the firewall down to SSH only, then install Evogent by following docs/setup-for-coding-agents.md end-to-end. Browser-backed sources need the desktop layer (`scripts/setup-desktop-browser.sh` plus reboot) so Twitter, YouTube, and Substack logins survive Chrome restarts. Configure at least one source so the demo feed has content to show. Keep the app bound to localhost on port 3001.

Then set up a Cloudflare tunnel from the chosen hostname to localhost:3001, and create the Cloudflare Access Applications described in docs/demo-vm-setup.md: multiple Public Bypass Applications covering the public destinations (the doc lists them) plus one Allow Owner Application for owner-only writes.

Critical gotchas to follow exactly:
- No more than 5 destinations per Cloudflare Access Application. Split the public destinations across multiple Bypass Applications.
- Do NOT put `<hostname>/*` on the Allow Owner Application. Cloudflare's matcher can pick that wildcard over the root Bypass and break the public homepage. Scope Allow Owner to `/api/*` and `/ws/*` only.
- Do NOT put the owner email on a Bypass policy. Bypass means no auth, period. The owner email goes on the Allow Owner policy.
- Do NOT bind Evogent to `0.0.0.0` and do NOT set `MEDIA_AGENT_TRUST_NETWORK`. The tunnel reaches the app on localhost; the gate trusts Cloudflare-Access-authenticated tunnel requests by their headers.
- If creating Access policies via API returns auth error 10000, use `PUT /accounts/{acct}/access/apps/{id}` with the `policies` array embedded instead of the dedicated policy endpoints.

When done, run the logged-out and logged-in verification checks in `Phase 5 - Verify` of docs/demo-vm-setup.md and report the final hostname plus any verification step whose response did not match what the doc says.
```

## Prerequisites

- Hetzner Cloud API token, or equivalent access to another VM provider.
- A domain managed by Cloudflare.
- Cloudflare Zero Trust enabled for the account.
- The public hostname for the demo, such as `feed.example.com`.
- The owner email address that should be allowed to chat and write.

## Phase 1 - VM

Provision a small Linux VM. A 2-4 GB RAM Ubuntu server is enough for a demo.

Configure the firewall before exposing anything else:

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp
sudo ufw enable
sudo ufw status verbose
```

Verify SSH still works before continuing. Do not open HTTP, HTTPS, or the Evogent app port on the VM firewall.

## Phase 2 - Install Evogent

Install Evogent by following [setup-for-coding-agents.md](setup-for-coding-agents.md) end to end on the VM:

- Phase 1 system setup.
- Phase 2 interactive configuration.
- Phase 3 launch and verify.

Configure at least one source so the demo feed has content. Keep the app bound to `127.0.0.1:3001`, which is the normal loopback setup. Do not open port `3001` on the firewall.

## Phase 3 - Cloudflare Tunnel

Install `cloudflared` on the VM with apt or the latest Debian package from the [Cloudflare releases page](https://github.com/cloudflare/cloudflared/releases).

Log in from the VM:

```bash
cloudflared tunnel login
```

Open the printed URL locally, choose the Cloudflare zone, and wait until the certificate is written on the VM.

Create the tunnel and route DNS:

```bash
cloudflared tunnel create evogent-demo
cloudflared tunnel route dns evogent-demo <hostname>
```

Write `/etc/cloudflared/config.yml`:

```yaml
tunnel: <tunnel UUID>
credentials-file: /root/.cloudflared/<tunnel UUID>.json
ingress:
  - hostname: <hostname>
    service: http://localhost:3001
  - service: http_status:404
```

Install and start the service:

```bash
sudo cloudflared service install
sudo systemctl enable --now cloudflared
sudo systemctl status cloudflared
```

The tunnel connects to Evogent on localhost, so the app can stay on `127.0.0.1:3001`.

## Phase 4 - Cloudflare Access

Create multiple Cloudflare Access Applications for the demo hostname. Access Allow and Bypass decisions apply to a whole Application, not to priority-ordered policies inside one Application, so the public paths and owner-only paths must live in separate Applications.

### Public Bypass Applications

Create one or more "Public Bypass" Applications. Each Application can have up to 5 destinations, so the standard public-feed demo needs three Bypass Applications.

Put these destinations across the Bypass Applications, with no more than 5 destinations per Application:

- `<hostname>/`
- `<hostname>/api/feed`
- `<hostname>/api/feed/`
- `<hostname>/api/threads`
- `<hostname>/api/threads/`
- `<hostname>/_next/static/*`
- `<hostname>/favicon.ico`
- `<hostname>/api/setup-readiness`
- `<hostname>/api/status`
- `<hostname>/api/ping`
- `<hostname>/api/brain-provider`
- `<hostname>/api/commands`
- `<hostname>/api/skills`
- `<hostname>/api/activity`
- `<hostname>/ws/feed`

Each Bypass Application has one policy:

- Action: `Bypass`
- Include rule: `Everyone`

Bypass means no Cloudflare login is required. Do not put the owner email on these policies.

If you want anonymous visitors to read chat history too (the public-chat-history variant), add a fourth Bypass Application with:

- `<hostname>/api/chat/messages`
- `<hostname>/api/chat/sessions`

That only makes anonymous chat-history reads public. The read route is split from writes, so `POST /api/chat` still goes to the owner-only Access Application.

### Allow Owner Application

Create one "Allow Owner" Application for authenticated owner traffic.

Use only these destinations:

- `<hostname>/api/*`
- `<hostname>/ws/*`

Add one policy:

- Action: `Allow`
- Include rule: `email == <owner email>`

Do not use `<hostname>/*` here. Cloudflare's matcher can choose that wildcard for the root path even when `<hostname>/` exists on a Bypass Application, which breaks the public homepage.

### How requests resolve

Cloudflare Access evaluates the matching Applications before the request reaches Evogent:

1. A specific Bypass destination such as `<hostname>/api/feed` wins over the Allow Application's `<hostname>/api/*` wildcard, so anonymous visitors can read the public feed.
2. A non-bypassed `/api/*` path matches the Allow Owner Application, so Cloudflare requires login and the owner email.
3. A non-bypassed `/ws/*` upgrade also matches the Allow Owner Application, so owner-only WebSocket paths stay authenticated.
4. A path that is not in any Access Application, such as `/admin`, `/foo`, or `/post/abc`, falls through to the origin without Cloudflare auth. Evogent's app-side gate is the second line: public page `GET`s render or 404 normally, while non-allowlisted API paths return 403.

Cloudflare path matching is prefix-style. A Bypass destination such as `<hostname>/api/skills` also matches `/api/skills/install`. Evogent's exact public allowlist and method checks are intentional defense-in-depth for that behavior.

API scripting tip: the dedicated policy endpoints `POST /accounts/{acct}/access/apps/{id}/policies` and `POST /accounts/{acct}/access/policies` can return auth error 10000, "Authentication error", even with a correctly scoped `Access: Apps and Policies: Edit` token. Use `PUT /accounts/{acct}/access/apps/{id}` with the `policies` array embedded in the Application update instead.

## Phase 5 - Verify

Use logged-out or incognito requests first:

- `GET /` returns 200 with the Evogent UI.
- `GET /api/feed` returns 200 with feed JSON.
- `GET /api/setup-readiness` returns 200.
- `GET /api/chat/messages` returns 200 for the public-chat-history variant, or 302 to Cloudflare login for the standard public-feed demo.
- `GET /api/chat` returns 302 to Cloudflare login.
- `POST /api/chat` returns 302 to Cloudflare login.
- `POST /api/agents/spawn` returns 302 to Cloudflare login.
- `GET /admin` returns the origin 404, with no Access redirect.
- `GET /post/<id>` returns 200 for a public post detail page.

Then sign in through Cloudflare as the owner email:

- `POST /api/chat` returns 202 and enqueues chat work.
- `GET /ws/orchestrator` as a WebSocket upgrade is allowed.

## What Not To Do

- Do not add a second public ingress route, port-forward to `3001`, or create a second tunnel hostname to the app. Access only protects traffic that comes through the protected hostname.
- Do not put the owner email on the Bypass policy. Bypass means no auth required, period. The owner email belongs on the Allow policy.
- Do not put a `<hostname>/*` wildcard destination on the Allow Application. Cloudflare's path matcher can pick that wildcard over the root `/` Bypass destination, breaking the public demo. Scope the Allow Application to `/api/*` and `/ws/*` instead.
- Do not assume Bypass destinations are exact-match. They are prefix-style, so `/api/skills` also matches `/api/skills/install`. Evogent's allowlist gate handles this with exact-match defense, but design the Bypass list with that behavior in mind.
- Do not put more than 5 destinations on a single Cloudflare Access Application. Cloudflare returns error 12130, "too many destinations for one app". Split public paths across multiple Bypass Applications.
- Do not bind Evogent to `0.0.0.0` for the tunnel. `cloudflared` connects to the app on localhost.
- Do not set any `MEDIA_AGENT_TRUST_NETWORK` style flag for this deployment. The gate trusts Cloudflare Access-authenticated tunnel requests by their Access headers, while Bypass-policy traffic still hits the read-only allowlist.

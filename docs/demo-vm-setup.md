# Public-Feed Demo VM Setup

For a public demo where anyone can browse the Evogent feed but only the owner can chat or write, paste the prompt below into Claude Code, Codex, or another coding agent on a machine that can SSH to your demo VM. Chat is tool use against the host: if chat sending is public, a stranger can ask the agent to read secrets, run shell commands, or exfiltrate browser-source cookies. Keep all writes and internal endpoints behind Cloudflare Access even when reads are public.

```text
Set up a public-feed Evogent demo for me on a small VM behind Cloudflare Access. Anyone should be able to browse the feed, but only my email should be allowed to chat or write. The brain has shell access to the host, so public chat is a security risk; keep all writes behind login.

Prerequisites I have ready (ask me for any you do not have yet):
- A Hetzner Cloud API token, or equivalent access to another VM provider.
- A domain managed by Cloudflare with Zero Trust enabled.
- The public hostname for the demo, e.g. feed.example.com.
- The owner email allowed through Cloudflare Access.
- Confirm whether anonymous visitors should also read chat history (default: no).

## Phase 1 - Provision and lock down the VM

Provision a small Ubuntu VM (2 to 4 GB RAM is plenty). Set up the firewall before exposing anything else:

    sudo ufw default deny incoming
    sudo ufw default allow outgoing
    sudo ufw allow 22/tcp
    sudo ufw enable
    sudo ufw status verbose

Verify SSH still works before continuing. Do NOT open HTTP, HTTPS, or port 3001 on the VM firewall. The Cloudflare tunnel reaches the app on localhost.

## Phase 2 - Install Evogent

Install Evogent by following docs/setup-for-coding-agents.md from https://github.com/djgish485/evogent end-to-end on the VM. Browser-backed sources need the desktop layer (run `scripts/setup-desktop-browser.sh` and reboot) so Twitter, YouTube, and Substack logins survive Chrome restarts. Configure at least one source so the demo feed has content.

Keep the app bound to 127.0.0.1:3001. Do NOT bind to 0.0.0.0, and do NOT set MEDIA_AGENT_TRUST_NETWORK. The gate trusts Cloudflare-Access-authenticated tunnel requests by their headers; Bypass-policy traffic falls through to the read-only allowlist.

## Phase 3 - Cloudflare tunnel

Install cloudflared on the VM (apt or the latest Debian package from the Cloudflare releases page).

Authenticate from the VM:

    cloudflared tunnel login

Open the printed URL in a local browser, choose the Cloudflare zone, and wait until the certificate is written on the VM.

Create the tunnel and route DNS:

    cloudflared tunnel create evogent-demo
    cloudflared tunnel route dns evogent-demo <hostname>

Write /etc/cloudflared/config.yml:

    tunnel: <tunnel UUID>
    credentials-file: /root/.cloudflared/<tunnel UUID>.json
    ingress:
      - hostname: <hostname>
        service: http://localhost:3001
      - service: http_status:404

Install and start the service:

    sudo cloudflared service install
    sudo systemctl enable --now cloudflared
    sudo systemctl status cloudflared

The tunnel reaches Evogent on localhost, so the app stays on 127.0.0.1:3001.

## Phase 4 - Cloudflare Access

Cloudflare Access decisions apply to a whole Application, not to priority-ordered policies inside one Application, so public paths and owner-only paths must live in separate Applications.

### Public Bypass Applications

Create multiple Public Bypass Applications for the demo hostname. Cloudflare allows up to 5 destinations per Application; the 14 public destinations below need 3 Bypass Applications (split them across, no more than 5 per Application):

- <hostname>/
- <hostname>/api/feed
- <hostname>/api/feed/
- <hostname>/api/threads
- <hostname>/api/threads/
- <hostname>/_next/static/*
- <hostname>/favicon.ico
- <hostname>/api/setup-readiness
- <hostname>/api/status
- <hostname>/api/ping
- <hostname>/api/brain-provider
- <hostname>/api/commands
- <hostname>/api/skills
- <hostname>/api/activity
- <hostname>/ws/feed

Each Bypass Application has one policy: action=Bypass, include rule=Everyone. Bypass means no Cloudflare login required. Do NOT put the owner email on these policies.

If anonymous chat-history reads should also be public, add a fourth Bypass Application with:

- <hostname>/api/chat/messages
- <hostname>/api/chat/sessions

That only makes anonymous chat-history reads public; POST /api/chat (write) still routes to the owner-only Allow Application below.

### Allow Owner Application

Create one Allow Owner Application for authenticated owner traffic. Use only these destinations:

- <hostname>/api/*
- <hostname>/ws/*

Add one policy: action=Allow, include rule=`email == <owner email>`.

The Allow Owner Application must require auth for all methods. The default `cloudflared access` and Cloudflare Access Application behavior covers every method, but if you customize include rules, ensure PATCH, PUT, and DELETE stay covered for owner-only paths.

Do NOT use <hostname>/* on the Allow Owner Application. Cloudflare's path matcher can pick that wildcard over the root <hostname>/ Bypass destination and break the public homepage. Scope Allow Owner to /api/* and /ws/* only.

### Cloudflare API quirk

If you script policy creation and the dedicated endpoints `POST /accounts/{acct}/access/apps/{id}/policies` or `POST /accounts/{acct}/access/policies` return auth error 10000 ("Authentication error") even with a correctly scoped `Access: Apps and Policies: Edit` token, use `PUT /accounts/{acct}/access/apps/{id}` with the policies array embedded in the Application update instead.

## Phase 5 - Verify

From a logged-out or incognito browser:
- GET / returns 200 with the Evogent UI.
- GET /api/feed returns 200 with feed JSON.
- GET /api/setup-readiness returns 200.
- GET /api/chat/messages returns 200 if the public-chat-history variant is enabled; otherwise 302 to Cloudflare login.
- GET /api/chat returns 302 to Cloudflare login.
- POST /api/chat returns 302 to Cloudflare login.
- POST /api/agents/spawn returns 302 to Cloudflare login.
- GET /admin returns the origin 404 (no Access redirect).
- GET /post/<id> returns 200 for a public post detail page.

Then sign in through Cloudflare as the owner email:
- POST /api/chat returns 202 and enqueues chat work.
- PATCH /api/chat/sessions/<id> returns 200 for a session owned by the signed-in user.
- GET /ws/orchestrator as a WebSocket upgrade is allowed.

## Common pitfalls to avoid

- Do not add a second public ingress route, port-forward to 3001, or create a second tunnel hostname. Access only protects traffic that comes through the protected hostname.
- Do not put the owner email on a Bypass policy. Bypass means no auth required, period. The owner email goes on the Allow policy.
- Do not put <hostname>/* on the Allow Application. Scope Allow Owner to /api/* and /ws/* instead.
- Cloudflare Bypass destinations are prefix-style. /api/skills also matches /api/skills/install. Evogent's allowlist gate handles this defensively, but design the Bypass list with that behavior in mind.
- Do not put more than 5 destinations on a single Cloudflare Access Application (error 12130).
- Do not bind Evogent to 0.0.0.0 for the tunnel. Cloudflared connects on localhost.
- Do not set MEDIA_AGENT_TRUST_NETWORK. The gate trusts Cloudflare-Access-authenticated tunnel requests by their headers; Bypass-policy traffic still hits the read-only allowlist.

Report the final hostname, plus any verification step whose response did not match what is described above.
```

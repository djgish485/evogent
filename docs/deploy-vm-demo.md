# Demo VM Deploy Runbook

Use this when the user asks for an Evogent demo VM behind Cloudflare Access, especially the public-feed pattern:

- Visitors can browse the feed without signing in.
- The owner must sign in before chat, write APIs, WebSockets other than the feed socket, or agent actions.
- The app stays bound to localhost on the VM. Cloudflared is the only public path.

This is a runbook for an agent, not a one-shot script. Probe the real environment, explain any missing prerequisite plainly, and adapt the commands to the user's chosen hostname, region, email, and repo state.

## Required Tooling Probe

Run these checks before creating infrastructure:

```bash
command -v hcloud >/dev/null 2>&1 && hcloud version || echo "missing hcloud"
command -v cloudflared >/dev/null 2>&1 && cloudflared --version || echo "missing cloudflared"
test -f /root/.cloudflared/cert.pem && echo "cloudflared cert present" || echo "missing /root/.cloudflared/cert.pem"
test -n "${CF_API_TOKEN:-}" && echo "CF_API_TOKEN present" || echo "CF_API_TOKEN missing"
```

Confirm the demo hostname, Cloudflare account/zone access, owner email, Hetzner region, and SSH key with the user.

If `/root/.cloudflared/cert.pem` is missing, run:

```bash
cloudflared tunnel login
```

Open the printed URL locally, choose the Cloudflare zone, and verify the cert landed on the VM before continuing.

## Hetzner Provision

Use at least 4 GB RAM. `cpx21` is the small default that has enough room for Next.js, SQLite, the agent process, and desktop-backed Chrome.

Example:

```bash
hcloud server create \
  --name <vm-name> \
  --type cpx21 \
  --image ubuntu-24.04 \
  --location <region> \
  --ssh-key <ssh-key-name>
```

Record the public IPv4 address and verify SSH:

```bash
ssh -o ConnectTimeout=15 root@<vm-ip> "bash --norc --noprofile -c 'uname -a'"
```

Lock the firewall down early. Keep SSH open. Do not open HTTP, HTTPS, or port 3001 to the internet.

```bash
ufw allow 22/tcp
ufw --force enable
ufw status verbose
```

If using a Hetzner Cloud firewall instead of UFW, apply the same rule: inbound SSH only. Cloudflared will make outbound connections.

## Cloudflared Tunnel And DNS

Install cloudflared on the VM if needed, then create or reuse a tunnel.

Choose a stable tunnel name:

```bash
TUNNEL_NAME=<name>
HOSTNAME=<demo-hostname>
```

Reuse an existing tunnel credentials file when it exists:

```bash
ls /root/.cloudflared/*.json 2>/dev/null || true
```

If `/root/.cloudflared/<tunnel-id>.json` already belongs to the desired tunnel, reuse it. Otherwise create a tunnel:

```bash
cloudflared tunnel create "$TUNNEL_NAME"
cloudflared tunnel route dns "$TUNNEL_NAME" "$HOSTNAME"
```

Write `/etc/cloudflared/config.yml`:

```yaml
tunnel: <tunnel-id-or-name>
credentials-file: /root/.cloudflared/<tunnel-id>.json

ingress:
  - hostname: <demo-hostname>
    service: http://127.0.0.1:3001
  - service: http_status:404
```

Install and start the service:

```bash
cloudflared service install
systemctl enable --now cloudflared
systemctl status cloudflared --no-pager
```

The Evogent service should still listen on `127.0.0.1:3001`, not `0.0.0.0`.

## Cloudflare Access App And Policy

The public-feed demo needs both of these access decisions:

- Bypass authentication for read-only feed paths so unauthenticated visitors can browse.
- Allow only the owner email for chat, write paths, internal APIs, and private WebSockets.

In practice, create path-scoped Access applications. Cloudflare path matching and destination limits can make separate applications clearer than one broad wildcard:

- Public Bypass application destinations should include `/`, feed reads such as `/api/feed*`, feed assets needed by the UI, and `/ws/feed` if live feed updates are public.
- Owner Allow application destinations should include `/api/chat*`, `/api/agents*`, `/api/internal*`, `/api/orchestrator*`, write APIs, and private WebSocket paths such as `/ws/chat`, `/ws/orchestrator`, and `/ws/agent-progress`.

Do not put a broad `<hostname>/*` owner-only destination in front of the public homepage unless you have verified it does not override the bypass app.

API shape for an Access application update:

```json
{
  "name": "evogent-demo-owner",
  "domain": "<demo-hostname>",
  "type": "self_hosted",
  "session_duration": "24h",
  "policies": [
    {
      "name": "Allow owner",
      "decision": "allow",
      "include": [{ "email": { "email": "<owner-email>" } }]
    }
  ]
}
```

For public read paths, use an inline policy with a bypass decision and an Everyone include rule:

```json
{
  "name": "evogent-demo-public-feed",
  "domain": "<demo-hostname>",
  "type": "self_hosted",
  "policies": [
    {
      "name": "Public feed bypass",
      "decision": "bypass",
      "include": [{ "everyone": {} }]
    }
  ]
}
```

Cloudflare API gotcha: if `POST /accounts/{account_id}/access/apps/{app_id}/policies` or `POST /accounts/{account_id}/access/policies` returns auth error `10000` even with an Access edit token, update the Access application with:

```bash
curl -fsS -X PUT \
  "https://api.cloudflare.com/client/v4/accounts/<account-id>/access/apps/<app-id>" \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  -H "Content-Type: application/json" \
  --data @app-with-inline-policies.json
```

The `policies` array must be embedded in that application update. Keep the Bypass policy for feed read paths and the Allow policy for owner-only paths distinct and easy to audit.

## Evogent Install

On the VM:

```bash
git clone https://github.com/djgish485/evogent.git /root/evogent
cd /root/evogent
npm install
npm run build
bash scripts/setup.sh
```

If the user asked for a coding-agent install, follow `docs/setup-for-coding-agents.md` end-to-end.

Important first-boot rule: the server creates the canonical default chat sessions at startup. Do not `POST /api/chat/sessions` to preemptively create "General Agent". That endpoint is for user-created sessions and will mint a fresh UUID.

Verify local service health:

```bash
systemctl status evogent --no-pager
systemctl status evogent-worker --no-pager
curl -fsS http://127.0.0.1:3001/api/status
```

## Source Bootstrap

Use the browser-first source flow:

```text
/setup-source x.com
```

Follow `.claude/skills/setup-source/SKILL.md`. For VM browser-backed sources, run `scripts/setup-desktop-browser.sh` when the desktop/keyring/Chrome stack is missing, reboot if instructed, then verify the shared Chrome profile survives restart.

Bird is an explicit opt-in fallback only. Never auto-install `tweet-cache-bird` when the browser path hangs. The install API rejects `tweet-cache-bird` without `confirmExplicit: true`; pass that flag only after the user typed `tweet-cache-bird` verbatim or explicitly chose the Bird path.

## SSO Across Access Apps

Cloudflare Access sessions are shared at the team domain, for example `<team>.cloudflareaccess.com`. If the user already has a valid Access session for another app, Cloudflare may SSO them through the new app immediately.

Direct the user to the protected app URL first:

```text
https://<demo-hostname>/
```

Do not hand them a deep link to the Cloudflare login page on the first try. It can render blank when SSO has already completed and Cloudflare is passing them through.

## Verification Checklist

From a machine that is not signed in through Cloudflare Access:

```bash
curl -i https://<demo-hostname>/api/feed?limit=1
curl -i https://<demo-hostname>/api/chat
```

Expected:

- `GET /api/feed*` returns `200` with JSON.
- `GET /api/chat` redirects to Cloudflare Access, usually `302`.
- `POST /api/chat` redirects or is blocked by Access.
- Private WebSockets do not connect without Access.

Then sign in as the owner email at:

```text
https://<demo-hostname>/
```

Expected after sign-in:

- The app loads with a friendly empty or populated feed state.
- Chat/write paths return `200` or the expected app response.
- The sessions list contains one canonical "General Agent" and one canonical "Curator Agent" on a fresh bring-up.
- Re-running `scripts/setup.sh` does not add duplicate default sessions.
- Browser-backed source setup can populate rows before the first public demo.

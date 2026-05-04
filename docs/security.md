# Security

Evogent's brain has full tool and command-line access to the host. Chat, agent-spawn, import, skill-install, suggestion-accept, and config-write endpoints can become host command execution if exposed directly.

## Default Network Gate

By default, non-loopback clients can only reach the UI, static assets, `/ws/feed`, and a small read-only API allowlist: `GET`/`HEAD` `/api/feed*`, `/api/threads*`, `/api/setup-readiness`, `/api/status`, `/api/ping`, `/api/brain-provider`, `/api/commands`, `/api/skills`, `/api/activity`, `/api/chat/messages`, and `/api/chat/sessions`.

Evogent binds to `127.0.0.1` by default; set `HOST=0.0.0.0` only when an authenticated reverse proxy is in front. Private WebSocket paths also reject browser upgrades whose `Origin` host does not match the request `Host`; `/ws/feed` stays public and read-only.

Chat-history reads are intentionally available for the public-feed demo scenario. Operators who do not want chat history visible should keep their Cloudflare Access Allow policy on those paths, which is the default owner-only deployment shape.

Everything else is loopback-only unless you opt out: chat writes, preferences, interactions, agent spawn, import archive, skill install, suggestions accept/retry, config writes, feed enrichment, `/ws/chat`, `/ws/orchestrator`, and `/ws/agent-progress`. `/api/internal/*` and `/api/orchestrator/*` also remain loopback-only.

Set `MEDIA_AGENT_TRUST_NETWORK=1` only after fronting Evogent with an auth proxy the gate cannot identify. Cloudflare forwarding headers alone do not make tunnel-forwarded requests trusted, even if cloudflared connects to Evogent from localhost.

When Cloudflare Access fronts Evogent, set `MEDIA_AGENT_CF_ACCESS_TEAM_DOMAIN=<team>.cloudflareaccess.com` so Evogent verifies `Cf-Access-Jwt-Assertion` against Cloudflare's JWKS before trusting tunnel-forwarded identity; optionally set `MEDIA_AGENT_CF_ACCESS_AUD=<application-aud>` to reject JWTs issued for a different Access application. If the team domain is unset, Evogent preserves the legacy fallback and treats `Cf-Access-Jwt-Assertion` or `Cf-Access-Authenticated-User-Email` header presence as trusted; when JWKS mode is configured, the email header alone is not trusted. Bypass-policy traffic does not carry those headers, so the read-only allowlist still applies; this keeps the public-feed / private-chat demo pattern working without `MEDIA_AGENT_TRUST_NETWORK=1`.

cloudflared by itself is not authentication. If you expose Evogent through another authenticated reverse proxy, set `MEDIA_AGENT_TRUST_NETWORK=1` only after that proxy protects chat, agent-spawn, write APIs, and private WebSockets. Other proxy-specific headers are out of scope for this gate.

## Deployment Recommendations

- **Local machine:** no auth needed if the app binds to localhost.
- **VM or VPS:** authentication is the deployer's responsibility; use Cloudflare Access, proxy-level basic auth, IP allowlists, a VPN, or an equivalent deployment-layer control.
- **Strongest option:** use a VPN such as Tailscale or WireGuard, or an authenticated tunnel such as Cloudflare Access.

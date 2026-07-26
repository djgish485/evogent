# Security

Evogent's brain has tool and command-line access to its runtime. Chat,
agent-spawn, import, skill-install, suggestion-accept, and config-write endpoints
can become command execution if exposed directly.

## Canonical phone profile

Phone production has no intentional network-facing server:

- the Node server exposes only its separate Termux HTTP and Android HTTPS
  listeners on `127.0.0.1`;
- the WebView and on-phone tools mutually authenticate that loopback server;
- Redis and VM background workers are disabled;
- the accessibility control surface is loopback-only and token-gated; and
- USB forwarding/SSH are optional development channels, not runtime APIs.

Android's loopback namespace is shared by every installed app, so a `127.0.0.1`
source address is not an identity boundary. The phone server therefore denies
every page, asset, API, SSE, and WebSocket request except its bounded
authentication handshake. The APK trusts only the private CA embedded in its
release and the installer deploys the matching loopback TLS keypair atomically.
It then verifies a control-token HMAC from the current server process, proves
its own possession of that token, and accepts only a random process-bound
session whose final transcript is also authenticated.
WebView sessions use a host-only HttpOnly cookie; native notification/share
submissions use single-request sessions. A server restart invalidates them all.

Termux mechanics never send either durable or process credentials to a first
contact listener. `evo-curl` uses the private mode-`0600` control token only as
an HMAC key, verifies the server's challenge proof, completes a one-shot direct
session, and relays the protected request over that exact authenticated TCP
connection. A process that takes the port after Node dies therefore receives
neither a credential nor the request body. The separate random process
credential is reserved for the Node server's own recursive loopback calls and
rotates on every start.

Token and session checks fail closed. Android exported components accept only the narrow
actions and destinations they need. WebView-to-native calls must verify the exact
committed local frame, the authenticated WebView generation, and validated
outbound destinations; untrusted iframes, unauthenticated loads, or source
content never receive a native bridge.

The shell APK owns launcher/input mechanics, not an externally callable generic
“launch any package/activity” service. The former exported browse service and
periodic APK alarm are not part of the phone architecture.

Source content, accessibility text, screenshots, notifications, and HTTP bodies
are untrusted data. They cannot override runtime instructions. Private data,
tokens, account identifiers, device connection values, and raw device logs stay
outside public commits and release manifests.

## Default Network Gate

This section describes the default/VM profile. The phone profile uses the
stricter authenticated-loopback contract above and has no public read allowlist.

By default, non-loopback clients can only reach the UI, static assets, `/ws/feed`, and a small read-only API allowlist: `GET`/`HEAD` `/api/feed*`, `/api/threads*`, `/api/setup-readiness`, `/api/status`, `/api/ping`, `/api/brain-provider`, `/api/commands`, `/api/skills`, `/api/activity`, `/api/chat/messages`, and `/api/chat/sessions`.

Evogent binds to `127.0.0.1` by default; set `HOST=0.0.0.0` only when an authenticated reverse proxy is in front. Private WebSocket paths also reject browser upgrades whose `Origin` host does not match the request `Host`; `/ws/feed` stays public and read-only.

Chat-history reads are intentionally available for the public-feed demo scenario. Operators who do not want chat history visible should keep their Cloudflare Access Allow policy on those paths, which is the default owner-only deployment shape.

Everything else is loopback-only unless you opt out: chat writes, preferences, interactions, agent spawn, import archive, skill install, suggestions accept/retry, config writes, feed enrichment, `/ws/chat`, `/ws/orchestrator`, and `/ws/agent-progress`. `/api/internal/*` and `/api/orchestrator/*` also remain loopback-only.

Set `MEDIA_AGENT_TRUST_NETWORK=1` only after fronting Evogent with an auth proxy the gate cannot identify. Cloudflare forwarding headers alone do not make tunnel-forwarded requests trusted, even if cloudflared connects to Evogent from localhost.

When Cloudflare Access fronts Evogent, set `MEDIA_AGENT_CF_ACCESS_TEAM_DOMAIN=<team>.cloudflareaccess.com` so Evogent verifies `Cf-Access-Jwt-Assertion` against Cloudflare's JWKS before trusting tunnel-forwarded identity; optionally set `MEDIA_AGENT_CF_ACCESS_AUD=<application-aud>` to reject JWTs issued for a different Access application. If the team domain is unset, Evogent preserves the legacy fallback and treats `Cf-Access-Jwt-Assertion` or `Cf-Access-Authenticated-User-Email` header presence as trusted; when JWKS mode is configured, the email header alone is not trusted. Bypass-policy traffic does not carry those headers, so the read-only allowlist still applies; this keeps the public-feed / private-chat demo pattern working without `MEDIA_AGENT_TRUST_NETWORK=1`.

cloudflared by itself is not authentication. If you expose Evogent through another authenticated reverse proxy, set `MEDIA_AGENT_TRUST_NETWORK=1` only after that proxy protects chat, agent-spawn, write APIs, and private WebSockets. Other proxy-specific headers are out of scope for this gate.

## Deployment Recommendations

- **Android phone:** use the `phone` runtime profile and loopback-only listener;
  do not set `MEDIA_AGENT_TRUST_NETWORK=1`.
- **Local machine:** no auth needed if the app binds to localhost.
- **VM or VPS:** authentication is the deployer's responsibility; use Cloudflare Access, proxy-level basic auth, IP allowlists, a VPN, or an equivalent deployment-layer control.
- **Strongest option:** use a VPN such as Tailscale or WireGuard, or an authenticated tunnel such as Cloudflare Access.

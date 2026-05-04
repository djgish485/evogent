# Bird CLI Reference

The runtime uses [Bird CLI](https://github.com/steipete/bird) (`@steipete/bird`) to search Twitter/X and fetch tweets.

## Auth Model

Bird calls Twitter's internal GraphQL endpoints using cookie auth.

| Cookie | Description |
|--------|-------------|
| `AUTH_TOKEN` | The `auth_token` cookie identifying the Twitter session |
| `CT0` | The `ct0` CSRF token |

Bird is optional. Without these cookies, curation can still rely on web search and article coverage.

## Manual Usage

For local verification outside the app runtime:

```bash
export $(grep -E '^(AUTH_TOKEN|CT0)=' .env.local | xargs)
node ./node_modules/@steipete/bird/dist/cli.js search "AI agents" -n 15 --json
```

Other useful checks:

```bash
export $(grep -E '^(AUTH_TOKEN|CT0)=' .env.local | xargs)
node node_modules/@steipete/bird/dist/cli.js search "test" -n 1 --json
node node_modules/@steipete/bird/dist/cli.js whoami
```

## Getting Cookies

Browser path:

1. Open `https://x.com` in Chrome and sign in.
2. Open DevTools.
3. Go to Application -> Cookies -> `https://x.com`.
4. Copy `auth_token` into `AUTH_TOKEN`.
5. Copy `ct0` into `CT0`.

Alternative extraction options:

```bash
openclaw browser cookies
```

```javascript
document.cookie.split(';').forEach(c => {
  if (c.trim().startsWith('auth_token=') || c.trim().startsWith('ct0=')) {
    console.log(c.trim());
  }
});
```

After updating `.env.local`, restart the service:

```bash
sudo systemctl restart evogent
```

If Bird starts returning auth errors or empty data, refresh `AUTH_TOKEN` and `CT0`.

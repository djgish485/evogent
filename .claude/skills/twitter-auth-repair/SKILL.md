---
name: twitter-auth-repair
description: Repair the shared browser X/Twitter session for tweet-cache from the stored X cookie export and verify x.com in the attached session.
user-invocable: false
metadata:
  evogent:
    heartbeat-task: false
---
# Twitter Auth Repair

Use this when tweet-cache's normal shared-browser X auth probe fails and `/root/.config/x-auth-cookies.json` exists or needs to be refreshed.

Goal: repair the existing shared desktop Chrome X session for `x.com` without moving cookie bootstrap behavior back into product code.

## Workflow

1. Inspect the attached shared browser session on `https://x.com/home` with browser tools first.
2. If the attached page already shows a signed-in X profile, stop and report that this is an attachment or probe issue instead of importing cookies.
3. If the attached page is signed out or redirected to login and the cookie export exists, run:

```bash
npx tsx .claude/skills/twitter-auth-repair/scripts/restore-x-auth.ts
```

4. After the script finishes, use browser tools again on `https://x.com/home` and verify that the profile link is present and the session is signed in.
5. If the repair still fails, treat the cookie export as server-revoked and refresh X auth through one of the three equivalent login paths below. Then rerun the import and the post-import `https://x.com/home` probe.

## Refresh Paths

See `.claude/skills/setup-source/SKILL.md` and `docs/reference/browser-setup-guide.md` for the full setup flow. In recovery, the three X/Twitter paths are:

| Path | Use when | Trade-off |
|------|----------|-----------|
| DevTools cookie copy from local Chrome | The user is still signed in to X locally and wants no new login event on the VM. | Manual, but avoids typing credentials into the VM. Dies if X revoked that local session. |
| Local-agent cookie copy with Chrome/Playwright MCP | The user has a local agent that can read their already-signed-in Chrome profile. | Quickest cookie-copy path, but still depends on the local X session staying valid. |
| noVNC interactive login on the VM | Existing cookies were revoked, password rotation invalidated sessions, or the user wants a fresh VM-held session. | Requires an interactive login event, but creates the session directly in the runtime profile. |

DevTools cookie copy needs exactly these required cookie names: `auth_token`, `ct0`, `kdt`, `twid`. In Chrome DevTools, open **Application** -> **Storage** -> **Cookies** -> `https://x.com`, sort **Name** alphabetically, then note that `auth_token` and `ct0` are above the `guest_*` rows while `kdt` and `twid` are below them.

Local-agent prompt:

```text
Use Playwright `context.cookies(['https://x.com', 'https://twitter.com'])` to dump my x.com cookies to ~/Downloads/x-cookies.json. Keep the cookies named auth_token, ct0, kdt, and twid, including their domain, path, secure, httpOnly, sameSite, and expires fields.
```

`restore-x-auth.ts` accepts either a JSON array of cookie objects or an object with a `cookies` array. Required cookie names are `auth_token`, `ct0`, `kdt`, and `twid`; if manually writing pasted values, default `domain` to `.x.com`, `path` to `/`, and `secure` to `true`.

Server-revocation note: X/Twitter can reject a cookie before its own expiration date. The common cause is logging out of X in another browser that holds the same session, including local Chrome. That logout kills the VM copy of the same `auth_token`, so do not explain this as simple file-age staleness.

## Guardrails

- Keep the shared desktop Chrome profile as the primary auth source of truth.
- Use `/root/.config/x-auth-cookies.json` only as a Twitter-specific fallback for `x.com`.
- Never skip the cookie import based on file age, mtime, or any other a-priori freshness heuristic; if the shared session is signed out and the export exists, run the import and let the post-import `https://x.com/home` probe decide whether credentials are stale.
- If the post-import probe still shows signed out, refresh the cookies through DevTools cookie copy, local-agent cookie copy, or noVNC interactive login instead of repeatedly importing the same revoked export.
- Do not generalize this into a cookie-management subsystem or apply it to Google properties.
- Do not change product code as part of this repair task.
- Do not describe a still-signed-in attached session as "cookies disappeared". Diagnose the attachment boundary instead.

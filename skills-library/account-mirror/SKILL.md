---
name: account-mirror
description: Mirror tweets from specific Twitter accounts into the feed on heartbeat cycles. Use when the user wants guaranteed coverage for selected accounts regardless of algorithmic feed ranking.
user-invocable: true
metadata:
  evogent:
    heartbeat-task: true
    requires:
      env:
        - AUTH_TOKEN
        - CT0
---
# Account Mirror

Use this skill to ensure selected accounts are scanned on each curation cycle.

## Configuration

When installing this skill, prompt the user for:
- `accounts` (required, string[]): Which Twitter `@handles` to mirror (comma-separated, no `@` prefix)
- `limitPerAccount` (optional, number, default: `15`): Max tweets per account per cycle

After collecting values, write to `.claude/skills/account-mirror/config.json`:

`{ "accounts": ["handle1", "handle2"], "limitPerAccount": 15 }`

## Heartbeat Task

1. Read configured usernames from `.claude/skills/account-mirror/config.json`.
2. For each account, call Bird CLI `user-tweets <username> -n <limitPerAccount> --json`.
3. Keep only posts that pass the normal curation quality bar.
4. Write accepted items to `data/feed-output.jsonl` with dedup-safe `sourceId` values.
5. Respect existing feed dedup checks before appending.

## Guardrails

- Skip retweets/reposts unless they add original commentary.
- Do not exceed 3 mirrored tweets per account per cycle unless explicitly requested.
- If Bird auth is unavailable, log the issue in analysis output and continue with non-Twitter sources.

# Skills

Skills extend the brain's capabilities. They live in `.claude/skills/`. General skills are available when installed. Source skills become automatic refresh sources when installed and setup proof exists; **Background Source Browsing** is the global pause switch.

## Available Skills

| Skill | Type | Description |
|-------|------|-------------|
| **setup-wizard** | One-time | Chat-guided first-run onboarding and verification |
| **tweet-cache** | Per-cycle | Browser-backed X/Twitter cache for cache-first curation |
| **tweet-cache-bird** | Per-cycle | Bird-authenticated X/Twitter cache for deployments that explicitly choose Bird |
| **youtube-cache** | Per-cycle | Browser-backed YouTube source for cache-first curation |
| **substack-cache** | Per-cycle | Browser-backed Substack source for cache-first curation |
| **hackernews-cache** | Per-cycle | Hacker News source for cache-first curation |
| **full-text** | Per-cycle | Fetches full article text for richer summaries |
| **account-mirror** | Per-cycle | Mirrors specific Twitter accounts |
| **archive-import** | One-time | Imports Twitter data export as preferences |
| **current-event-tracker** | On-demand | Track developing events with structured curation prompt sections |

## Installing Skills

The app must be running before skill installation.

```bash
curl -s -X POST http://localhost:3001/api/skills/install \
  -H 'Content-Type: application/json' \
  -d '{"registry":"<skill-name>"}'
```

Recommend **full-text** for everyone. Recommend the source skill that matches the user's selected source: **tweet-cache** for X/Twitter, **youtube-cache** for YouTube, **substack-cache** for Substack, or **hackernews-cache** for Hacker News.

Only recommend **tweet-cache-bird** when the deployment explicitly wants Bird-backed fetching. Only offer **account-mirror** if Twitter auth is configured.

For **account-mirror**, ask which Twitter handles to mirror and write config:

```bash
mkdir -p .claude/skills/account-mirror
cat > .claude/skills/account-mirror/config.json << 'EOF_CONFIG'
{"accounts": ["handle1", "handle2"], "limitPerAccount": 15}
EOF_CONFIG
```

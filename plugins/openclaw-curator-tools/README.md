# OpenClaw Evogent Curator Tools

This plugin exposes Evogent's curation data layer to an OpenClaw-native curator agent.
It is shadow-mode only: `evogent.feed.submit` posts to
`/api/internal/curate/shadow`, which appends JSONL under
`data/shadow-curator-log/` and never writes to the live feed.

## Install

From the Evogent repo:

```bash
bash scripts/install-openclaw-curator-tools.sh
```

The installer registers this folder with OpenClaw:

```bash
openclaw plugins install plugins/openclaw-curator-tools
```

Restart OpenClaw after installing so the manifest and runtime entrypoint are
discovered.

## Tools

### `evogent.browse_cache.query`

Returns candidates from `browse_cache_items`.

```json
{
  "source": "twitter",
  "since": "2026-05-16T00:00:00Z",
  "limit": 100,
  "unseenFirst": true
}
```

### `evogent.preferences.match`

Scores text against Evogent's preference vector matcher.

```json
{
  "text": "A concise summary of the candidate item.",
  "limit": 5
}
```

### `evogent.feed.submit`

Accepts the same request body shape as `/api/internal/curate/submit`, but posts
to the shadow endpoint.

```json
{
  "items": [
    {
      "id": "shadow-example",
      "type": "article",
      "source": "hackernews",
      "sourceId": "123",
      "title": "Example",
      "text": "Example summary.",
      "publishedAt": "2026-05-16T12:00:00Z"
    }
  ]
}
```

### `evogent.interactions.recent`

Returns recent engagement signals joined to feed item titles and source ids.

```json
{
  "limit": 50
}
```

## Configuration

The plugin calls Evogent over HTTP. Base URL resolution:

1. `EVOGENT_INTERNAL_BASE_URL`
2. `MEDIA_AGENT_INTERNAL_BASE_URL`
3. `INTERNAL_BASE_URL`
4. `http://127.0.0.1:3001`

For cutover in a later phase, change the submit path in `index.js` from
`/api/internal/curate/shadow` to `/api/internal/curate/submit`.

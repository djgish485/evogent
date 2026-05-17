# OpenClaw Evogent Curator Tools

This plugin is the bridge from the OpenClaw curator agent to Evogent's live
feed. The curator can inspect browse-cache candidates, score text against
Evogent preferences, read recent engagement, and submit selected items with
`evogent.feed.submit`.

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

### `evogent.preferences.match`

Scores text against Evogent's preference vector matcher.

### `evogent.feed.submit`

Posts the same request body shape accepted by `/api/internal/curate/submit` and
writes accepted items into Evogent's live feed.

### `evogent.interactions.recent`

Returns recent engagement signals joined to feed item titles and source ids.

## Configuration

The plugin calls Evogent over HTTP. Base URL resolution:

1. `EVOGENT_INTERNAL_BASE_URL`
2. `MEDIA_AGENT_INTERNAL_BASE_URL`
3. `INTERNAL_BASE_URL`
4. `http://127.0.0.1:3001`

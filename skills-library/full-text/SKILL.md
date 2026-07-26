---
name: full-text
description: Experimental article full-text enrichment using fetchable source pages and current feed APIs. Use only when shallow article cards need deeper summaries and the source page can be fetched.
user-invocable: true
metadata:
  evogent:
    heartbeat-task: true
    requires:
      env: []
---
# Full Text Enrichment

Experimental, optional enrichment for shallow article cards. This skill should improve existing feed rows through current runtime APIs; it is not a source setup default and it is not a crawler.

## Configuration

If this skill is installed, it is enabled. No `config.md` toggle is required.

## Current Runtime Contract

- For an existing curator-owned feed row, use `PATCH /api/feed/<id>` with only
  changed fields such as `text`, `excerpt`, `mediaUrls`, and `metadata`. Keep
  the same row `id`, `sourceId`, `originSessionId`, `parentId`,
  `relationship`, and thread metadata.
- Cache-only candidates remain in browse cache for the hint-free runtime
  curator. An enrichment heartbeat never creates a new feed row.
- Never append to `data/feed-output.jsonl`. A failed PATCH remains a truthful
  failed enrichment receipt; it is not converted into a second write path.
- Do not create product-code suggestions, source setup items, or diagnostics unless the user explicitly asks for that follow-up.

## Heartbeat Task

Use a small bounded batch, such as the 5 most recent candidates. Prefer visible improvement over broad crawling.

1. Select candidates from current SQLite state:

   ```sql
   SELECT id, source, source_id, origin_session_id, title, url, text, excerpt, media_urls, metadata
   FROM feed
   WHERE type = 'article'
     AND COALESCE(url, '') != ''
     AND length(COALESCE(text, '')) < 1000
   ORDER BY created_at_ms DESC
   LIMIT 20;
   ```

   Skip rows whose `metadata.fullText.status` is already `enriched`, `blocked`, or `unavailable` unless the user requested a retry.

2. If feed candidates are sparse, inspect `browse_cache_items` for article-like
   cache rows with a real `url`, `title`, and metadata-only payload. Enrich the
   cache evidence in place when the cache API supports it, or leave it for the
   curator unchanged. Do not promote it into the feed.

3. For each candidate URL, fetch the canonical page with WebFetch or the available runtime browser tool. Extract:
   - body text sufficient to write a 3-5 paragraph summary without copying the article verbatim
   - author/byline when available
   - verified publish evidence from `article:published_time`, JSON-LD `datePublished`, or equivalent page metadata
   - absolute `og:image` or equivalent social image URL when available

4. For an existing feed row, PATCH the row:
   - `text`: replace title-only or one-sentence text with a grounded 3-5 paragraph summary
   - `excerpt`: short summary when helpful
   - `mediaUrls`: preserve existing URLs and append the verified OG image if missing
   - `metadata.fullText`: include `status`, `attemptedAt`, `sourceUrl`, `canonicalUrl`, `method`, and a short evidence note
   - `metadata.publishEvidence`: include verified or unavailable/uncertain evidence when known

5. If fetch fails, do not drop or overwrite the original item. For existing
   rows, PATCH only `metadata.fullText` with `status: "fetch_failed"`,
   `attemptedAt`, `sourceUrl`, and a concise reason. For cache-only candidates,
   retain the row and write a source/enrichment receipt without creating a feed
   item.

## Guardrails

- Do not paste entire articles verbatim; summarize key points.
- Do not invent publish dates. If source-owned publish time is unavailable, set `metadata.publishEvidence.status` to `"unavailable"` or `"uncertain"` and explain why.
- Do not remove origin/session/thread metadata. PATCH metadata is merged, so send only the `fullText` and `publishEvidence` additions you intend to add.
- Do not bypass dedup by changing `sourceId` on an existing article. Existing
  curator-owned rows are enriched with PATCH; new material stays in browse
  cache until the runtime curator judges it.
- Do not add browser-auth heuristics, site-specific scraping code, or cookie repair logic. Use existing runtime browser/session tools and surface limitations.
- If fetch fails, keep the original candidate and mark the failure in metadata or candidate audit.
- Prefer primary sources over rewritten aggregations.

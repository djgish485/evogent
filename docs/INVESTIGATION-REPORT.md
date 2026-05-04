# Browser Enrichment Investigation Report

## Rounds

### Round 1

Prompt:

```text
You are a READ-ONLY investigation agent working in /root/evogent-worktrees/fix-browser-enrichment-efficiency. Read through the browser CLI and enrichment pipeline code. Investigate for efficiency and reliability issues. Look at how data flows from browser capture to cache storage to enrichment. Check for data loss, redundant operations, broken code paths, and failure modes. Focus on concrete code paths in scripts/x-browser/cli.ts, scripts/x-browser/core.ts, src/lib/tweet-cache.ts, src/lib/twitter-cli.ts, scripts/intake-enrich.ts, src/lib/enrich-tweet.ts, src/app/api/feed/[id]/enrich/route.ts, and the tweet_cache_items schema. DO NOT make any code changes. DO NOT create, modify, or delete files. Report findings only, with file references and enough detail to justify each issue.
```

Key findings returned:
- `scripts/intake-enrich.ts` bypasses `src/lib/twitter-cli.ts` and shells out directly to Bird.
- Browser scraping reopens fresh CDP/page sessions for each scrape call.
- Several extra cache/query inefficiencies and duplicated parsing utilities.

### Round 2

Prompt:

```text
You are a READ-ONLY investigation agent working in /root/evogent-worktrees/fix-browser-enrichment-efficiency. Investigate the exact data contract mismatch between browser capture and cache storage. Compare what scripts/x-browser/core.ts returns per tweet against what src/lib/tweet-cache.ts persists into tweet_cache_items during refresh, then compare that against what scripts/intake-enrich.ts and src/lib/enrich-tweet.ts fetch again later. Focus on concrete fields, dropped structure, and duplicate work caused by missing stored data. DO NOT make any code changes. DO NOT create, modify, or delete files. Report findings only, with file references and specific examples of fields that are captured, stored, omitted, and re-fetched.
```

Key findings returned:
- Browser capture produces rich tweet objects, including `_raw`, quote data, rich media, `viewCount`, and URL entity/link-card inputs.
- Cache refresh persists a much thinner row shape.
- Enrichment re-fetches the same tweet again through Bird to reconstruct data that the browser already had.

### Round 3

Prompt:

```text
You are a READ-ONLY investigation agent working in /root/evogent-worktrees/fix-browser-enrichment-efficiency. Investigate the browser command architecture around status-detail scraping and the enrichment call path. Examine how read, replies, and thread commands navigate or load pages in scripts/x-browser/core.ts and scripts/x-browser/cli.ts, and examine how enrichment chooses between browser and Bird in scripts/intake-enrich.ts, src/lib/enrich-tweet.ts, and src/lib/twitter-cli.ts. Look for repeated page loads to the same resource, unnecessary command fan-out, and broken provider/routing behavior. DO NOT make any code changes. DO NOT create, modify, or delete files. Report findings only, with file references and concrete explanations.
```

Key findings returned:
- `read`, `replies`, and `thread` each navigate to the same status URL separately.
- Intake enrichment fans out into multiple Bird calls per tweet.
- The provider bypass was confirmed again from the command-routing angle.

## Known Issues Coverage

| Known issue | First discovered in | Exact prompt that led to discovery | Notes |
| --- | --- | --- | --- |
| 1. Browser capture is rich, cache refresh stores thin rows, then enrichment re-fetches rich data again | Round 2 | `Investigate the exact data contract mismatch between browser capture and cache storage... Focus on concrete fields, dropped structure, and duplicate work caused by missing stored data.` | Round 2 explicitly described the flow as browser capture with “everything” -> lossy cache insert -> later Bird re-fetch during enrichment. |
| 2. Cache storage drops `quotedTweet`, full media objects, `mediaTypes`, `viewCount`, `urlEntities`, `linkCard`, `_raw` | Round 2 | `Investigate the exact data contract mismatch between browser capture and cache storage... Focus on concrete fields, dropped structure, and duplicate work caused by missing stored data.` | Round 2 listed the dropped fields directly, including `_raw`, `quotedTweet`, `viewCount`, rich media structure, URL entities, and link-card/article data. |
| 3. Enrichment makes redundant Bird CLI calls (`runBirdTweet`, `runBirdReplies`, `runBirdThread`) for data the browser already captured | Round 2 | `Investigate the exact data contract mismatch between browser capture and cache storage... then compare that against what scripts/intake-enrich.ts and src/lib/enrich-tweet.ts fetch again later.` | Round 2 established the re-fetch redundancy; Round 3 reinforced it with the specific per-tweet Bird command fan-out. |
| 4. Enrichment is broken because it bypasses the browser provider | Round 1 | `Read through the browser CLI and enrichment pipeline code... Check for data loss, redundant operations, broken code paths, and failure modes.` | Round 1 identified that `scripts/intake-enrich.ts` hardcodes Bird and does not route through `runTwitterCommand`. Round 3 independently confirmed it. |
| 5. Browser `read` / `replies` / `thread` make three separate page loads to the same status URL | Round 3 | `Investigate the browser command architecture around status-detail scraping... Look for repeated page loads to the same resource...` | Round 3 directly called out the triple navigation to `buildStatusUrl(target)` through separate command paths. |

## Bonus Discoveries

These were reported by the sub-agents and were not part of the original five-item checklist:

- Large duplicated raw-tweet parsing logic exists across `scripts/x-browser/core.ts`, `src/lib/enrich-tweet.ts`, and `scripts/intake-enrich.ts`.
- `queryTweetCache()` does cleanup/reconciliation work on every query and also loads/scans the full active cache set in memory.
- Cache upsert flow re-selects each row after insert/update, adding one extra SQL read per candidate.
- Browser scrape helpers reconnect to CDP and open a fresh page for each scrape operation.
- `twitter-cli.ts` `auto` routing can still incur avoidable browser failure latency before Bird fallback when command shapes differ.

## Assessment

It took 3 rounds to get clean coverage of all 5 known issues.

What worked best:
- The general prompt was good at surfacing architecture and reliability problems, especially the provider bypass.
- The most effective refinement was not “find this bug,” but “compare captured fields vs stored fields vs later re-fetches.” That prompt exposed issues 1, 2, and 3 quickly.
- The final prompt worked because it focused on a code area and interaction pattern: status-detail command flow. That was enough to surface the triple page-load inefficiency without naming the answer.

What did not work as well:
- Broad prompts produced useful findings, but they underemphasized the exact data-loss boundary and the specific browser command duplication.
- Getting the browser inefficiency required explicitly steering the sub-agent toward `read` / `replies` / `thread` navigation behavior.

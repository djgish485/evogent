Feed enrichment fixtures live in `src/lib/feed-enrichment.test.ts` as executable cases.
Keep new cache/reference regressions there so the cache payload, accepted feed row,
and expected sibling rows stay together.

The `parity/` corpus is different: it is a committed checkpoint generated from
historical `data/feed-output.jsonl` rows joined to `browse_cache_items` on
2026-05-02. Do not regenerate it during CI. Update it manually only when the
cache extractor's intended output shape changes.

Run deterministic intake enrichment for recent feed items.

Usage: /intake-enrich

```bash
ROOT_DIR="${MEDIA_AGENT_ROOT:-$(pwd)}"
npx tsx "$ROOT_DIR/scripts/intake-enrich.ts"
```

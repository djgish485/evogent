#!/data/data/com.termux/files/usr/bin/env python3
# Retro-fix quote tweets already in the feed/cache that shipped as mashed text ("... Quoting
# @handle: ...") with no structured quotedTweet, so the card renders a proper quote sub-card
# instead of a run-on string. The quoted author + text were captured at browse time (they're in
# the cleaned text); this pulls them into metadata.quotedTweet and trims the main text to the
# tweeter's own words. Network-free, fast, safe to run every cycle. Rows that already carry a
# quotedTweet (e.g. richer syndication data) are left alone. Go-forward, browse-x-scrape emits
# the structured quote at capture, so this only ever has legacy rows to fix.
import json, os, sqlite3, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tweet_clean import extract_quote

db = sqlite3.connect(os.path.expanduser('~/evogent/data/media-agent.db'))
db.row_factory = sqlite3.Row
feed_fixed = cache_fixed = 0

# Feed rows: structured quote goes into metadata.quotedTweet; main text trimmed to own words.
for r in db.execute("""
        SELECT id, text, metadata FROM feed
        WHERE type='tweet' AND (text LIKE '%Quoting @%' OR text LIKE '%Quoted @%' OR text LIKE '%Quoted. %')
          AND (metadata IS NULL OR metadata NOT LIKE '%quotedTweet%')""").fetchall():
    own, quoted = extract_quote(r['text'] or '')
    if not quoted:
        continue
    try:
        meta = json.loads(r['metadata'] or '{}')
    except Exception:
        meta = {}
    meta['quotedTweet'] = quoted
    new_text = own if len(own) >= 3 else (r['text'] or '')
    db.execute('UPDATE feed SET text=?, metadata=? WHERE id=?',
               (new_text, json.dumps(meta, ensure_ascii=False), r['id']))
    feed_fixed += 1

# Cache payloads: so a re-promote carries the structured quote too.
for r in db.execute("""
        SELECT source_id, payload_json FROM browse_cache_items
        WHERE source='twitter'
          AND (payload_json LIKE '%Quoting @%' OR payload_json LIKE '%Quoted @%' OR payload_json LIKE '%Quoted. %')
          AND payload_json NOT LIKE '%quotedTweet%'""").fetchall():
    try:
        p = json.loads(r['payload_json'] or '{}')
    except Exception:
        continue
    own, quoted = extract_quote(p.get('text') or '')
    if not quoted:
        continue
    p['quotedTweet'] = quoted
    if len(own) >= 3:
        p['text'] = own
    db.execute('UPDATE browse_cache_items SET payload_json=? WHERE source_id=?',
               (json.dumps(p, ensure_ascii=False), r['source_id']))
    cache_fixed += 1

db.commit()
print(f"backfill-quote-tweets: {feed_fixed} feed rows, {cache_fixed} cache rows given structured quotes")

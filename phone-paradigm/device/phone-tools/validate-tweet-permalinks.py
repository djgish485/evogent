#!/data/data/com.termux/files/usr/bin/env python3
# Ground-truth validator for tweet permalinks, in BOTH the feed and the browse-cache. Device-side
# id capture attributes tweets by tap timing and sometimes stamped a card with another tweet's id
# (or a deleted one). This checks every /status/ id against X's public syndication CDN and, when the
# id's real author != the row's author (or the id is dead), strips it from the feed row AND the
# cache payload — so re-promotion / carry-forward can't re-poison the feed with the wrong link.
# Reassigns a stripped id to the row it actually belongs to when that author is present. Network
# only (no device), safe to run every cycle. This is the durable backstop for the on-glass dance.
import difflib, json, math, os, re, sqlite3, sys, urllib.request

DB = os.path.expanduser("~/evogent/data/media-agent.db")
SIM = 0.45


def synd_token(tid):
    x = (int(tid) / 1e15) * math.pi
    chars = "0123456789abcdefghijklmnopqrstuvwxyz"
    whole = int(x); s = "" if whole else "0"; n = whole
    while n:
        s = chars[n % 36] + s; n //= 36
    frac = x - whole; f = ""
    for _ in range(11):
        frac *= 36; d = int(frac); f += chars[d]; frac -= d
    return (s + f).replace("0", "").replace(".", "") or "1"


_cache = {}
def syndication(tid):
    tid = str(tid)
    if tid in _cache:
        return _cache[tid]
    url = f"https://cdn.syndication.twimg.com/tweet-result?id={tid}&token={synd_token(tid)}"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=8) as r:
            d = json.load(r)
        res = ((d.get("user") or {}).get("screen_name"), d.get("text") or "")
    except Exception:
        res = (None, None)
    _cache[tid] = res
    return res


def norm(t):
    return re.sub(r"\s+", " ", re.sub(r"https?://\S+|pic\.(?:x|twitter)\.com/\S+", "", t or "")).strip().lower()[:120]


db = sqlite3.connect(DB)
db.row_factory = sqlite3.Row

# Broken-attribution tweets: a capture that lost the author handle ships with author=null and a
# dead url like "x.com/None" — unattributable and taps to a 404. DELETE the feed row AND its
# cache row: merely clearing display order is not durable because structurally eligible
# carry-forward can restore it. The next browse can re-capture a clean copy.
broken_rows = db.execute("""
    SELECT id, source_id FROM feed
    WHERE type='tweet'
      AND ((author_username IS NULL OR author_username='' OR lower(author_username)='none')
           OR url LIKE '%/None%' OR url LIKE '%/undefined%' OR url LIKE '%/null%')
""").fetchall()
for r in broken_rows:
    db.execute("DELETE FROM interactions WHERE feed_item_id=?", (r["id"],))
    db.execute("DELETE FROM thread_feedback WHERE feed_item_id=?", (r["id"],))
    db.execute("DELETE FROM feed WHERE id=?", (r["id"],))
    if r["source_id"]:
        db.execute("DELETE FROM browse_cache_items WHERE source_id=? AND (author_username IS NULL OR author_username='')", (r["source_id"],))
if broken_rows:
    db.commit()
    print(f"  deleted {len(broken_rows)} broken-attribution tweets (feed+cache)", file=sys.stderr)

# A search-results URL is not an honest identity for one tweet. Convert lingering feed/cache
# search destinations to the author profile, the truthful fallback when no status id is known.
search_fixed = 0
for r in db.execute("SELECT id, author_username FROM feed WHERE type='tweet' AND url LIKE '%search?q=%'").fetchall():
    if r['author_username']:
        db.execute("UPDATE feed SET url=? WHERE id=?", (f"https://x.com/{r['author_username']}", r['id']))
        search_fixed += 1
for r in db.execute("SELECT source_id, author_username, payload_json FROM browse_cache_items WHERE source='twitter' AND (url LIKE '%search?q=%' OR payload_json LIKE '%search?q=%')").fetchall():
    prof = f"https://x.com/{r['author_username']}" if r['author_username'] else None
    if not prof:
        continue
    try:
        p = json.loads(r['payload_json'] or '{}')
    except Exception:
        p = None
    if p is not None and isinstance(p.get('url'), str) and 'search?q=' in p['url']:
        p['url'] = prof
    db.execute("UPDATE browse_cache_items SET url=?, payload_json=? WHERE source_id=?",
               (prof, json.dumps(p, ensure_ascii=False) if p is not None else r['payload_json'], r['source_id']))
db.commit()

# Shown tweets are the priority (that's what taps hit); include unshipped feed rows too so a later
# promote is already clean.
feed_rows = db.execute("SELECT id, author_username, text, url, source_id FROM feed WHERE type='tweet' AND url LIKE '%/status/%'").fetchall()
targets = db.execute("SELECT id, author_username, text FROM feed WHERE type='tweet' AND display_order IS NOT NULL AND (url IS NULL OR url NOT LIKE '%/status/%')").fetchall()
assigned = set()
stripped = reassigned = ok = 0


def clean_cache(source_id, author):
    c = db.execute("SELECT payload_json, url FROM browse_cache_items WHERE source_id=?", (source_id,)).fetchone()
    if not c:
        return
    try:
        p = json.loads(c["payload_json"] or "{}")
    except Exception:
        return
    p.pop("statusId", None)
    prof = f"https://x.com/{author}" if author else None
    if prof:
        p["url"] = prof
    db.execute("UPDATE browse_cache_items SET url=?, payload_json=? WHERE source_id=?",
               (prof, json.dumps(p, ensure_ascii=False), source_id))


def reassign(sid, text):
    sn, _ = syndication(sid)
    if not sn:
        return False
    best, best_sim = None, 0.0
    for row in targets:
        if row["id"] in assigned or (row["author_username"] or "").lower() != sn.lower():
            continue
        s = difflib.SequenceMatcher(None, norm(row["text"]), norm(text)).ratio()
        if s > best_sim:
            best, best_sim = row, s
    if best and best_sim >= SIM:
        url = f"https://x.com/{best['author_username']}/status/{sid}"
        db.execute("UPDATE feed SET url=? WHERE id=?", (url, best["id"]))
        assigned.add(best["id"])
        return True
    return False


for r in feed_rows:
    m = re.search(r"/status/(\d+)", r["url"] or "")
    if not m:
        continue
    sid = m.group(1)
    sn, text = syndication(sid)
    if sn and sn.lower() == (r["author_username"] or "").lower():
        ok += 1
        continue
    # Wrong author or dead id: strip from feed + cache.
    db.execute("UPDATE feed SET url=? WHERE id=?", (f"https://x.com/{r['author_username']}", r["id"]))
    clean_cache(r["source_id"], r["author_username"])
    stripped += 1
    print(f"  stripped {sid} from @{r['author_username']} (actual @{sn})", file=sys.stderr)
    if sn and reassign(sid, text):
        reassigned += 1

db.commit()
print(f"validate-permalinks: {ok} valid, {stripped} stripped (feed+cache), {reassigned} reassigned")

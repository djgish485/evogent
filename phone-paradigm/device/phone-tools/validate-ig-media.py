#!/data/data/com.termux/files/usr/bin/env python3
# Keep Instagram cards honest: strip any /api/local-media/ig/<file> reference whose crop file no
# longer exists on disk, in BOTH the feed and the browse cache. A dangling reference renders as a
# broken image; dropping it leaves a clean text card until the next browse re-captures the post.
# Network-free, fast, safe to run every cycle. (The author-matched association in browse-instagram
# prevents WRONG images at capture; this guards against MISSING ones after the fact.)
import json, os, re, sqlite3

EVO = os.path.expanduser("~/evogent")
DB = os.path.join(EVO, "data", "media-agent.db")
IG_DIR = os.path.join(EVO, "data", "media", "ig")
have = set(os.listdir(IG_DIR)) if os.path.isdir(IG_DIR) else set()


def file_of(url):
    m = re.search(r"/api/local-media/ig/(.+)$", url or "")
    return m.group(1) if m else None


def alive(urls):
    return [u for u in urls if (lambda f: f and f in have)(file_of(u))]


db = sqlite3.connect(DB)
db.row_factory = sqlite3.Row
feed_fix = cache_fix = 0

for r in db.execute("SELECT id, media_urls FROM feed WHERE source='instagram' AND media_urls IS NOT NULL AND media_urls <> '[]'").fetchall():
    try:
        arr = json.loads(r["media_urls"])
    except Exception:
        continue
    kept = alive(arr)
    if len(kept) != len(arr):
        db.execute("UPDATE feed SET media_urls=? WHERE id=?", (json.dumps(kept), r["id"]))
        feed_fix += 1

for r in db.execute("SELECT source_id, payload_json FROM browse_cache_items WHERE source='instagram' AND payload_json LIKE '%local-media%'").fetchall():
    try:
        p = json.loads(r["payload_json"])
    except Exception:
        continue
    if not isinstance(p.get("mediaUrls"), list):
        continue
    kept = alive(p["mediaUrls"])
    if len(kept) != len(p["mediaUrls"]):
        if kept:
            p["mediaUrls"] = kept
        else:
            p.pop("mediaUrls", None)
        db.execute("UPDATE browse_cache_items SET payload_json=? WHERE source_id=?", (json.dumps(p, ensure_ascii=False), r["source_id"]))
        cache_fix += 1

db.commit()
print(f"validate-ig-media: stripped dead-image refs — feed={feed_fix} cache={cache_fix}")

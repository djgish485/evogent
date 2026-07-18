#!/data/data/com.termux/files/usr/bin/env python3
# Keep Instagram cards honest, in BOTH the feed and the browse cache:
#  - strip any /api/local-media/ig/<file> reference whose crop file no longer exists on disk
#    (a dangling reference renders as a broken image; a clean text card is better until the
#    next browse re-captures the post), and
#  - repoint any card whose URL leads to a DIFFERENT account than its author (tap-through must
#    land on the card's own author — a mis-bound url sent the user to the wrong profile).
# Network-free, fast, safe to run every cycle. (The author-matched association in
# browse-instagram prevents wrong images/urls at capture; this guards rows after the fact.)
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


PROFILE_URL = re.compile(r"https?://(?:www\.)?instagram\.com/([^/?#]+)/?$")
NON_PROFILE_PATHS = {"p", "reel", "reels", "stories", "explore"}


def norm_handle(h):
    return (h or "").lstrip("@").strip().lower()


def author_consistent_url(url, author):
    """Return the url a card for `author` should carry: the original when it already leads to
    that account (or to a specific post — /p/, /reel/ permalinks are trusted), otherwise the
    author's own profile. None means leave the row alone (no author to anchor on)."""
    a = norm_handle(author)
    if not a:
        return None
    m = PROFILE_URL.match(url or "")
    if not m:
        return None  # post permalink or non-IG url — nothing to cross-check against
    h = m.group(1).lower()
    if h in NON_PROFILE_PATHS or h == a or h.startswith(a) or a.startswith(h):
        return None
    return f"https://www.instagram.com/{a}/"


db = sqlite3.connect(DB)
db.row_factory = sqlite3.Row
feed_fix = cache_fix = 0
url_fix = 0

for r in db.execute("SELECT id, author_username, url FROM feed WHERE source='instagram' AND url IS NOT NULL").fetchall():
    fixed = author_consistent_url(r["url"], r["author_username"])
    if fixed:
        db.execute("UPDATE feed SET url=? WHERE id=?", (fixed, r["id"]))
        url_fix += 1

for r in db.execute("SELECT source_id, payload_json FROM browse_cache_items WHERE source='instagram'").fetchall():
    try:
        p = json.loads(r["payload_json"])
    except Exception:
        continue
    fixed = author_consistent_url(p.get("url"), p.get("authorUsername") or p.get("author"))
    if fixed:
        p["url"] = fixed
        db.execute("UPDATE browse_cache_items SET payload_json=? WHERE source_id=?", (json.dumps(p, ensure_ascii=False), r["source_id"]))
        url_fix += 1

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
print(f"validate-ig-media: stripped dead-image refs — feed={feed_fix} cache={cache_fix}; repointed author-mismatched urls={url_fix}")

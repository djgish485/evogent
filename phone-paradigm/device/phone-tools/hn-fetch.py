#!/data/data/com.termux/files/usr/bin/env python3
# Zero-cost Hacker News source browse: no computer-use, just the public Firebase API +
# a light og:description fetch. Mirrors the VM's hackernews-cache skill. Fills browse_cache
# source=hackernews so the curator can include HN like any other source.
import json, time, urllib.request, urllib.error, re, html
from evogent_api import ORIGIN as BASE, post_json

HN = "https://hacker-news.firebaseio.com/v0"
NOW = int(time.time() * 1000)
TTL = 14 * 24 * 60 * 60 * 1000

def get(url, timeout=8):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 Evogent"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", "replace")

def og_desc(url):
    try:
        h = get(url, timeout=5)[:200000]
        m = re.search(r'<meta[^>]+property=["\']og:description["\'][^>]+content=["\']([^"\']+)', h, re.I) \
            or re.search(r'<meta[^>]+name=["\']description["\'][^>]+content=["\']([^"\']+)', h, re.I)
        return html.unescape(m.group(1)).strip()[:600] if m else ""
    except Exception:
        return ""

# Volume matters: the curator picks from the pool, so cache broadly and let taste filter.
# top+best+new gives ~150 distinct candidates per run (the score gate below still applies).
ids = []
list_successes = 0
for lst in ("beststories", "topstories", "newstories"):
    try:
        ids += json.loads(get(f"{HN}/{lst}.json"))[:80]
        list_successes += 1
    except Exception as e:
        print("list err", lst, e)
seen, items = set(), []
for hid in ids:
    if hid in seen or len(items) >= 150:
        continue
    seen.add(hid)
    try:
        it = json.loads(get(f"{HN}/item/{hid}.json"))
    except Exception:
        continue
    if not it or it.get("type") != "story" or it.get("dead") or it.get("deleted"):
        continue
    score = it.get("score", 0)
    if score < 10:  # rubric: skip low-engagement HN
        continue
    title = it.get("title", "").strip()
    url = it.get("url") or f"https://news.ycombinator.com/item?id={hid}"
    discussion = f"https://news.ycombinator.com/item?id={hid}"
    # og:description fetches cost 1-5s each; cap them so 150 stories don't take 10 minutes.
    # Rows beyond the cap still cache (title/score/URL) — the curator can use them; only the
    # deterministic floor requires a synopsis, and it feeds on the freshest (earliest) rows.
    syn = og_desc(it["url"]) if (it.get("url") and len(items) < 60) else ""
    payload = {"type": "hackernews", "title": title, "url": url, "canonicalUrl": url,
               "discussionUrl": discussion, "score": score, "by": it.get("by"),
               "commentCount": it.get("descendants", 0),
               "linkedArticleSynopsis": syn, "captureMethod": "phone-hn-api"}
    items.append({"sourceId": f"hn-{hid}", "url": url, "title": title,
                  "publishedAtMs": (it.get("time", 0) * 1000) or NOW,
                  "payload": payload, "fetchedAtMs": NOW, "expiresAtMs": NOW + TTL})

status = "completed" if list_successes > 0 else "failed"
error = None if list_successes > 0 else "all Hacker News list requests failed"
metadata = None
if list_successes > 0 and not items:
    metadata = {
        "outcomeEvidence": {
            "provenEmpty": True,
            "evidence": f"{list_successes} HN lists fetched successfully; no score>=10 stories",
        },
    }
body = {"source": "hackernews", "triggeredBy": "phone-hn-api", "startedAtMs": NOW,
        "completedAtMs": int(time.time()*1000), "status": status, "error": error,
        "itemsAdded": len(items), "items": items}
if metadata:
    body["metadata"] = metadata
try:
    r = post_json(f"{BASE}/api/internal/browse-cache/submit", json.dumps(body).encode(), timeout=20)
    print(f"CACHED {len(items)} HN stories; resp {r.status}")
except Exception as e:
    print("SUBMIT_ERR", e, "items", len(items))
    raise SystemExit(1)
if status != "completed":
    raise SystemExit(1)

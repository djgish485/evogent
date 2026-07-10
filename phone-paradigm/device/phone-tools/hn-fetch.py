#!/data/data/com.termux/files/usr/bin/env python3
# Zero-cost Hacker News source browse: no computer-use, just the public Firebase API +
# a light og:description fetch. Mirrors the VM's hackernews-cache skill. Fills browse_cache
# source=hackernews so the curator can include HN like any other source.
import json, time, urllib.request, urllib.error, re, html

BASE = "http://127.0.0.1:3001"
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

ids = []
for lst in ("beststories", "topstories"):
    try:
        ids += json.loads(get(f"{HN}/{lst}.json"))[:40]
    except Exception as e:
        print("list err", lst, e)
seen, items = set(), []
for hid in ids:
    if hid in seen or len(items) >= 45:
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
    syn = og_desc(it["url"]) if it.get("url") else ""
    payload = {"type": "hackernews", "title": title, "url": url, "canonicalUrl": url,
               "discussionUrl": discussion, "score": score, "by": it.get("by"),
               "commentCount": it.get("descendants", 0),
               "linkedArticleSynopsis": syn, "captureMethod": "phone-hn-api"}
    items.append({"sourceId": f"hn-{hid}", "url": url, "title": title,
                  "publishedAtMs": (it.get("time", 0) * 1000) or NOW,
                  "payload": payload, "fetchedAtMs": NOW, "expiresAtMs": NOW + TTL})

body = {"source": "hackernews", "triggeredBy": "phone-hn-api", "startedAtMs": NOW,
        "completedAtMs": int(time.time()*1000), "status": "completed",
        "itemsAdded": len(items), "items": items}
req = urllib.request.Request(f"{BASE}/api/internal/browse-cache/submit",
        data=json.dumps(body).encode(), headers={"content-type": "application/json"})
try:
    r = urllib.request.urlopen(req, timeout=20)
    print(f"CACHED {len(items)} HN stories; resp {r.status}")
except Exception as e:
    print("SUBMIT_ERR", e, "items", len(items))

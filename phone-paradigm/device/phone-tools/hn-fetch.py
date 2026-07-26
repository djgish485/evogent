#!/data/data/com.termux/files/usr/bin/env python3
# Hacker News source browse: no computer-use, just the public Firebase API plus a bounded
# og:description fetch. Mechanics collect live stories; the runtime agent alone decides which
# are worth shipping. Popularity is retained as evidence, never used as an eligibility gate.
import html
import json
import re
import time
import urllib.error
import urllib.request

from evogent_api import ORIGIN as BASE, post_json
from public_http import fetch_public_text

HN = "https://hacker-news.firebaseio.com/v0"
TTL = 14 * 24 * 60 * 60 * 1000
HN_LISTS = ("beststories", "topstories", "newstories")
PER_LIST_LIMIT = 80
MAX_ITEMS = 150
MAX_SYNOPSIS_FETCHES = 60

def get(url, timeout=8):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 Evogent"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", "replace")

def get_json(url):
    return json.loads(get(url))

def og_desc(url):
    try:
        h = fetch_public_text(
            url,
            headers={"User-Agent": "Mozilla/5.0 Evogent"},
            timeout=5,
            max_bytes=200_000,
            max_redirects=4,
        )
        m = re.search(r'<meta[^>]+property=["\']og:description["\'][^>]+content=["\']([^"\']+)', h, re.I) \
            or re.search(r'<meta[^>]+name=["\']description["\'][^>]+content=["\']([^"\']+)', h, re.I)
        return html.unescape(m.group(1)).strip()[:600] if m else ""
    except Exception:
        return ""

def collect_hn_items(fetch_json=get_json, fetch_synopsis=og_desc, now_ms=None):
    """Collect structurally eligible stories without making an editorial popularity decision."""
    now_ms = int(time.time() * 1000) if now_ms is None else int(now_ms)
    ids = []
    list_successes = 0
    list_failures = 0
    item_fetch_failures = 0

    for list_name in HN_LISTS:
        try:
            listed_ids = fetch_json(f"{HN}/{list_name}.json")
            if not isinstance(listed_ids, list):
                raise ValueError("list response was not an array")
            ids.extend(listed_ids[:PER_LIST_LIMIT])
            list_successes += 1
        except Exception as error:
            list_failures += 1
            print("list err", list_name, error)

    seen = set()
    items = []
    for hid in ids:
        if hid in seen or len(items) >= MAX_ITEMS:
            continue
        seen.add(hid)
        try:
            story = fetch_json(f"{HN}/item/{hid}.json")
        except Exception:
            item_fetch_failures += 1
            continue
        if (
            not isinstance(story, dict)
            or story.get("type") != "story"
            or story.get("dead")
            or story.get("deleted")
        ):
            continue

        title = str(story.get("title") or "").strip()
        if not title:
            continue
        url = story.get("url") or f"https://news.ycombinator.com/item?id={hid}"
        discussion = f"https://news.ycombinator.com/item?id={hid}"
        # Fetching article descriptions is a bounded completeness aid. It never determines
        # whether a story enters the cache; rows beyond the cap still reach agent judgment.
        synopsis = (
            fetch_synopsis(story["url"])
            if story.get("url") and len(items) < MAX_SYNOPSIS_FETCHES
            else ""
        )
        payload = {
            "type": "hackernews",
            "title": title,
            "url": url,
            "canonicalUrl": url,
            "discussionUrl": discussion,
            "score": story.get("score", 0),
            "by": story.get("by"),
            "commentCount": story.get("descendants", 0),
            "linkedArticleSynopsis": synopsis,
            "captureMethod": "phone-hn-api",
        }
        items.append({
            "sourceId": f"hn-{hid}",
            "url": url,
            "title": title,
            "publishedAtMs": (story.get("time", 0) * 1000) or now_ms,
            "payload": payload,
            "fetchedAtMs": now_ms,
            "expiresAtMs": now_ms + TTL,
        })

    return items, {
        "listSuccesses": list_successes,
        "listFailures": list_failures,
        "itemFetchFailures": item_fetch_failures,
        "candidateIds": len(seen),
    }


def build_refresh_body(items, retrieval, started_at_ms, completed_at_ms=None):
    """Build a truthful terminal receipt; partial retrieval is a failure even if rows survived."""
    completed_at_ms = int(time.time() * 1000) if completed_at_ms is None else int(completed_at_ms)
    complete_retrieval = (
        retrieval["listSuccesses"] == len(HN_LISTS)
        and retrieval["listFailures"] == 0
        and retrieval["itemFetchFailures"] == 0
    )
    status = "completed" if complete_retrieval else "failed"
    error = None
    if not complete_retrieval:
        error = (
            "partial Hacker News retrieval: "
            f"{retrieval['listFailures']} list request failures, "
            f"{retrieval['itemFetchFailures']} item request failures"
        )

    metadata = {"retrieval": retrieval}
    if complete_retrieval and not items:
        metadata["outcomeEvidence"] = {
            "provenEmpty": True,
            "evidence": (
                f"all {len(HN_LISTS)} configured HN lists and their bounded item records "
                "were fetched; no live story records were present"
            ),
        }

    return {
        "source": "hackernews",
        "triggeredBy": "phone-hn-api",
        "startedAtMs": int(started_at_ms),
        "completedAtMs": completed_at_ms,
        "status": status,
        "error": error,
        "itemsAdded": len(items),
        "items": items,
        "metadata": metadata,
    }


def main():
    started_at_ms = int(time.time() * 1000)
    items, retrieval = collect_hn_items(now_ms=started_at_ms)
    body = build_refresh_body(items, retrieval, started_at_ms)
    try:
        response = post_json(
            f"{BASE}/api/internal/browse-cache/submit",
            json.dumps(body).encode(),
            timeout=20,
        )
        print(f"CACHED {len(items)} HN stories; resp {response.status}")
    except Exception as error:
        print("SUBMIT_ERR", error, "items", len(items))
        return 1
    return 0 if body["status"] == "completed" else 1


if __name__ == "__main__":
    raise SystemExit(main())

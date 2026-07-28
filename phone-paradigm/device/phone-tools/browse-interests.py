#!/data/data/com.termux/files/usr/bin/env python3
# Standing-interest browser. Turns "keep me updated on X" into a real source pull: for each DUE
# interest in data/interests.jsonl (per-interest cadenceHours, default 24h — most venues post
# daily at most, so per-cycle pulls would be waste), gather that interest's sources and extract
# UPCOMING events with one bounded vision+text model pass:
#   - website/events/calendar/facebook sources -> anonymous web fetch (facebook.com/<page>/events
#     serves logged-out; m.facebook does not)
#   - instagram sources -> the ENTITY'S PROFILE in the real logged-in IG app on a hidden display:
#     deep-link the profile, screenshot the grid, open the newest posts and screenshot each. The
#     screenshots go to the model as IMAGES — event flyers, captions, dates are read from pixels,
#     which generalizes to any app/layout without per-app parsers (a11y taps don't fire IG's
#     custom views; grid geometry is derived live from the tab-bar bounds, nothing hardcoded).
# Extracted events are cached as source="events" cards (today-or-later only, re-cached while
# upcoming so the agent-judged freshness fallback can keep them alive until they happen).
# Fully general: nothing per-venue/per-user in code — everything flows from interests.jsonl.
import hashlib, json, os, re, shlex, subprocess, sys, time, urllib.request
sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
from evogent_api import ORIGIN as BASE, post_json
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
from interest_browse_runtime import (
    apply_submit_result,
    atomic_write_json,
    classify_interest_outcomes,
    derive_instagram_geometry,
    png_dimensions,
)
from shotnode_rect import shotnode_rect

EVO = os.path.expanduser("~/evogent")
TOOLS = os.path.expanduser("~/phone-tools")
PHONE = f"{TOOLS}/phone.sh"
RISH = os.path.expanduser("~/rish-bin/rish")
INTERESTS = os.path.join(EVO, "data", "interests.jsonl")
STATE = os.path.join(EVO, "data", ".interest-browse-state.json")
IN_FILE = os.path.join(EVO, "data", ".interest-input.json")
OUT_FILE = os.path.join(EVO, "data", ".interest-events.json")
OUTCOMES_FILE = os.path.join(EVO, "data", "interest-browse-outcomes.json")
SHOT_DIR = os.path.join(EVO, "data", ".interest-shots")
NOW = int(time.time() * 1000)
TODAY = datetime.now(timezone.utc).strftime("%Y-%m-%d")
TTL_DAYS = 21
FORCE = "--force" in sys.argv
MAX_IG_HANDLES = 3
SHOTS_PER_HANDLE = 3


def sh(*args, timeout=60):
    try:
        return subprocess.run(["bash", PHONE, *args], capture_output=True, text=True, timeout=timeout).stdout
    except Exception as e:
        print(f"phone.sh {args} failed: {e}", file=sys.stderr)
        return ""


def rish(cmd, timeout=25):
    try:
        env = dict(os.environ, RISH_APPLICATION_ID="com.termux")
        return subprocess.run([RISH, "-c", cmd], capture_output=True, text=True, timeout=timeout, env=env).stdout
    except Exception as e:
        print(f"rish failed: {e}", file=sys.stderr)
        return ""


def cfg(key, default):
    try:
        lines = open(os.path.join(EVO, "data", "config.md")).read().splitlines()
        for i, l in enumerate(lines):
            if l.strip().lower() == f"## {key}".lower():
                for j in range(i + 1, min(i + 4, len(lines))):
                    if lines[j].strip():
                        return lines[j].strip()
    except Exception:
        pass
    return default


BROWSE_MODEL = os.environ.get("EVOGENT_BROWSE_MODEL") or cfg("Browse Model", "gpt-5.6-terra")
BROWSE_EFFORT = os.environ.get("EVOGENT_BROWSE_REASONING", "low")


def fetch_text(url, cap=6000):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (X11; Linux x86_64)"})
    html = urllib.request.urlopen(req, timeout=15).read().decode("utf-8", "ignore")
    html = re.sub(r"<(script|style|noscript)[^>]*>.*?</\1>", " ", html, flags=re.S | re.I)
    text = re.sub(r"<[^>]+>", " ", html)
    text = re.sub(r"&[a-z#0-9]+;", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text[:cap]


def load_interests():
    out = []
    if os.path.exists(INTERESTS):
        for line in open(INTERESTS):
            line = line.strip()
            if line:
                try:
                    out.append(json.loads(line))
                except Exception:
                    pass
    return out


def load_state():
    try:
        return json.load(open(STATE))
    except Exception:
        return {}


def browse_app_page(pkg, deep_link, label, shots_dir, launched_state):
    """Generic app page vision-browse: open a deep link in the given LOGGED-IN app on a hidden
    display and screenshot what renders (plus one scroll). No per-app parsing — the extraction
    model reads the pixels. Used for Facebook pages; the same pattern serves any future app
    source. (Uses its own launched-state key per package.)"""
    shots = []
    key = f"display:{pkg}"
    if not launched_state.get(key):
        out = sh("launch", pkg, timeout=60)
        m = re.search(r"hidden display (\d+)", out)
        if not m:
            print(f"{pkg} launch failed: {out.strip()}", file=sys.stderr)
            return shots, None
        launched_state[key] = m.group(1)
    d = launched_state[key]
    safe = re.sub(r"[^A-Za-z0-9_-]", "_", label)[:40]
    rish(
        f"am start --display {d} -a android.intent.action.VIEW "
        f"-d {shlex.quote(deep_link)} {shlex.quote(pkg)} >/dev/null 2>&1"
    )
    time.sleep(6)
    for i, scroll in enumerate([False, True]):
        if scroll:
            sh("swipe-rel", "500", "667", "500", "292", "300", d)
            time.sleep(2.5)
        p = os.path.join(shots_dir, f"{safe}-{pkg.split('.')[-1]}-{i}.png")
        sh("shot", p, d)
        if os.path.exists(p) and os.path.getsize(p) > 5000:
            shots.append(p)
    return shots, d


def browse_ig_profile(handle, shots_dir, launched):
    """Deep-link the entity's IG profile on a hidden display; screenshot the grid and the newest
    posts. Returns (shot paths, display id, anomaly). Taps use geometry derived from a live
    screenshot plus the live tab-bar bounds (a11y ACTION_CLICK doesn't fire IG custom views).
    A missing/implausible anchor is an ordinary mechanics anomaly, never a blind tap."""
    shots = []
    if not launched["display"]:
        out = sh("launch", "com.instagram.android", timeout=60)
        m = re.search(r"hidden display (\d+)", out)
        if not m:
            print(f"ig launch failed: {out.strip()}", file=sys.stderr)
            return shots, None, "instagram_launch_failed"
        launched["display"] = m.group(1)
    d = launched["display"]
    profile_url = f"https://www.instagram.com/{handle}/"
    rish(
        f"am start --display {d} -a android.intent.action.VIEW "
        f"-d {shlex.quote(profile_url)} com.instagram.android >/dev/null 2>&1"
    )
    time.sleep(5)
    geometry_shot = os.path.join(shots_dir, f"{handle}-geometry.png")
    sh("shot", geometry_shot, d)
    dimensions = png_dimensions(geometry_shot)
    if not dimensions:
        print(f"instagram {handle}: live screenshot geometry unavailable", file=sys.stderr)
        return shots, d, "instagram_screenshot_geometry_unavailable"
    width, height = dimensions
    # Bring the profile's grid row into view using this display's measured dimensions.
    sh(
        "swipe",
        str(round(width * 0.50)),
        str(round(height * 0.68)),
        str(round(width * 0.50)),
        str(round(height * 0.34)),
        "300",
        d,
    )
    time.sleep(2)
    grid_shot = os.path.join(shots_dir, f"{handle}-grid.png")
    sh("shot", grid_shot, d)
    if os.path.exists(grid_shot) and os.path.getsize(grid_shot) > 5000:
        shots.append(grid_shot)
    # Grid geometry from accessible profile chrome directly above the custom tile grid.
    rect = None
    for anchor in ("Photos of you", "Reels", "Posts"):
        rect = shotnode_rect(d, anchor, f"igtab-{handle}-{anchor.lower().replace(' ', '-')}")
        if rect:
            break
    geometry = derive_instagram_geometry(width, height, rect) if rect else None
    if not geometry:
        print(
            f"instagram {handle}: profile-grid anchor missing/implausible on {width}x{height}",
            file=sys.stderr,
        )
        return shots, d, "instagram_grid_geometry_unavailable"
    cx, cy = geometry["firstTile"]
    sh("swipe", str(cx), str(cy), str(cx), str(cy + 1), "120", d)
    time.sleep(3)
    sx, sy, ex, ey = geometry["nextPostSwipe"]
    for i in range(1, SHOTS_PER_HANDLE):
        p = os.path.join(shots_dir, f"{handle}-post{i}.png")
        sh("shot", p, d)
        if os.path.exists(p) and os.path.getsize(p) > 5000:
            shots.append(p)
        sh("swipe", str(sx), str(sy), str(ex), str(ey), "300", d)
        time.sleep(2.5)
    return shots, d, None


interests = [
    i for i in load_interests()
    if isinstance(i, dict)
    and i.get("status", "active") == "active"
    and str(i.get("id") or "").strip()
]
state = load_state()
due = []
for it in interests:
    cadence_ms = max(1, int(it.get("cadenceHours", 24))) * 3600 * 1000
    last = int(state.get(it["id"], 0))
    if FORCE or NOW - last >= cadence_ms:
        due.append(it)
if not due:
    atomic_write_json(
        OUTCOMES_FILE,
        {
            "version": 1,
            "startedAtMs": NOW,
            "completedAtMs": int(time.time() * 1000),
            "submitPersisted": None,
            "submitError": None,
            "status": "not_due",
            "outcomes": [],
        },
    )
    print(f"browse-interests: {len(interests)} active, none due (cadence)")
    sys.exit(0)

tracking = {
    it["id"]: {
        "interestId": it["id"],
        "attemptedSources": 0,
        "evidenceCount": 0,
        "itemsAdded": 0,
        "errors": [],
        "anomalies": [],
    }
    for it in due
}


def record_error(interest_id, error, *, anomaly=False):
    bucket = "anomalies" if anomaly else "errors"
    tracking[interest_id][bucket].append(str(error)[:160])


os.makedirs(SHOT_DIR, exist_ok=True)
blocks, all_shots = [], []
launched = {"display": None}
ig_handles_done = 0
for it in due:
    iid = it["id"]
    for ent in it.get("entities", []):
        if not isinstance(ent, dict):
            continue
        entity_name = str(ent.get("name") or "").strip()
        for src in ent.get("sources", []):
            if not isinstance(src, dict):
                continue
            stype = str(src.get("type") or "").strip().lower()
            url = str(src.get("url") or "").strip() or None
            handle = str(src.get("handle") or "").strip().lstrip("@")
            if stype in ("website", "events", "calendar") and url:
                tracking[iid]["attemptedSources"] += 1
                try:
                    text = fetch_text(url)
                    if text:
                        blocks.append({"interestId": iid, "entity": entity_name, "url": url, "text": text})
                        tracking[iid]["evidenceCount"] += 1
                    else:
                        record_error(iid, f"{stype}_empty_response")
                except Exception as error:
                    record_error(iid, f"{stype}_fetch_failed:{type(error).__name__}")
                    print(f"fetch {url}: {error}", file=sys.stderr)
            elif stype == "facebook":
                fb = url or (f"https://www.facebook.com/{handle}/events" if handle else None)
                if not fb:
                    record_error(iid, "facebook_source_missing_target")
                    continue
                tracking[iid]["attemptedSources"] += 1
                if "facebook.com" in fb and "/events" not in fb:
                    fb = fb.rstrip("/") + "/events"
                # Anonymous facebook.com is a JS shell, so prefer the logged-in app and use
                # anonymous fetch only when the app is absent.
                if rish("pm list packages com.facebook.katana").strip():
                    shots, _ = browse_app_page(
                        "com.facebook.katana", fb, entity_name, SHOT_DIR, launched
                    )
                    if shots:
                        all_shots.extend([(iid, entity_name, "facebook", p) for p in shots])
                        tracking[iid]["evidenceCount"] += len(shots)
                    else:
                        record_error(iid, "facebook_app_capture_failed")
                else:
                    try:
                        text = fetch_text(fb)
                        if text:
                            blocks.append(
                                {"interestId": iid, "entity": entity_name, "url": fb, "text": text}
                            )
                            tracking[iid]["evidenceCount"] += 1
                        else:
                            record_error(iid, "facebook_empty_response")
                    except Exception as error:
                        record_error(iid, f"facebook_fetch_failed:{type(error).__name__}")
                        print(f"fetch {fb}: {error}", file=sys.stderr)
            elif stype == "instagram" and handle:
                tracking[iid]["attemptedSources"] += 1
                if not re.fullmatch(r"[A-Za-z0-9._]{1,64}", handle):
                    record_error(iid, "instagram_handle_invalid")
                    continue
                if ig_handles_done >= MAX_IG_HANDLES:
                    record_error(iid, "instagram_run_budget_exhausted")
                    continue
                shots, _, anomaly = browse_ig_profile(handle, SHOT_DIR, launched)
                if shots:
                    all_shots.extend([(iid, entity_name, handle, p) for p in shots])
                    tracking[iid]["evidenceCount"] += len(shots)
                    ig_handles_done += 1
                if anomaly:
                    record_error(iid, anomaly, anomaly=True)
                if not shots and not anomaly:
                    record_error(iid, "instagram_capture_failed")

if launched.get("display"):
    sh("stop", "com.instagram.android")
for key in list(launched):
    if key.startswith("display:"):
        sh("stop", key.split(":", 1)[1])

atomic_write_json(IN_FILE, blocks)

extraction_ok = False
extraction_error = ""
events = []
if blocks or all_shots:
    shot_manifest = "\n".join(
        f"- image {os.path.basename(path)}: app screenshot for {entity} "
        f"(interestId {iid}, {handle})"
        for (iid, entity, handle, path) in all_shots
    )
    prompt = f"""You are extracting UPCOMING EVENTS for topics a user asked to follow. Today is {TODAY}.

Inputs:
1. {IN_FILE} — JSON array of fetched web/facebook page texts: {{interestId, entity, url, text}}.
2. The attached screenshots (if any) are Instagram profile grids and posts:
{shot_manifest or '(none)'}

From BOTH the page texts and the screenshots (read flyers, captions, pinned announcements, dates
in images), extract real scheduled happenings a person could attend or act on: openings, drops,
film premieres, classes, workshops, live sessions, markets, guest events; expand a recurring
series to its next occurrence. IGNORE navigation, products, generic marketing, past events.

Write ONLY a JSON array to {OUT_FILE} (no prose), each element:
{{"interestId": "...", "entity": "...", "title": "...", "date": "YYYY-MM-DD" (>= {TODAY}; best
estimate), "time": "..." or "", "location": "...", "url": "..." (most specific link, else the
source/profile url), "description": "one clear sentence, >=40 chars"}}
If the inspected evidence contains no qualifying event, write []. Use the Write tool or bash to
create the file."""
    try:
        os.remove(OUT_FILE)
    except OSError:
        pass
    cmd = [
        "codex",
        "exec",
        "--model",
        BROWSE_MODEL,
        "-c",
        f"model_reasoning_effort={BROWSE_EFFORT}",
        "--dangerously-bypass-approvals-and-sandbox",
    ]
    for (_, _, _, path) in all_shots:
        cmd += ["-i", path]
    cmd.append("-")
    try:
        completed = subprocess.run(
            cmd,
            cwd=EVO,
            input=prompt.encode(),
            timeout=int(os.environ.get("INTEREST_BUDGET", "360")),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        if completed.returncode != 0:
            extraction_error = f"extractor_exit_{completed.returncode}"
        else:
            parsed = json.load(open(OUT_FILE))
            if not isinstance(parsed, list):
                raise ValueError("extractor output is not a JSON array")
            events = parsed
            extraction_ok = True
    except Exception as error:
        extraction_error = f"extractor_failed:{type(error).__name__}"
        print(f"browse-interests: {extraction_error}: {error}", file=sys.stderr)
else:
    extraction_error = "no_source_evidence"

due_ids = set(tracking)
items = []
items_per_interest = {iid: 0 for iid in due_ids}
for event in events:
    if not isinstance(event, dict):
        continue
    iid = str(event.get("interestId") or "").strip()
    if iid not in due_ids or tracking[iid]["evidenceCount"] <= 0:
        continue
    title = (event.get("title") or "").strip()
    date = (event.get("date") or "").strip()
    desc = (event.get("description") or "").strip()
    if not title or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date) or date < TODAY or len(desc) < 40:
        continue
    try:
        when = datetime.strptime(date, "%Y-%m-%d").strftime("%a %b %-d")
    except ValueError:
        continue
    entity = (event.get("entity") or "").strip()
    loc = (event.get("location") or "").strip()
    url = (event.get("url") or "").strip() or None
    card_title = f"{when}: {title}" + (
        f" @ {entity}" if entity and entity.lower() not in title.lower() else ""
    )
    norm_key = re.sub(r"\s+", " ", f"{entity}|{title}|{date}".lower()).strip()
    digest = hashlib.sha256(norm_key.encode()).hexdigest()[:16]
    items.append(
        {
            "source": "events",
            "sourceId": f"event-{digest}",
            "url": url,
            "title": card_title,
            "authorUsername": entity or None,
            "authorDisplayName": entity or None,
            "fetchedAtMs": NOW,
            "publishedAtMs": NOW - 120000,
            "expiresAtMs": NOW + TTL_DAYS * 86400000,
            "payload": {
                "type": "event",
                "title": card_title,
                "text": desc,
                "url": url,
                "interestId": iid,
                "entity": entity,
                "eventDate": date,
                "time": event.get("time") or "",
                "location": loc,
                "captureMethod": "browse-interests",
            },
        }
    )
    items_per_interest[iid] += 1

outcomes = classify_interest_outcomes(
    tracking,
    items_per_interest,
    extraction_ok=extraction_ok,
    extraction_error=extraction_error,
)

successful_before_submit = [
    outcome for outcome in outcomes if outcome["state"] in ("completed", "degraded")
]
body = {
    "source": "events",
    "triggeredBy": "browse-interests",
    "startedAtMs": NOW,
    "completedAtMs": int(time.time() * 1000),
    "status": "completed" if successful_before_submit else "failed",
    "error": (
        None
        if len(successful_before_submit) == len(outcomes)
        else extraction_error or "partial_interest_failures"
    ),
    "itemsAdded": len(items),
    "items": items if extraction_ok else [],
    "metadata": {
        "interestOutcomes": outcomes,
        "outcomeEvidence": {
            "provenEmpty": bool(
                extraction_ok
                and not items
                and outcomes
                and all(outcome["outcome"] == "empty" for outcome in outcomes)
            ),
            "evidence": "per-interest source observations are recorded in interestOutcomes",
        },
    },
}
submit_persisted = False
submit_error = ""
try:
    with post_json(
        f"{BASE}/api/internal/browse-cache/submit",
        json.dumps(body).encode(),
        timeout=20,
    ) as response:
        reply = json.loads(response.read())
        if response.status < 200 or response.status >= 300 or reply.get("ok") is not True:
            raise RuntimeError(f"cache submit rejected with HTTP {response.status}")
        submit_persisted = True
except Exception as error:
    submit_error = f"cache_submit_failed:{type(error).__name__}"
    print(f"browse-interests: submit failed: {error}", file=sys.stderr)

completed_ids = apply_submit_result(
    outcomes,
    submit_persisted=submit_persisted,
    submit_error=submit_error,
)

# Cache lifecycle belongs to the cache and curator. Refreshing an upcoming item makes it
# eligible for curation again, but this collector never assigns feed.display_order itself.
if submit_persisted and items:
    try:
        import sqlite3

        database = sqlite3.connect(os.path.join(EVO, "data", "media-agent.db"))
        source_ids = [item["sourceId"] for item in items]
        placeholders = ",".join("?" * len(source_ids))
        database.execute(
            f"UPDATE browse_cache_items SET seen_by_curation_at_ms=NULL "
            f"WHERE source='events' AND source_id IN ({placeholders})",
            source_ids,
        )
        database.commit()
        database.close()
    except Exception as error:
        print(f"browse-interests: cache eligibility reset failed: {error}", file=sys.stderr)

# The cadence watermark advances only for per-interest outcomes whose cache receipt is durable.
# Failures stay due, so an API outage or geometry/parser miss cannot masquerade as a fresh pull.
if completed_ids:
    for iid in completed_ids:
        state[iid] = NOW
    atomic_write_json(STATE, state)

receipt = {
    "version": 1,
    "startedAtMs": NOW,
    "completedAtMs": int(time.time() * 1000),
    "submitPersisted": submit_persisted,
    "submitError": submit_error or None,
    "outcomes": outcomes,
}
atomic_write_json(OUTCOMES_FILE, receipt)

srcs = f"{len(blocks)} web pages, {len(all_shots)} app screenshots ({ig_handles_done} IG profiles)"
summary = ",".join(
    f"{outcome['interestId']}={outcome['outcome']}:{outcome['itemsAdded']}"
    for outcome in outcomes
)
print(
    f"browse-interests: {len(due)}/{len(interests)} due; {srcs}; "
    f"cached {len(items)}; outcomes {summary}"
)
if any(outcome["state"] == "failed" for outcome in outcomes):
    sys.exit(1 if not completed_ids else 2)
if any(outcome["state"] == "degraded" for outcome in outcomes):
    sys.exit(2)

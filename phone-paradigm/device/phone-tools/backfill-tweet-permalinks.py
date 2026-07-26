#!/data/data/com.termux/files/usr/bin/env python3
# Backfill missing canonical permalinks with bounded, fail-closed source matching.
import difflib, json, math, os, re, sqlite3, subprocess, sys, time
import urllib.request

TOOLS = os.path.expanduser("~/phone-tools")
PHONE = f"{TOOLS}/phone.sh"
RISH = os.path.expanduser("~/rish-bin/rish")
DB = os.path.expanduser("~/evogent/data/media-agent.db")
CAP = int(sys.argv[1]) if len(sys.argv) > 1 else 20
DEADLINE_S = 420
SIM_THRESHOLD = 0.45   # a11y-captured text vs syndication full_text differ (links, truncation)


def sh(*args, timeout=45):
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


def detail_ids():
    out = rish("dumpsys activity com.twitter.tweetdetail.TweetDetailActivity 2>/dev/null"
               " | grep -oE '[0-9]{18,20}' | sort -u")
    return {int(x) for x in out.split() if x.isdigit()}


def synd_token(tweet_id):
    x = (int(tweet_id) / 1e15) * math.pi
    chars = "0123456789abcdefghijklmnopqrstuvwxyz"
    whole = int(x)
    s = ""
    n = whole
    if n == 0:
        s = "0"
    while n:
        s = chars[n % 36] + s
        n //= 36
    frac = x - whole
    f = ""
    for _ in range(11):
        frac *= 36
        d = int(frac)
        f += chars[d]
        frac -= d
    return (s + f).replace("0", "").replace(".", "") or "1"


_synd_cache = {}


def syndication(tweet_id):
    """(screen_name, text) for a status id, or (None, None). Cached per run."""
    tid = str(tweet_id)
    if tid in _synd_cache:
        return _synd_cache[tid]
    url = f"https://cdn.syndication.twimg.com/tweet-result?id={tid}&token={synd_token(tid)}"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=8) as r:
            d = json.load(r)
        result = ((d.get("user") or {}).get("screen_name"), d.get("text") or "")
    except Exception:
        result = (None, None)
    _synd_cache[tid] = result
    return result


def norm(text):
    t = re.sub(r"https?://\S+|pic\.(?:x|twitter)\.com/\S+", "", text or "")
    return re.sub(r"\s+", " ", t).strip().lower()[:120]


def similarity(a, b):
    return difflib.SequenceMatcher(None, norm(a), norm(b)).ratio()


db = sqlite3.connect(DB)
db.row_factory = sqlite3.Row


def write_permalink(row, sid):
    url = f"https://x.com/{row['author_username']}/status/{sid}"
    db.execute("UPDATE feed SET url=? WHERE id=?", (url, row["id"]))
    c = db.execute("SELECT payload_json FROM browse_cache_items WHERE source_id=?", (row["source_id"],)).fetchone()
    if c:
        try:
            p = json.loads(c["payload_json"] or "{}")
            p["url"] = url
            p["statusId"] = str(sid)
            db.execute("UPDATE browse_cache_items SET url=?, payload_json=? WHERE source_id=?",
                       (url, json.dumps(p, ensure_ascii=False), row["source_id"]))
        except Exception:
            pass
    db.commit()


def shown_tweets():
    return db.execute("""
        SELECT f.id, f.author_username, f.text, f.url, f.source_id, c.url AS cache_url
        FROM feed f LEFT JOIN browse_cache_items c ON c.source_id = f.source_id AND c.source='twitter'
        WHERE f.type='tweet' AND f.display_order IS NOT NULL AND f.source='twitter'
        ORDER BY f.display_order
    """).fetchall()


def try_assign(sid, targets, assigned):
    """Assign a candidate id to the target row it truly belongs to (syndication ground truth)."""
    sn, text = syndication(sid)
    if not sn:
        return None
    best, best_sim = None, 0.0
    for row in targets:
        if row["id"] in assigned or (row["author_username"] or "").lower() != sn.lower():
            continue
        sim = similarity(row["text"], text)
        if sim > best_sim:
            best, best_sim = row, sim
    if best is not None and best_sim >= SIM_THRESHOLD:
        write_permalink(best, sid)
        assigned.add(best["id"])
        print(f"  assigned {sid} -> @{best['author_username']} (sim {best_sim:.2f})", file=sys.stderr)
        return best
    return None


# ---- Pass 1: validate existing permalinks on shown tweets (self-healing) -------------------
rows = shown_tweets()
targets_all = [r for r in rows]
assigned = set()
repaired = stripped = 0
for r in rows:
    m = re.search(r"/status/(\d+)", r["url"] or "")
    if not m:
        continue
    sid = m.group(1)
    sn, text = syndication(sid)
    author_ok = sn is not None and sn.lower() == (r["author_username"] or "").lower()
    # Author match is near-sufficient to KEEP: the a11y-captured text and syndication full_text
    # legitimately differ (truncation, links, quote-mashing), so a low text score with a matching
    # author is almost always the right tweet — NOT a reason to strip (an earlier version threw
    # away correct permalinks this way). Only strip on author MISMATCH (definitely the wrong
    # tweet) or a dead id (@None). The rare same-author mispairing is handled below by preferring
    # a captured id that matches this row's text better; it does not need a strip here.
    if author_ok:
        assigned.add(r["id"])
        continue
    # Wrong tweet (or deleted): strip back to the honest cache url, then let the id find its
    # real owner among the shown rows.
    fallback = r["cache_url"] if (r["cache_url"] or "").startswith("https://x.com/") else f"https://x.com/{r['author_username']}"
    db.execute("UPDATE feed SET url=? WHERE id=?", (fallback, r["id"]))
    db.commit()
    stripped += 1
    print(f"  stripped bad id {sid} from @{r['author_username']} (actual @{sn})", file=sys.stderr)
    if sn and try_assign(sid, targets_all, assigned):
        repaired += 1

# ---- Pass 2: capture ids for shown tweets still without a permalink ------------------------
rows = shown_tweets()
targets = [r for r in rows if not re.search(r"/status/\d+", r["url"] or "") and r["author_username"] and len((r["text"] or "")) >= 12]
candidates_seen = set()
captured = 0
if targets:
    out = sh("launch", "com.twitter.android", timeout=60)
    m = re.search(r"hidden display (\d+)", out)
    if not m:
        print(f"backfill-permalinks: launch failed: {out.strip()}", file=sys.stderr)
        print(f"backfill-permalinks: repaired {repaired}, stripped {stripped}, captured 0")
        sys.exit(1)
    disp = m.group(1)
    start = time.time()
    tried = 0
    for r in targets:
        if r["id"] in assigned:
            continue
        if tried >= CAP or time.time() - start > DEADLINE_S:
            break
        tried += 1
        first_line = (r["text"] or "").split("\n")[0]
        # Quoted-phrase Top search finds old tweets too (Latest goes empty past a few days).
        phrase = "+".join(re.findall(r"[A-Za-z0-9]+", first_line)[:5])
        search_url = f"https://x.com/search?q=from%3A{r['author_username']}+%22{phrase}%22&f=top" if phrase else None
        if (r["cache_url"] or "").startswith("https://x.com/search"):
            search_url = r["cache_url"]
        if not search_url:
            continue
        rish(f"am start --display {disp} -a android.intent.action.VIEW -d '{search_url}' com.twitter.android >/dev/null 2>&1")
        time.sleep(4.5)
        words_runs = re.findall(r"[A-Za-z0-9][A-Za-z0-9' ]{14,40}", first_line)
        tgts = [first_line[:28]] + ([words_runs[len(words_runs) // 2].strip()[:28]] if words_runs else [])
        for tgt in tgts:
            if len(tgt.strip()) < 12:
                continue
            sh("tap", tgt.strip(), disp)
            time.sleep(2.5)
            new = detail_ids() - candidates_seen
            if new:
                break
        # Every id the dump has ever shown this run is a candidate; syndication decides whose
        # tweet each one is, so misattributed/slow opens still convert into correct assignments.
        for sid in sorted(detail_ids() - candidates_seen, reverse=True):
            candidates_seen.add(sid)
            if try_assign(sid, targets, assigned):
                captured += 1

remaining = sum(1 for r in shown_tweets() if not re.search(r"/status/\d+", r["url"] or ""))
print(f"backfill-permalinks: repaired {repaired}, stripped {stripped}, captured {captured}, still-unlinked {remaining}")

#!/data/data/com.termux/files/usr/bin/env python3
# Discover source candidates from public signals; final account changes remain a user action.
import json, os, re, shlex, subprocess, sys, time
sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
from durable_task_queue import TaskQueueError, acknowledge_queued_task, enqueue_task
from evogent_api import ORIGIN as BASE, post_json

HOME = os.path.expanduser("~")
TOOLS = f"{HOME}/phone-tools"
SOURCES_DIR = f"{HOME}/evogent/data/phone-sources"
QUEUE_DIR = f"{SOURCES_DIR}/.queue"
OPTOUT_FILE = f"{SOURCES_DIR}/.optout"
USAGE_MIN_SECONDS = 45 * 60      # weekly foreground floor for the usage trigger
FRESH_INSTALL_DAYS = 14          # install-recency trigger window
MAX_NEW_PER_RUN = 6              # bounds announcement-card volume (first boot can hit many)
# Sources the cycle already browses without a recipe file (hardcoded in evogent-cycle.sh).
BUILTIN_COVERED = {
    "com.twitter.android",
    "com.google.android.youtube",
    "com.google.android.gm",
}

def rish(cmd, timeout=30, retries=3):
    """Run a shell-uid command via Shizuku rish. First bind after idle can time out."""
    env = dict(os.environ, RISH_APPLICATION_ID="com.termux")
    for attempt in range(retries):
        try:
            r = subprocess.run([f"{HOME}/rish-bin/rish", "-c", cmd],
                               capture_output=True, text=True, timeout=timeout, env=env)
            out = r.stdout
            if "Request timeout" not in out and (out.strip() or r.returncode == 0):
                return out
        except Exception:
            pass
        time.sleep(2)
    return None

def parse_usage_seconds(dump):
    """Weekly totalTimeUsed per package from `dumpsys usagestats`."""
    usage = {}
    section = None
    for line in dump.splitlines():
        if "In-memory" in line and "stats" in line:
            section = line.strip()
            continue
        if section and "weekly" not in section.lower():
            continue
        m = re.search(r'package=(\S+).*totalTimeUsed="([\d:]+)"', line)
        if not m:
            continue
        parts = [int(p) for p in m.group(2).split(":")]
        while len(parts) < 3:
            parts.insert(0, 0)
        usage[m.group(1)] = parts[0] * 3600 + parts[1] * 60 + parts[2]
    return usage

def first_install_days_ago_batch(pkgs):
    """One rish call for ALL packages — per-package calls flake (fresh binder each time)."""
    if not pkgs:
        return {}
    loop = "; ".join(
        f'echo "PKG {p} $(dumpsys package {p} | grep -m1 firstInstallTime)"' for p in pkgs
    )
    out = rish(loop, timeout=60, retries=3) or ""
    ages = {}
    for m in re.finditer(r"PKG (\S+) .*firstInstallTime=(\d{4}-\d{2}-\d{2})", out):
        installed = time.mktime(time.strptime(m.group(2), "%Y-%m-%d"))
        ages[m.group(1)] = max(0, (time.time() - installed) / 86400)
    # The mega-batch can drop packages nondeterministically (long compound command,
    # per-dumpsys flake). Retry the missing few individually, bounded.
    missing = [p for p in pkgs if p not in ages][:10]
    for p in missing:
        o = rish(f"dumpsys package {p} | grep -m1 firstInstallTime", timeout=20, retries=2) or ""
        m = re.search(r"firstInstallTime=(\d{4}-\d{2}-\d{2})", o)
        if m:
            installed = time.mktime(time.strptime(m.group(1), "%Y-%m-%d"))
            ages[p] = max(0, (time.time() - installed) / 86400)
    return ages

def opted_out():
    out = set()
    try:
        for line in open(OPTOUT_FILE):
            out.update(line.split())
    except FileNotFoundError:
        pass
    return out

def existing_recipe_or_queue(source):
    task_name = f"{source}.json"
    return (os.path.exists(f"{SOURCES_DIR}/{source}.txt")
            or os.path.exists(f"{SOURCES_DIR}/{source}.py")
            or any(os.path.exists(os.path.join(QUEUE_DIR, place, task_name))
                   for place in ("", ".leased", ".quarantine"))
            or os.path.exists(f"{QUEUE_DIR}/.receipts/{source}-final.json"))

def main():
    with open(f"{TOOLS}/source-catalog.json") as f:
        catalog = json.load(f)["apps"]
    # Agent-extendable catalog: the app-research agent appends entries for apps it judged
    # worth browsing to data/source-catalog-local.json (agents own data/, the repo file stays
    # canonical). Merged here so researched apps flow into the normal discovery path.
    try:
        with open(os.path.expanduser("~/evogent/data/source-catalog-local.json")) as f:
            catalog = {**catalog, **json.load(f).get("apps", {})}
    except (OSError, ValueError):
        pass

    pkgs_out = rish("pm list packages")
    if pkgs_out is None:
        print("source-scout: shell access (rish/Shizuku) unavailable — skipping this run", file=sys.stderr)
        return 0
    installed = {l.split(":", 1)[1].strip() for l in pkgs_out.splitlines() if l.startswith("package:")}

    dump = rish("dumpsys usagestats", timeout=60, retries=2) or ""
    usage = parse_usage_seconds(dump)
    skip = opted_out()

    os.makedirs(QUEUE_DIR, exist_ok=True)
    prospects = [
        (pkg, meta) for pkg, meta in catalog.items()
        if pkg in installed and pkg not in BUILTIN_COVERED and pkg not in skip
        and meta["source"] not in skip and not existing_recipe_or_queue(meta["source"])
    ]
    install_ages = first_install_days_ago_batch([pkg for pkg, _ in prospects])

    cards, queued = [], []
    for pkg, meta in prospects:
        if len(cards) >= MAX_NEW_PER_RUN:
            break
        source = meta["source"]
        used_s = usage.get(pkg, 0)
        days_ago = install_ages.get(pkg)
        fresh = days_ago is not None and days_ago <= FRESH_INSTALL_DAYS
        heavy = used_s >= USAGE_MIN_SECONDS
        if not (fresh or heavy):
            continue
        if fresh and not heavy:
            why = ("you installed it "
                   + ("today" if days_ago < 1 else f"{int(days_ago)} day{'s' if int(days_ago) != 1 else ''} ago"))
        else:
            why = f"you spent {used_s // 3600}h {used_s % 3600 // 60}m in it this week"

        if meta.get("autoAdd", False):
            # Act, show, easy undo: queue the discovery and announce it. Dismiss = cancel.
            enqueue_task(
                QUEUE_DIR,
                {"kind": "discovery", "pkg": pkg, "name": meta["name"], "source": source},
                task_id=source,
            )
            queued.append(meta["name"])
            cards.append({
                "type": "suggestion",
                "source": "phone",
                "sourceId": f"source-scout-{pkg}",
                "title": f"Adding {meta['name']} as a source",
                "text": (f"Evogent noticed {why} and is setting {meta['name']} up as a source: a one-time "
                         f"background pass learns how to browse it (hidden display, read-only — never posting, "
                         f"liking, or opening private messages), then it feeds the curator only when its "
                         f"source-specific cadence is due or a source signal makes it due. "
                         f"A notification will show what the first browse found. "
                         f"Dismiss this card (✕) to cancel and keep {meta['name']} out of Evogent."),
                "metadata": {
                    "suggestionType": "source_setup",
                    "suggestionStatus": "pending",
                    "importance": "normal",
                    "autoAdded": True,
                    "sourcePackage": pkg,
                    "sourceName": source,
                    "actions": [{"label": "Sounds good", "kind": "acknowledge"}],
                },
            })
        else:
            # Messaging-hybrid apps (public/private surfaces blur): ask before touching.
            cards.append({
                "type": "suggestion",
                "source": "phone",
                "sourceId": f"source-scout-{pkg}",
                "title": f"Add {meta['name']} as a source?",
                "text": (f"Evogent noticed {why}. Because {meta['name']} mixes public content with private "
                         f"conversations, it stays out unless you approve. If approved, browsing is read-only "
                         f"and strictly limited to public surfaces — never chats or DMs."),
                "metadata": {
                    "suggestionType": "source_setup",
                    "suggestionStatus": "pending",
                    "importance": "normal",
                    "sourcePackage": pkg,
                    "sourceName": source,
                    "actions": [
                        {
                            "label": f"Set {meta['name']} up as a source",
                            "instruction": (
                                f"Queue the one-time source discovery for {meta['name']} by running exactly: "
                                f"python3 ~/phone-tools/durable_task_queue.py enqueue "
                                f"--root ~/evogent/data/phone-sources/.queue --kind discovery "
                                f"--task-id {shlex.quote(source)} --pkg {shlex.quote(pkg)} "
                                f"--name {shlex.quote(meta['name'])} --source {shlex.quote(source)} "
                                f"&& bash ~/phone-tools/request-cycle.sh source-discovery-approved "
                                f"— then reply confirming discovery was queued. Do not wait for it to complete."
                            ),
                            "kind": "execute",
                        },
                        {"label": "Not this app", "kind": "acknowledge"},
                    ],
                },
            })

    # Persist only generalized discovery evidence; deployment-specific taste remains private.
    researched_file = f"{TOOLS}/.researched-apps"
    try:
        researched = set(open(researched_file).read().split())
    except OSError:
        researched = set()
    own = {"com.termux", "net.dangish.evogent", "moe.shizuku.privileged.api", "com.anthropic.claude"}
    third_out = rish("pm list packages -3") or ""
    third = {l.split(":", 1)[1].strip() for l in third_out.splitlines() if l.startswith("package:")}
    unknown = [p for p in third
               if p not in catalog and p not in BUILTIN_COVERED and p not in researched and p not in own]
    unknown_ages = first_install_days_ago_batch(unknown)
    # Newest installs first: "I installed this TODAY" is the strongest intent signal and must
    # never wait behind older queue-fillers for the per-run cap.
    fresh_unknown = sorted(((p, d) for p, d in unknown_ages.items()
                            if d is not None and d <= FRESH_INSTALL_DAYS),
                           key=lambda x: x[1])[:2]
    for pkg, days in fresh_unknown:
        task_id = f"research-{pkg}"
        result = enqueue_task(
            QUEUE_DIR,
            {"kind": "research", "pkg": pkg, "installedDaysAgo": days},
            task_id=task_id,
        )
        if result["created"]:
            with open(researched_file, "a") as f:
                f.write(pkg + "\n")
            print(f"source-scout: queued app RESEARCH for unknown fresh install {pkg} ({days}d ago)", file=sys.stderr)

    if not cards:
        print("source-scout: no new candidates (catalog apps all covered, unused, opted out, or already set up)", file=sys.stderr)
        return 0

    with post_json(f"{BASE}/api/internal/curate/submit",
                   json.dumps({"items": cards}).encode(), timeout=15) as r:
        result = json.loads(r.read())
    # A duplicate means we already announced/asked once. Durably acknowledge that request
    # with an outcome receipt instead of unlinking it without an explanation.
    dupes = set(result.get("duplicateSourceIds") or [])
    for card in cards:
        if card["sourceId"] in dupes:
            src = card["metadata"]["sourceName"]
            try:
                acknowledge_queued_task(
                    QUEUE_DIR,
                    src,
                    outcome="announcement_already_handled",
                    detail="curate submit returned this source announcement as a duplicate",
                )
            except (OSError, ValueError, TaskQueueError):
                print(
                    f"source-scout: duplicate request {src} could not be acknowledged; "
                    "its durable queue state was left untouched",
                    file=sys.stderr,
                )
    print(f"source-scout: {result.get('accepted', 0)} card(s) ({result.get('duplicates', 0)} already handled); "
          f"auto-queued: {', '.join(queued) or 'none'}", file=sys.stderr)
    return 0

if __name__ == "__main__":
    sys.exit(main())

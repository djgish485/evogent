#!/data/data/com.termux/files/usr/bin/env python3
# Discover source candidates from public signals; final account changes remain a user action.
import json, math, os, pathlib, re, shlex, stat, subprocess, sys, time
sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
from durable_task_queue import enqueue_task
from evogent_api import ORIGIN as BASE, post_json

HOME = os.path.expanduser("~")
TOOLS = f"{HOME}/phone-tools"
SOURCES_DIR = f"{HOME}/evogent/data/phone-sources"
QUEUE_DIR = f"{SOURCES_DIR}/.queue"
OPTOUT_FILE = f"{SOURCES_DIR}/.optout"
MIGRATION_INTENTS_FILE = f"{SOURCES_DIR}/.migration-pending-source-intents.json"
MAX_MIGRATION_INTENTS = 256
MAX_MIGRATION_INTENTS_BYTES = 256 * 1024
ANDROID_PACKAGE_RE = re.compile(
    r"^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$"
)
SOURCE_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
DISCOVERY_TASK_ID_RE = re.compile(
    r"^discovery-v[1-9][0-9]{0,5}-([a-z0-9][a-z0-9-]{0,63})$"
)
USAGE_MIN_SECONDS = 45 * 60      # weekly foreground floor for the usage trigger
FRESH_INSTALL_DAYS = 14          # install-recency trigger window
MAX_NEW_PER_RUN = 6              # bounds announcement-card volume (first boot can hit many)
DISCOVERY_ACTIVATION_EPOCH = 3   # re-discovers legacy prose recipes under strict schema-2 authority
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

def source_admission_state(source):
    try:
        result = subprocess.run(
            [
                sys.executable,
                f"{TOOLS}/source_recipe_authority.py",
                "admission-state",
                "--database",
                f"{HOME}/evogent/data/media-agent.db",
                "--ledger",
                OPTOUT_FILE,
                "--source",
                source,
            ],
            capture_output=True,
            text=True,
            timeout=8,
        )
        state = result.stdout.strip()
        return state if result.returncode == 0 and state in {"allowed", "cancelled"} else "unknown"
    except (OSError, subprocess.SubprocessError):
        return "unknown"

def existing_recipe_or_queue(source):
    task_id = f"discovery-v{DISCOVERY_ACTIVATION_EPOCH}-{source}"
    if os.path.exists(f"{SOURCES_DIR}/{source}.py"):
        return True
    recipe = f"{SOURCES_DIR}/{source}.txt"
    if os.path.exists(recipe):
        try:
            active = subprocess.run(
                [
                    sys.executable,
                    f"{TOOLS}/source_recipe_authority.py",
                    "verify-active",
                    "--database",
                    f"{HOME}/evogent/data/media-agent.db",
                    "--source",
                    source,
                    "--recipe",
                    recipe,
                    "--manifest",
                    f"{SOURCES_DIR}/.active/{source}.json",
                ],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=8,
            )
            if active.returncode == 0:
                return True
        except (OSError, subprocess.SubprocessError):
            pass
    for place in ("", ".leased", ".quarantine"):
        directory = os.path.join(QUEUE_DIR, place)
        try:
            candidates = [
                os.path.join(directory, entry)
                for entry in os.listdir(directory)
                if entry.endswith(".json")
            ]
        except OSError:
            continue
        for candidate in candidates:
            try:
                with open(candidate, encoding="utf-8") as stream:
                    request = json.load(stream)
                    if (
                        str(request.get("source") or "") == source
                        and (
                            place != ".quarantine"
                            or str(request.get("taskId") or "") == task_id
                        )
                    ):
                        return True
            except (OSError, ValueError, AttributeError):
                continue
    return os.path.exists(f"{QUEUE_DIR}/.receipts/{task_id}-final.json")

def _positive_int(value, label):
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ValueError(f"{label} must be a positive integer")
    return value

def _canonical_migration_intent(value, index):
    label = f"migration source intent {index}"
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be an object")
    task_id = value.get("taskId")
    package = value.get("pkg")
    created_at_ms = _positive_int(value.get("createdAtMs"), f"{label} createdAtMs")
    if (
        not isinstance(task_id, str)
        or not isinstance(package, str)
        or len(package) > 253
        or ANDROID_PACKAGE_RE.fullmatch(package) is None
    ):
        raise ValueError(f"{label} has an invalid identity")

    if value.get("kind") == "discovery":
        name = value.get("name")
        source = value.get("source")
        task_match = (
            DISCOVERY_TASK_ID_RE.fullmatch(task_id)
            if isinstance(task_id, str)
            else None
        )
        if (
            not isinstance(name, str)
            or name != name.strip()
            or not name
            or len(name) > 120
            or not all(character.isprintable() for character in name)
            or not isinstance(source, str)
            or SOURCE_SLUG_RE.fullmatch(source) is None
            or task_match is None
            or task_match.group(1) != source
        ):
            raise ValueError(f"{label} is not a canonical discovery intent")
        canonical = {
            "taskId": task_id,
            "kind": "discovery",
            "pkg": package,
            "name": name,
            "source": source,
            "createdAtMs": created_at_ms,
        }
    elif value.get("kind") == "research":
        installed_days_ago = value.get("installedDaysAgo")
        if (
            task_id != f"research-{package}"
            or isinstance(installed_days_ago, bool)
            or not isinstance(installed_days_ago, (int, float))
            or not math.isfinite(installed_days_ago)
            or installed_days_ago < 0
        ):
            raise ValueError(f"{label} is not a canonical research intent")
        canonical = {
            "taskId": task_id,
            "kind": "research",
            "pkg": package,
            "installedDaysAgo": installed_days_ago,
            "createdAtMs": created_at_ms,
        }
    else:
        raise ValueError(f"{label} has an unsupported kind")

    if set(value) != set(canonical):
        raise ValueError(f"{label} has unexpected fields")
    return canonical

def _read_migration_intents(path):
    try:
        before = path.lstat()
    except FileNotFoundError:
        return None
    flags = (
        os.O_RDONLY
        | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_NOFOLLOW", 0)
    )
    descriptor = os.open(path, flags)
    try:
        opened = os.fstat(descriptor)
        if (
            not stat.S_ISREG(opened.st_mode)
            or opened.st_uid != os.geteuid()
            or opened.st_nlink != 1
            or stat.S_IMODE(opened.st_mode) & 0o077
            or opened.st_size < 1
            or opened.st_size > MAX_MIGRATION_INTENTS_BYTES
            or opened.st_dev != before.st_dev
            or opened.st_ino != before.st_ino
        ):
            raise ValueError(
                "migration source-intent handoff is not bounded owner-private state"
            )
        chunks = []
        remaining = opened.st_size
        while remaining:
            chunk = os.read(descriptor, min(remaining, 65536))
            if not chunk:
                raise ValueError("migration source-intent handoff is truncated")
            chunks.append(chunk)
            remaining -= len(chunk)
        if os.read(descriptor, 1):
            raise ValueError("migration source-intent handoff grew while read")
    finally:
        os.close(descriptor)
    after = path.lstat()
    if (
        after.st_dev != opened.st_dev
        or after.st_ino != opened.st_ino
        or after.st_size != opened.st_size
        or after.st_mtime_ns != opened.st_mtime_ns
    ):
        raise ValueError("migration source-intent handoff changed while read")
    try:
        document = json.loads(b"".join(chunks).decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("migration source-intent handoff is not valid UTF-8 JSON") from error
    if (
        not isinstance(document, dict)
        or set(document) != {"schemaVersion", "capturedAtMs", "intents"}
        or isinstance(document.get("schemaVersion"), bool)
        or document.get("schemaVersion") != 1
        or not isinstance(document.get("intents"), list)
        or len(document["intents"]) > MAX_MIGRATION_INTENTS
    ):
        raise ValueError("migration source-intent handoff has an invalid schema")
    _positive_int(document.get("capturedAtMs"), "migration handoff capturedAtMs")
    intents = [
        _canonical_migration_intent(value, index)
        for index, value in enumerate(document["intents"])
    ]
    task_ids = [intent["taskId"] for intent in intents]
    if len(set(task_ids)) != len(task_ids):
        raise ValueError("migration source-intent handoff has duplicate identities")
    return {
        "document": {
            "schemaVersion": 1,
            "capturedAtMs": document["capturedAtMs"],
            "intents": intents,
        },
        "identity": (opened.st_dev, opened.st_ino),
    }

def _fsync_directory(path):
    descriptor = os.open(
        path,
        os.O_RDONLY | getattr(os, "O_DIRECTORY", 0),
    )
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)

def _same_regular_identity(path, identity):
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        return False
    return (
        not path.is_symlink()
        and stat.S_ISREG(metadata.st_mode)
        and metadata.st_uid == os.geteuid()
        and metadata.st_nlink == 1
        and (metadata.st_dev, metadata.st_ino) == identity
    )

def _replace_migration_intents(path, identity, document):
    parent = path.parent
    parent_metadata = parent.lstat()
    if (
        parent.is_symlink()
        or not stat.S_ISDIR(parent_metadata.st_mode)
        or parent_metadata.st_uid != os.geteuid()
    ):
        raise ValueError("migration source-intent directory is not owner-controlled")
    if not _same_regular_identity(path, identity):
        raise ValueError("migration source-intent handoff changed before reconciliation")
    if document is None:
        path.unlink()
        _fsync_directory(parent)
        return

    encoded = (
        json.dumps(document, separators=(",", ":"), sort_keys=True) + "\n"
    ).encode("utf-8")
    if len(encoded) > MAX_MIGRATION_INTENTS_BYTES:
        raise ValueError("remaining migration source-intent handoff is too large")
    temporary = parent / (
        f".{path.name}.{os.getpid()}.{os.urandom(6).hex()}.tmp"
    )
    flags = (
        os.O_WRONLY
        | os.O_CREAT
        | os.O_EXCL
        | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_NOFOLLOW", 0)
    )
    descriptor = os.open(temporary, flags, 0o600)
    try:
        view = memoryview(encoded)
        while view:
            written = os.write(descriptor, view)
            if written <= 0:
                raise OSError("migration source-intent rewrite stopped")
            view = view[written:]
        os.fchmod(descriptor, 0o600)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    try:
        if not _same_regular_identity(path, identity):
            raise ValueError(
                "migration source-intent handoff changed during reconciliation"
            )
        os.replace(temporary, path)
        _fsync_directory(parent)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass

def reconcile_migration_source_intents(installed):
    """Recreate portable work under this phone's queue authority, idempotently."""
    path = pathlib.Path(MIGRATION_INTENTS_FILE)
    loaded = _read_migration_intents(path)
    summary = {
        "queued": 0,
        "alreadyPresent": 0,
        "cancelled": 0,
        "waitingForInstall": 0,
        "waitingForAdmission": 0,
        "errors": 0,
    }
    if loaded is None:
        return summary

    original = loaded["document"]
    remaining = []
    for intent in original["intents"]:
        if intent["pkg"] not in installed:
            remaining.append(intent)
            summary["waitingForInstall"] += 1
            continue
        if intent["kind"] == "discovery":
            admission = source_admission_state(intent["source"])
            if admission == "unknown":
                remaining.append(intent)
                summary["waitingForAdmission"] += 1
                continue
            if admission == "cancelled":
                summary["cancelled"] += 1
                continue
            if existing_recipe_or_queue(intent["source"]):
                summary["alreadyPresent"] += 1
                continue
            payload = {
                "kind": "discovery",
                "pkg": intent["pkg"],
                "name": intent["name"],
                "source": intent["source"],
            }
        else:
            # This deliberately bypasses .researched-apps: that marker may have been
            # written when the old phone enqueued work whose live queue was excluded.
            payload = {
                "kind": "research",
                "pkg": intent["pkg"],
                "installedDaysAgo": intent["installedDaysAgo"],
            }
        try:
            result = enqueue_task(
                QUEUE_DIR,
                payload,
                task_id=intent["taskId"],
                stamp=intent["createdAtMs"],
            )
        except Exception as error:
            remaining.append(intent)
            summary["errors"] += 1
            print(
                f"source-scout: migration intent retained after enqueue failure: {error}",
                file=sys.stderr,
            )
            continue
        if result["created"]:
            summary["queued"] += 1
        else:
            summary["alreadyPresent"] += 1

    if remaining != original["intents"]:
        replacement = None
        if remaining:
            replacement = {
                "schemaVersion": 1,
                "capturedAtMs": original["capturedAtMs"],
                "intents": remaining,
            }
        _replace_migration_intents(path, loaded["identity"], replacement)
    elif not remaining:
        _replace_migration_intents(path, loaded["identity"], None)
    return summary

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

    os.makedirs(QUEUE_DIR, exist_ok=True)
    try:
        migration = reconcile_migration_source_intents(installed)
    except (OSError, ValueError) as error:
        print(
            f"source-scout: migration source-intent handoff refused: {error}",
            file=sys.stderr,
        )
        return 1
    if any(migration.values()):
        print(
            "source-scout: migration intent reconciliation "
            + " ".join(f"{key}={value}" for key, value in migration.items()),
            file=sys.stderr,
        )
    if migration["errors"] or migration["waitingForAdmission"]:
        # Do not publish the daily scout stamp while migrated approved discovery
        # is waiting on a transient database/opt-out authority proof.
        return 1

    dump = rish("dumpsys usagestats", timeout=60, retries=2) or ""
    usage = parse_usage_seconds(dump)
    prospects = [
        (pkg, meta) for pkg, meta in catalog.items()
        if pkg in installed and pkg not in BUILTIN_COVERED
        and source_admission_state(meta["source"]) == "allowed"
        and not existing_recipe_or_queue(meta["source"])
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
                task_id=f"discovery-v{DISCOVERY_ACTIVATION_EPOCH}-{source}",
            )
            queued.append(meta["name"])
            cards.append({
                "type": "suggestion",
                "source": "phone",
                "sourceId": f"source-scout-v{DISCOVERY_ACTIVATION_EPOCH}-{pkg}",
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
                "sourceId": f"source-scout-v{DISCOVERY_ACTIVATION_EPOCH}-{pkg}",
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
                                f"--task-id {shlex.quote(f'discovery-v{DISCOVERY_ACTIVATION_EPOCH}-{source}')} "
                                f"--pkg {shlex.quote(pkg)} "
                                f"--name {shlex.quote(meta['name'])} --source {shlex.quote(source)} "
                                f"&& bash ~/phone-tools/request-cycle.sh source-discovery-approved "
                                f"— then reply confirming discovery was queued. Do not wait for it to complete."
                            ),
                            "kind": "execute",
                        },
                        {"label": "Not this app", "kind": "cancel_source"},
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
    # Announcement identity is activation-epoch scoped. A duplicate is only UI evidence and
    # never terminal discovery authority: leave the durable task queued until its own exact
    # activation proof or an explicit source cancellation resolves it.
    print(f"source-scout: {result.get('accepted', 0)} card(s) ({result.get('duplicates', 0)} already handled); "
          f"auto-queued: {', '.join(queued) or 'none'}", file=sys.stderr)
    return 0

if __name__ == "__main__":
    sys.exit(main())

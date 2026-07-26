#!/data/data/com.termux/files/usr/bin/env python3
# Product-wide verification only. Deployment-specific taste and direct user
# evidence belong in private runtime state, never this public script.





import json, os, re, sqlite3, sys
sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
from evogent_api import ORIGIN as BASE, post_json

DB = os.path.expanduser('~/evogent/data/media-agent.db')
db = sqlite3.connect(DB)
db.row_factory = sqlite3.Row





shown = db.execute("""
    SELECT f.id, f.type, f.source, f.author_username, f.url, f.text, f.title, f.media_urls,
           f.author_avatar_url, f.metadata, f.display_order, f.thread_id, f.created_at_ms
    FROM feed f
    WHERE f.display_order IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM interactions i
                      WHERE i.feed_item_id = f.id AND i.action = 'dislike')
      AND NOT (f.type = 'notification' AND EXISTS (
          SELECT 1 FROM interactions i
          WHERE i.feed_item_id = f.id AND i.action = 'suggestion_dismissed'))
    ORDER BY f.display_order
""").fetchall()

shown = [dict(r) for r in shown]

failures = []
warnings = []
report = {}


def check(name, ok, detail, hard=True):
    report[name] = {'ok': bool(ok), 'detail': detail}
    if not ok:
        (failures if hard else warnings).append(f"{name}: {detail}")


PRIMARY_TYPES = {'tweet', 'article', 'analysis'}
SINGLETON_PREFIXES = ('shipment-singleton:', 'carry-forward-singleton:')
primary = [r for r in shown if r['type'] in PRIMARY_TYPES]
check('primary-slate-bounded', len(primary) <= 50,
      f"{len(primary)} primary tweet/article/analysis items shown (maximum 50)")

display_orders = [r['display_order'] for r in shown]
valid_display_orders = (
    all(isinstance(order, int) and not isinstance(order, bool) and order > 0
        for order in display_orders)
    and len(display_orders) == len(set(display_orders))
    and sorted(display_orders) == list(range(1, len(display_orders) + 1))
)
check('display-order-stable', valid_display_orders,
      'display orders are unique and contiguous' if valid_display_orders
      else 'display orders are missing, duplicated, or non-contiguous')


def _metadata(r):
    try:
        value = json.loads(r['metadata'] or '{}')
        return value if isinstance(value, dict) else {}
    except Exception:
        return {}


thread_members = {}
thread_positions = {}
thread_problems = []
for _position, _row in enumerate(primary):
    _item_id = _row.get('id')
    _thread_id = (_row.get('thread_id') or '').strip()
    if not isinstance(_item_id, str) or not _item_id or not _thread_id:
        thread_problems.append(f"{_item_id}: missing stable item/thread identity")
        continue
    thread_members.setdefault(_thread_id, []).append(_item_id)
    thread_positions.setdefault(_thread_id, []).append(_position)
    _meta = _metadata(_row)
    _thread_meta = _meta.get('thread') if isinstance(_meta.get('thread'), dict) else {}
    _metadata_thread_id = (
        _thread_meta.get('threadId')
        or _meta.get('threadId')
        or ''
    )
    _singleton_prefix = next(
        (prefix for prefix in SINGLETON_PREFIXES if _thread_id.startswith(prefix)),
        None,
    )
    if _singleton_prefix:
        if _thread_id != f"{_singleton_prefix}{_item_id}":
            thread_problems.append(f"{_item_id}: singleton identity does not match item")
        if any(str(_metadata_thread_id).startswith(prefix)
               for prefix in SINGLETON_PREFIXES):
            thread_problems.append(f"{_item_id}: singleton identity leaked into display metadata")
    elif str(_metadata_thread_id).strip() != _thread_id:
        thread_problems.append(f"{_item_id}: real thread identity was remapped")

for _thread_id, _members in thread_members.items():
    _positions = thread_positions[_thread_id]
    _is_singleton = any(_thread_id.startswith(prefix) for prefix in SINGLETON_PREFIXES)
    if _is_singleton and len(_members) != 1:
        thread_problems.append(f"{_thread_id}: singleton pools {len(_members)} items")
    if not _is_singleton and len(_members) < 2:
        thread_problems.append(f"{_thread_id}: real thread has fewer than two items")
    if not _is_singleton and _positions[-1] - _positions[0] + 1 != len(_positions):
        thread_problems.append(f"{_thread_id}: real thread is split")

check('shipment-thread-integrity', not thread_problems,
      'stable IDs; real threads have 2+ contiguous items; singletons stay hidden'
      if not thread_problems else '; '.join(thread_problems[:8]))


latest_arrangement = db.execute("""
    SELECT id, carry_forward_audit
    FROM feed_arrangement_runs
    ORDER BY id DESC
    LIMIT 1
""").fetchone()
eligible_review_problem = None
try:
    _audit = json.loads(latest_arrangement['carry_forward_audit'] or '{}')
    _eligible = int(_audit.get('eligibleCount'))
    _reviewed = int(_audit.get('reviewedCount'))
    _returned = int(_audit.get('returnedCount'))
    if (
        _audit.get('includeAllUnviewed') is not True
        or _audit.get('includeDisplayed') is not True
        or _eligible < 0
        or _reviewed < _eligible
        or _returned < _eligible
    ):
        eligible_review_problem = (
            f"eligible={_eligible}, reviewed={_reviewed}, returned={_returned}, "
            f"includeAll={_audit.get('includeAllUnviewed')}, "
            f"includeDisplayed={_audit.get('includeDisplayed')}"
        )
except Exception:
    eligible_review_problem = 'latest arrangement lacks a parseable complete-set receipt'
check('full-eligible-review-receipt', eligible_review_problem is None,
      'latest arrangement durably records the full eligible review'
      if eligible_review_problem is None else eligible_review_problem)


recent_receipts = db.execute("""
    SELECT id, items_added, completion_status, completion_reason
    FROM curation_log
    WHERE completed_at IS NOT NULL
    ORDER BY id DESC
    LIMIT 30
""").fetchall()
receipt_problems = []
_terminal_statuses = {
    'success', 'successful_empty', 'empty', 'cancelled', 'failed', 'aborted',
}
for _receipt in recent_receipts:
    _status = (_receipt['completion_status'] or '').strip().lower()
    _reason = (_receipt['completion_reason'] or '').strip()
    _count = _receipt['items_added']
    if _status not in _terminal_statuses:
        receipt_problems.append(f"{_receipt['id']}: missing terminal status")
    if not _reason:
        receipt_problems.append(f"{_receipt['id']}: missing completion reason")
    if not isinstance(_count, int) or isinstance(_count, bool) or _count < 0:
        receipt_problems.append(f"{_receipt['id']}: invalid accepted count")
    elif _status == 'success' and _count == 0:
        receipt_problems.append(f"{_receipt['id']}: success without accepted items")
    elif _status in {'successful_empty', 'empty'} and _count != 0:
        receipt_problems.append(f"{_receipt['id']}: empty status with accepted items")
check('truthful-curation-receipts', bool(recent_receipts) and not receipt_problems,
      f"{len(recent_receipts)} recent completed cycles carry coherent durable receipts"
      if recent_receipts and not receipt_problems
      else ('no completed curation receipt is observable'
            if not recent_receipts else '; '.join(receipt_problems[:8])))


scaffolded = [r['id'] for r in shown if r['type'] == 'tweet' and re.search(
    r'\bQuoted\.\s+\S|\bVerified\.\s|pic\.(x|twitter)\.com/|https://t\.co/', r['text'] or '')]
check('no-scaffolding-shown', not scaffolded, f"{len(scaffolded)} shown tweets carry raw scaffolding/link tokens")


seen_keys = {}
dups = 0
for r in shown:
    if r['type'] != 'tweet':
        continue
    k = ((r['author_username'] or '').lower(), (r['text'] or '')[:60])
    dups += 1 if k in seen_keys else 0
    seen_keys[k] = True
check('no-duplicate-tweets', dups == 0, f"{dups} duplicate tweets shown")


import time
now_ms = int(time.time() * 1000)



missing_rich = 0
for r in shown:
    if r['type'] != 'tweet' or not r['url'] or '/status/' not in (r['url'] or ''):
        continue
    m = re.search(r'/status/(\d+)', r['url'])
    if not m:
        continue
    c = db.execute("SELECT payload_json FROM browse_cache_items WHERE source_id=? OR source_id=?",
                   (m.group(1), f"tweet-{m.group(1)}")).fetchone()
    if not c:
        continue
    try:
        p = json.loads(c['payload_json'] or '{}')
    except Exception:
        continue
    meta = {}
    try:
        meta = json.loads(r['metadata'] or '{}')
    except Exception:
        pass
    if p.get('quotedTweet') and not meta.get('quotedTweet'):
        missing_rich += 1
    if p.get('mediaUrls') and (not r['media_urls'] or r['media_urls'] == '[]'):
        missing_rich += 1
check('rich-data-reaches-cards', missing_rich == 0,
      f"{missing_rich} shown tweets have quote/media in cache but not on the card")





def _has_quote_meta(r):
    try:
        return bool(json.loads(r['metadata'] or '{}').get('quotedTweet'))
    except Exception:
        return False
mashed_quotes = [r['id'] for r in shown if r['type'] == 'tweet'
                 and re.search(r'\bQuot(?:ing|ed)[ .]@?[A-Za-z0-9_]{1,15}[.:]', r['text'] or '')
                 and not _has_quote_meta(r)]
check('quote-tweets-structured', not mashed_quotes,
      f"{len(mashed_quotes)} quote tweets shown as mashed text instead of a structured sub-card")


perma = sum(1 for r in shown if r['type'] == 'tweet' and '/status/' in (r['url'] or ''))
tw_shown = sum(1 for r in shown if r['type'] == 'tweet')
rate = (perma / tw_shown) if tw_shown else 1
check('permalink-coverage', rate >= 0.25, f"{perma}/{tw_shown} shown tweets have real permalinks ({rate:.0%})", hard=False)


zero_comments = [r['id'] for r in shown if (r['source'] or '') == 'hackernews'
                 and re.search(r'\b0 comments\b', (r['text'] or '') + (r['title'] or ''))]
check('no-zero-comments-label', not zero_comments, f"{len(zero_comments)} HN cards claim '0 comments'")


search_urls = [r['id'] for r in shown if r['type'] == 'tweet' and 'search?q=' in (r['url'] or '')]
check('no-search-url-taps', not search_urls, f"{len(search_urls)} shown tweets still open x.com search")









def _fallback_contract_error(r):
    try:
        metadata = json.loads(r['metadata'] or '{}')
    except Exception:
        return 'invalid metadata JSON'
    if metadata.get('freshnessFloor') is not True:
        return None
    shipment = metadata.get('shipment')
    interest = metadata.get('interest')
    if not isinstance(shipment, dict) or shipment.get('decision') != 'ship':
        return 'missing explicit ship decision'
    rank = shipment.get('rank')
    if isinstance(rank, bool) or not isinstance(rank, (int, float)) or not 0 <= rank <= 1:
        return 'invalid agent rank'
    reason = shipment.get('reason')
    if (not isinstance(reason, str) or not reason.strip() or len(reason.strip()) > 200
            or '\n' in reason or '\r' in reason):
        return 'invalid public reason'
    if not isinstance(interest, dict) or interest.get('score') != rank or interest.get('reason') != reason:
        return 'shipment and displayed interest judgment disagree'
    shipment_id = shipment.get('id')
    if not isinstance(shipment_id, str) or not shipment_id.startswith('shipment-'):
        return 'missing stable shipment identity'
    return None


invalid_fallback = [(r['id'], error) for r in primary
                    if (error := _fallback_contract_error(r)) is not None]
check('explicit-shipment-judgment-primary', not invalid_fallback,
      f"{len(invalid_fallback)} fallback items lack a valid runtime-agent shipment contract")





flow_dead = []
flow_detail = []
for r in db.execute("""
    SELECT source,
      SUM(CASE WHEN fetched_at_ms > :d1 THEN 1 ELSE 0 END) last24,
      SUM(CASE WHEN fetched_at_ms BETWEEN :d8 AND :d1 THEN 1 ELSE 0 END) prior7
    FROM browse_cache_items GROUP BY source""",
        {"d1": now_ms - 86400_000, "d8": now_ms - 8 * 86400_000}).fetchall():
    norm = (r['prior7'] or 0) / 7.0
    last24 = r['last24'] or 0
    flow_detail.append(f"{r['source']}={last24}/24h(norm {norm:.0f})")
    if norm >= 3 and last24 < max(1, norm * 0.25):
        flow_dead.append(f"{r['source']} ({last24} vs norm {norm:.0f}/day)")
check('sources-flowing', not flow_dead,
      ('STARVED: ' + ', '.join(flow_dead)) if flow_dead else '; '.join(flow_detail))





for _pf in ('curation-prompt.md', 'interestingness-rubric.md', 'preferences-context.md'):
    _live = os.path.expanduser(f'~/evogent/data/{_pf}')
    _default = os.path.expanduser(f'~/evogent/data/{_pf.replace(".md", ".default.md")}')
    if os.path.exists(_live) and os.path.exists(_default):
        _ls, _ds = os.path.getsize(_live), os.path.getsize(_default)
        if _ds > 2000 and _ls < _ds / 3:
            check(f'promptfile-{_pf}', False,
                  f'{_pf} is {_ls}B vs default {_ds}B — likely truncated; curator running on partial instructions')






import glob as _glob
_tools = os.path.expanduser('~/phone-tools')
_cycle = os.path.join(_tools, 'evogent-cycle.sh')
missing_steps = []
if os.path.exists(_cycle):
    _txt = open(_cycle).read()
    for m in re.finditer(r'(?:python3|bash)\s+"?\$TOOLS/([A-Za-z0-9_.-]+)"?', _txt):
        f = os.path.join(_tools, m.group(1))
        if not (os.path.exists(f) and os.path.getsize(f) > 0):
            missing_steps.append(m.group(1))

for _rf in _glob.glob(os.path.expanduser('~/evogent/data/phone-sources/*.py')) + _glob.glob(os.path.expanduser('~/evogent/data/phone-sources/*.txt')):
    if not (os.path.exists(_rf) and os.path.getsize(os.path.realpath(_rf)) > 0):
        missing_steps.append('phone-sources/' + os.path.basename(_rf) + ' (broken)')
check('cycle-steps-exist', not missing_steps,
      ('missing/empty cycle steps: ' + ', '.join(sorted(set(missing_steps)))) if missing_steps else 'all cycle-invoked scripts present')






import subprocess as _sp
def _rish(cmd):
    try:
        return _sp.run([os.path.expanduser('~/rish-bin/rish'), '-c', cmd], capture_output=True,
                       text=True, timeout=20, env={**os.environ, 'RISH_APPLICATION_ID': 'com.termux'}).stdout
    except Exception:
        return ''
_manifest = [
    ('feature-overlay-permission', 'appops get net.dangish.evogent SYSTEM_ALERT_WINDOW', 'allow',
     'anywhere-bubble dead: SYSTEM_ALERT_WINDOW not granted (reinstall resets it; a11y-heal re-grants)'),
    ('feature-home-role', 'cmd role get-role-holders --user 0 android.app.role.HOME', 'net.dangish.evogent',
     'Evogent is not the HOME app (reinstall drops the role; cmd role add-role-holder)'),
    ('feature-a11y-service', 'settings get secure enabled_accessibility_services', 'evogent',
     'accessibility service disabled — every browse and the overlay driver are dead'),
]
for _name, _probe, _want, _why in _manifest:
    _out = _rish(_probe)
    if _out:  # probe answered: judge it. No answer = rish transient, skip rather than false-alarm.
        check(_name, _want in _out, _why)

status = 'FAIL' if failures else ('WARN' if warnings else 'PASS')
print(f"verify-intents: {status} | " + " | ".join(f"{k}={'ok' if v['ok'] else 'X'}" for k, v in report.items()))
for f in failures:
    print(f"  FAIL {f}")
for w in warnings:
    print(f"  warn {w}")


if failures:
    body = {"items": [{"type": "notification", "source": "phone", "sourceId": "intent-verify-fail",
            "title": f"Feed quality check failed ({len(failures)})",
            "text": "Automated intent verification found regressions: " + "; ".join(failures)[:400],
            "metadata": {"notificationId": "intent-verify-fail", "severity": "warning"}}]}
    try:
        post_json(f"{BASE}/api/internal/curate/submit", json.dumps(body).encode(), timeout=10)
    except Exception:
        pass
sys.exit(1 if failures else 0)

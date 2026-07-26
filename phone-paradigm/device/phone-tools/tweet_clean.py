#!/data/data/com.termux/files/usr/bin/env python3
# Shared tweet-text hygiene for the phone paradigm. X's accessibility `desc` mashes a quote
# tweet into one string: "[Aff.] Quoted. <QName> @<qh> Verified[ Aff]. <qtext> [pic.x.com/x]
# [<MName> @<mh> Verified.] Added <comment>". Rendered raw, cards read like node dumps.
# This rebuilds them readably and strips media/link
# scaffolding. Imported by browse-x-scrape.py at capture time; run as __main__ to retroactively
# clean tweet rows already in the DB (feed + browse_cache_items).
#
# Enriched tweets prefer the syndication `full_text` (already clean) — this is the a11y fallback.
import hashlib
import html
import re
import unicodedata

_LINK = [
    (re.compile(r'\bpic\.(?:x|twitter)\.com/\S+'), ''),
    (re.compile(r'https?://t\.co/\S+'), ''),
    (re.compile(r'\b(?:x|twitter)\.com/i/(?:article|web|status)/\S+'), ''),
]
_QUOTE = re.compile(r'\bQuoted\.\s+[^@]{0,50}@([A-Za-z0-9_]{1,15})\s+Verified(?:\s+[A-Z][\w.]{1,18})?\.?\s*(.*)', re.S)
_ADDED = re.compile(r'\bAdded\s+(.*)', re.S)
_MAIN_HEADER = re.compile(r'\s*[A-Z][^@]{0,45}@[A-Za-z0-9_]{1,15}\s+Verified(?:\s+[A-Z][\w.]*)?\.?\s*$', re.S)
_BADGE = re.compile(r'\b(?:Verified|Business)\b(?:\s+[A-Z][\w.]{1,18})?\.?\s*')

# Structured quote extraction. Two input shapes:
#  RAW a11y desc: "... own words ... Quoted. <QName> @<qh> [Verified.] <qtext> [Added <more own>]"
#    — captures the quoted author's DISPLAY NAME too (only available before clean_tweet_text runs).
#  CLEANED text:  "<own>\n\nQuoting @<qh>: <qtext>"  (what clean_tweet_text already produces)
#    — username only, used to retro-fix rows whose raw desc is long gone.
# X exposes quotes in TWO a11y formats (verified is optional in both; the old _QUOTE required
# it and silently dropped non-verified quotes):
#   OLD: "Quoted. <QName> @<qh> Verified. <qtext>"
#   NEW: "Quoted @<qh>: <qtext>"   (colon after the handle, no display name)
# POLICY: do NOT grow this regex for the next format change. Fresh captures get their quote
# structure from browse-x-scrape's brain pass (quotedHandle/quotedText) and syndication; legacy
# rows this regex can't parse escalate to the brain in backfill-quote-tweets.py. This stays as
# the free fast path for the formats it already knows.
_QUOTE_RAW = re.compile(
    r'\bQuoted[.:]?\s+'                     # "Quoted." / "Quoted:" / "Quoted "
    r'(?:([^@:]{1,60}?)\s+)?'               # optional quoted display name (OLD only)
    r'@([A-Za-z0-9_]{1,15})\b\s*:?\s*'      # @qhandle, optional colon (NEW)
    r'(?:Verified\b[^.]*?\.\s*)?'           # optional "Verified." (OLD)
    r'(.*)', re.S)                          # qtext + trailing
_QUOTING_CLEAN = re.compile(r'(.*?)\bQuoting @([A-Za-z0-9_]{1,15}):\s*(.*)', re.S)
# The quoted text is followed by the main tweeter's re-header ("<MainName> @<mainhandle>") right
# before "Added <comment>"; strip that trailing header off the quoted text.
_TRAIL_HEADER = re.compile(r'\s+\S[^.!?]{0,48}?@[A-Za-z0-9_]{1,15}\s*$')
# A "<n> ago. <n> replies. ..." metrics/time tail sometimes trails the quoted text — cut it.
_METRICS_TAIL = re.compile(r'\s*\d[\d,]*\s+(?:repl(?:y|ies)|reposts?|likes|(?:verified\s+)?views)\b.*$', re.I | re.S)
_AGO_TAIL = re.compile(r'\s*\d+\s+(?:second|minute|hour|day|week|month)s?\s+ago\b.*$', re.I | re.S)


def _clean_quoted_text(q):
    for rx, repl in _LINK:
        q = rx.sub(repl, q)
    q = _MAIN_HEADER.sub('', q)     # a trailing main-tweet header sometimes rides along (OLD fmt)
    q = _TRAIL_HEADER.sub('', q)    # NEW fmt: strip the main tweeter's "<name> @handle" re-header
    q = _BADGE.sub('', q)
    q = _AGO_TAIL.sub('', q)
    q = _METRICS_TAIL.sub('', q)
    q = re.sub(r'[ \t]+', ' ', q)
    return q.strip(' .—\n')


def extract_quote(text):
    """Split a quote tweet into (own_comment, quoted_dict|None). own_comment is the tweeter's own
    words; quoted_dict is {author:{username[, displayName]}, text} — the shape the card renders as a
    sub-card instead of the raw mashed string. Works on a RAW a11y desc or on already-cleaned text.
    Returns (text, None) unchanged when there is no quote."""
    if not text:
        return text, None
    m = _QUOTE_RAW.search(text)
    if m:
        own = text[:m.start()].strip()
        qname, qh, rest = (m.group(1) or '').strip(), m.group(2), m.group(3)
        am = _ADDED.search(rest)
        if am:  # "Added ..." is the tweeter's own words, appended after the quote
            own = (own + ' ' + am.group(1)).strip() if own else am.group(1).strip()
            rest = rest[:am.start()]
        qtext = _clean_quoted_text(rest)
        own = _BADGE.sub('', own).strip(' .—\n')
        if len(qtext) >= 3:
            q = {'author': {'username': qh}, 'text': qtext[:500]}
            if qname and 1 <= len(qname) <= 50 and '@' not in qname:
                q['author']['displayName'] = qname
            return own, q
    m = _QUOTING_CLEAN.search(text)
    if m:
        own, qh, qtext = m.group(1).strip(), m.group(2), _clean_quoted_text(m.group(3))
        if len(qtext) >= 3:
            return own, {'author': {'username': qh}, 'text': qtext[:500]}
    return text, None


def clean_tweet_text(text):
    if not text:
        return text
    t = text
    for rx, repl in _LINK:
        t = rx.sub(repl, t)
    m = _QUOTE.search(t)
    if m:
        qh, rest = m.group(1), m.group(2)
        am = _ADDED.search(rest)
        if am:
            comment = am.group(1).strip()
            qtext = _MAIN_HEADER.sub('', rest[:am.start()]).strip()
            t = f"{comment}\n\nQuoting @{qh}: {qtext}" if qtext else comment
        else:
            t = f"Quoting @{qh}: {rest.strip()}"
    t = _BADGE.sub('', t)
    t = re.sub(r'\bQuoted\.\s*', '', t)   # residual marker with no parseable quote structure
    t = re.sub(r'[ \t]+', ' ', t)
    t = re.sub(r'\s*\n\s*', '\n', t)
    return t.strip(' .—\n')


def stable_provisional_source_id(handle, text):
    """Return one process-independent identity for an X item without a status id."""
    identity = '\0'.join((
        str(handle or '').strip().casefold(),
        str(text or '').strip(),
    )).encode('utf-8')
    return f'x-provisional-{hashlib.sha256(identity).hexdigest()[:20]}'


def _identity_tokens(value):
    normalized = unicodedata.normalize('NFKC', html.unescape(str(value or ''))).casefold()
    return re.findall(r"[a-z0-9]+(?:['’][a-z0-9]+)?", normalized)


def _has_content_identity(candidate, canonical):
    """Require a literal word run, not merely the same author or a fuzzy score."""
    candidate_tokens = _identity_tokens(candidate)
    canonical_tokens = _identity_tokens(canonical)
    if not candidate_tokens or not canonical_tokens:
        return False
    if len(candidate_tokens) < 4:
        return (
            len(' '.join(candidate_tokens)) >= 8
            and candidate_tokens == canonical_tokens
        )
    canonical_text = ' '.join(canonical_tokens)
    for width in range(min(8, len(candidate_tokens)), 3, -1):
        for start in range(0, len(candidate_tokens) - width + 1):
            phrase = ' '.join(candidate_tokens[start:start + width])
            if phrase in canonical_text:
                return True
    return False


def syndication_matches_tweet(tweet, syndication, tapped_phrase=None):
    """Fail closed unless an X status response matches both known author and body.

    A handle match alone is not identity: one author commonly has several visible posts.
    The exact phrase used for the tap is strongest, followed by the captured own-body text.
    """
    if not isinstance(tweet, dict) or not isinstance(syndication, dict):
        return False
    canonical_text = syndication.get('text')
    user = syndication.get('user')
    actual_handle = user.get('screen_name') if isinstance(user, dict) else None
    if not isinstance(canonical_text, str) or not canonical_text.strip():
        return False
    if tweet.get('handleKnown'):
        expected_handle = str(tweet.get('handle') or '').strip().casefold()
        if (
            not expected_handle
            or not isinstance(actual_handle, str)
            or actual_handle.strip().casefold() != expected_handle
        ):
            return False
    for candidate in (tapped_phrase, tweet.get('text')):
        if isinstance(candidate, str) and _has_content_identity(candidate, canonical_text):
            return True
    return False


def visible_tap_targets(tweet, tree):
    """Find literal body phrases for a tweet that are present in one live a11y tree.

    The source text may later be cleaned for display, so callers should preserve ``tapText`` as
    the verbatim capture. Returning only byte-for-byte-visible phrases lets deterministic phone
    mechanics tap a real node without fuzzy coordinates or an invented author handle.
    """
    if not isinstance(tweet, dict) or not isinstance(tree, str) or not tree:
        return []
    phrases = []
    # Prefer the cleaned outer body. Raw a11y text can include a quoted post; tapping that
    # descendant may correctly open the quote but would yield the wrong id for the outer item.
    for source in (tweet.get('text'), tweet.get('frag'), tweet.get('tapText')):
        if not isinstance(source, str):
            continue
        source = source.strip()
        if not source:
            continue
        spans = [
            match.group(0).strip()
            for match in re.finditer(r"[A-Za-z0-9][A-Za-z0-9'’.,!?;:()&+\-/ ]{13,54}", source)
        ]
        ordered = []
        if spans:
            ordered.extend((spans[len(spans) // 2], spans[-1], spans[0]))
        ordered.append(source)
        for span in ordered:
            words = span.split()
            if len(words) < 3:
                continue
            windows = []
            for width in (7, 6, 5, 4, 3):
                if len(words) < width:
                    continue
                starts = [max(0, (len(words) - width) // 2), len(words) - width, 0]
                windows.extend(' '.join(words[start:start + width]) for start in starts)
            for candidate in windows:
                candidate = candidate.strip()
                if (
                    len(candidate) >= 14
                    and candidate in tree
                    and not candidate.lower().startswith(('http://', 'https://'))
                    and candidate not in phrases
                ):
                    phrases.append(candidate)
                    if len(phrases) >= 5:
                        return phrases
    return phrases


if __name__ == '__main__':
    import os, sqlite3
    db = sqlite3.connect(os.path.expanduser('~/evogent/data/media-agent.db'))
    db.row_factory = sqlite3.Row
    changed = 0
    # feed rows
    for r in db.execute("SELECT id, text FROM feed WHERE type='tweet' AND text IS NOT NULL").fetchall():
        cleaned = clean_tweet_text(r['text'])
        if cleaned and cleaned != r['text']:
            db.execute("UPDATE feed SET text=? WHERE id=?", (cleaned, r['id']))
            changed += 1
    # cache payloads (so re-promotion uses clean text)
    for r in db.execute("SELECT source_id, payload_json FROM browse_cache_items WHERE source='twitter'").fetchall():
        try:
            import json
            p = json.loads(r['payload_json'] or '{}')
        except Exception:
            continue
        txt = p.get('text')
        cleaned = clean_tweet_text(txt) if txt else txt
        if cleaned and cleaned != txt:
            p['text'] = cleaned
            db.execute("UPDATE browse_cache_items SET payload_json=? WHERE source_id=?",
                       (json.dumps(p, ensure_ascii=False), r['source_id']))
            changed += 1
    # Deduplicate the slate: the same tweet can be captured under a search-url sourceId and a
    # permalink sourceId. Keep the structurally stronger identity; this is identity cleanup,
    # never an editorial account, language, popularity, or age decision.
    shown = db.execute(
        "SELECT id, author_username, substr(text,1,60) AS tp, url, source_id, display_order "
        "FROM feed WHERE type='tweet'").fetchall()
    groups = {}
    for r in shown:
        groups.setdefault((r['author_username'], r['tp']), []).append(r)
    deduped = 0
    for key, rows in groups.items():
        if len(rows) < 2:
            continue
        def rank(r):
            has_perma = bool(re.search(r'/status/\d+', r['url'] or '')) or bool(
                re.match(r'^\d{15,}$', r['source_id'] or ''))
            return (1 if has_perma else 0, -(r['display_order'] or 9999))
        keep = max(rows, key=rank)
        for r in rows:
            if r['id'] != keep['id']:
                db.execute("DELETE FROM interactions WHERE feed_item_id=?", (r['id'],))
                db.execute("DELETE FROM thread_feedback WHERE feed_item_id=?", (r['id'],))
                db.execute("DELETE FROM feed WHERE id=?", (r['id'],))
                deduped += 1
    db.commit()
    print(f"tweet_clean: rewrote {changed} rows, deduped {deduped} tweet identities")

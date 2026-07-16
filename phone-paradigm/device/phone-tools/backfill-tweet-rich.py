#!/data/data/com.termux/files/usr/bin/env python3
# Backfill rich-card data (photos, avatar, quoted tweet, untruncated text) onto feed tweets that
# already have a real /status/ permalink but shipped before syndication enrichment existed.
# Idempotent: skips rows that already have media+avatar+quote. Run per cycle; cheap (one HTTPS
# fetch per un-enriched permalinked tweet, hard-capped per run).
import json, math, os, re, sqlite3, sys, urllib.request

DB = os.path.expanduser('~/evogent/data/media-agent.db')
CAP = 25


def synd_token(tweet_id):
    x = (int(tweet_id) / 1e15) * math.pi
    chars = "0123456789abcdefghijklmnopqrstuvwxyz"
    whole = int(x); s = ""; n = whole
    if n == 0: s = "0"
    while n:
        s = chars[n % 36] + s; n //= 36
    frac = x - whole; f = ""
    for _ in range(11):
        frac *= 36; d = int(frac); f += chars[d]; frac -= d
    return (s + "." + f).replace(".", "").replace("0", "")


def fetch(tweet_id):
    url = f"https://cdn.syndication.twimg.com/tweet-result?id={tweet_id}&lang=en&token={synd_token(tweet_id)}"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=8) as r:
            return json.loads(r.read().decode())
    except Exception:
        return None


db = sqlite3.connect(DB)
db.row_factory = sqlite3.Row
rows = db.execute("""
    SELECT id, url, text, media_urls, author_avatar_url, metadata
    FROM feed
    WHERE type='tweet' AND url LIKE '%/status/%'
      AND (author_avatar_url IS NULL OR author_avatar_url=''
           OR media_urls IS NULL OR media_urls='[]'
           OR metadata IS NULL OR metadata NOT LIKE '%quotedTweet%')
""").fetchall()

done = 0
enriched = 0
for r in rows:
    if done >= CAP:
        break
    m = re.search(r'/status/(\d+)', r['url'] or '')
    if not m:
        continue
    done += 1
    data = fetch(m.group(1))
    if not data:
        continue
    sets, args = [], []
    photos = [p.get('url') for p in (data.get('photos') or []) if isinstance(p, dict) and p.get('url')]
    poster = (data.get('video') or {}).get('poster')
    if poster and not photos:
        photos = [poster]
    if photos and (not r['media_urls'] or r['media_urls'] == '[]'):
        sets.append('media_urls=?'); args.append(json.dumps(photos))
    avatar = (data.get('user') or {}).get('profile_image_url_https')
    if avatar and not r['author_avatar_url']:
        sets.append('author_avatar_url=?'); args.append(avatar)
    full = data.get('text')
    if isinstance(full, str) and len(full.strip()) > len(r['text'] or ''):
        sets.append('text=?'); args.append(full.strip())
    q = data.get('quoted_tweet') or {}
    if isinstance(q, dict) and q.get('text'):
        try:
            meta = json.loads(r['metadata'] or '{}')
        except Exception:
            meta = {}
        if not meta.get('quotedTweet'):
            qu = q.get('user') or {}
            meta['quotedTweet'] = {
                'id': q.get('id_str'),
                'text': q.get('text'),
                'author': {'username': qu.get('screen_name') or '', 'displayName': qu.get('name') or '',
                           'avatarUrl': qu.get('profile_image_url_https') or ''},
                **({'url': f"https://x.com/{qu['screen_name']}/status/{q['id_str']}"}
                   if q.get('id_str') and qu.get('screen_name') else {}),
            }
            sets.append('metadata=?'); args.append(json.dumps(meta, ensure_ascii=False))
    if sets:
        args.append(r['id'])
        db.execute(f"UPDATE feed SET {', '.join(sets)} WHERE id=?", args)
        enriched += 1
db.commit()
print(f"backfill-tweet-rich: checked {done}, enriched {enriched} of {len(rows)} candidates")

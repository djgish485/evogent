---
name: phone-browse
description: Browse the phone's real, logged-in apps IN THE BACKGROUND with on-device computer use (hidden display), read what's on screen, and extract content. Use whenever the user asks Evogent to look at or browse a phone app (Gmail, YouTube, Twitter, Reddit, etc.) on this device.
user-invocable: true
---
# Phone Browse (background, fully on-device — no adb)

Drive the user's real logged-in apps the way a person would — open the app, read the screen,
tap — but on a **hidden second display** so the user's actual screen never changes. The physical
screen (display 0) keeps showing the Evogent feed the entire time; the app you're driving runs
invisibly on a virtual display. This is how Evogent reads apps that have no API or are only logged
in on the phone, **without interrupting the user**.

## The toolkit: `~/phone-tools/phone.sh`

Everything goes through one helper (it talks to Evogent's Shizuku UserService to make/own the
hidden display, and to Evogent's accessibility service to see and act, over a local loopback —
you are in Termux, a different app uid, so this is the only way to reach the app's screen):

```
~/phone-tools/phone.sh launch <pkg>      # open <pkg> on a hidden display; remembers the display id
~/phone-tools/phone.sh see               # print the node tree (exact text) of that display
~/phone-tools/phone.sh tap "<text>"      # tap the element whose text/description contains <text>
~/phone-tools/phone.sh scroll            # scroll the list forward, then `see` again
~/phone-tools/phone.sh swipe-rel x1 y1 x2 y2 # per-thousand display ratios for portable gestures
```

Common packages: Gmail `com.google.android.gm`, YouTube `com.google.android.youtube`,
Twitter/X `com.twitter.android`, Reddit `com.reddit.frontpage`, Chrome `com.android.chrome`.

## The loop

1. `phone.sh launch <pkg>` — opens the app on a hidden display (prints its id). Give it the ~8s it
   already waits.
2. `phone.sh see` — read the node tree. This is the semantic screen: exact titles, senders,
   subjects, view counts, authors — richer than a screenshot. **Decide from what you actually see,
   never guess.**
3. Act if needed: `phone.sh tap "Share"`, `phone.sh scroll`, etc. Wait, then `see` again.
4. Repeat until you have what the user asked for.

The inbox/feed rows come back as one node per item, newest first, e.g.
`ViewGroup text="Unread, , , <sender>, , <subject>, <preview>, , at <time>" [clickable]` — parse the
sender / subject / time out of that. To open an item, `phone.sh tap "<a distinctive word from it>"`.

## Verify you stayed in the background

You never touch display 0. If you want to be sure, the app should show up on a non-zero display in
`phone.sh see`'s `NODES display=<id>` header — that id is not 0.

## What to do with what you read

- If the user just asked a question ("what's my latest email", "overview my inbox"), read the
  screen and answer — no caching needed.
- If you're gathering **content** for the feed (YouTube/Twitter/Substack items), do NOT post to the
  feed. Fill the browse cache the curator reads: use `~/phone-tools/evo-curl` to POST to
  `http://127.0.0.1:${PORT:-3001}/api/internal/browse-cache/submit`
  with `source` = the base source name (`youtube`/`twitter`/`substack`), `triggeredBy:"phone-browse-chat"`,
  and each item needing `sourceId`, `fetchedAtMs`, `expiresAtMs`, `payload`. The curator decides what
  reaches the feed — every feed item is a curator decision.

## Prerequisites (already set up on this device; only re-check if `launch` fails)

- Evogent accessibility service enabled, and Shizuku running (`ps -A | grep shizuku_server`) with
  Evogent authorized. If `launch` prints an error about no display, Shizuku is probably down.

---
name: phone-browse
description: Browse the phone's real, logged-in apps IN THE BACKGROUND with on-device computer use (hidden display -> screenshot -> tap), extract feed-worthy content, and fill the browse cache the curator reads. Use when the user asks Evogent to browse a phone app (YouTube, Gmail, Twitter, Reddit, etc.) and pull items into their feed.
user-invocable: true
metadata:
  evogent:
    heartbeat-task: false
    feed-source: phone
    feed-source-label: Phone
---
# Phone Browse (background, on-device computer use)

Drive the user's real logged-in apps the way a person would — look at the screen, decide, tap —
but on a HIDDEN second display so the user's actual screen never changes. This is how Evogent
reads apps that have no API or that are only logged in on the phone, without interrupting the
user. Your job is to fill the **browse cache**; the curator decides what reaches the feed
(every feed item is a curator decision — never post browsed content straight to the feed).

## Why a hidden display

The physical screen (display 0) shows the Evogent home feed. If you drive apps there, the user
sees it flicker and lose their place. Instead you create an invisible second display, launch the
target app onto *that*, and drive it — display 0 is never touched. The Evogent app itself
provides the two things a normal app can't do (make a trusted hidden display, launch another app
onto it) via Shizuku, and provides the "eyes" (screenshot a hidden display) via its accessibility
service, because `screencap -d` cannot read a virtual display.

## Prerequisites (the phone's baseline; verify once)

- Device attached over adb (`adb devices`; serial is usually `emulator-5554`).
- Evogent's accessibility service is enabled:
  `adb shell dumpsys accessibility | grep -qi 'label=Evogent' && echo ok`
  (if not: `adb shell settings put secure enabled_accessibility_services net.dangish.evogent/.EvogentAccessibilityService && adb shell settings put secure accessibility_enabled 1`, then relaunch Evogent home).
- Shizuku is running and Evogent is authorized (`adb shell 'ps -A | grep shizuku_server'`). If a
  Shizuku permission dialog appears the first time, it must be approved once (tap "Allow all the time").
- Read the control token once — the accessibility ops are gated by a per-install secret so no
  other app can drive the phone through Evogent:
  `TOKEN=$(adb shell run-as net.dangish.evogent cat files/control-token.txt 2>/dev/null || adb pull /storage/emulated/0/Android/data/net.dangish.evogent/files/control-token.txt /tmp/evo-tok >/dev/null 2>&1 && cat /tmp/evo-tok)`
  Pass `--es token "$TOKEN"` on **every** `A11Y` broadcast below (shot/clicktext/gesture).

## Step 1 — open the target app on a hidden display

Tell the Evogent app to create a hidden trusted display and launch the app onto it (it force-stops
any foreground instance first so a fresh copy lands on the hidden display):

```
adb shell "am broadcast -a net.dangish.evogent.SHIZUKU --es op launch --es pkg <package> --es token $TOKEN"
```

Common packages: YouTube `com.google.android.youtube`, Gmail `com.google.android.gm`,
Twitter/X `com.twitter.android`, Reddit `com.reddit.frontpage`, Chrome `com.android.chrome`.
(You may pass `--es activity <fully.qualified.Activity>`; if omitted the launcher activity is resolved.)

Then read the display id it created:

```
adb logcat -d -s EvoShizuku | grep -oE 'hidden display ready id=[0-9]+' | tail -1
```

Call that number `D`. Give the app ~6-8s to render before the first screenshot.

## Step 2 — the loop (repeat until you have what you need)

1. **See** — screenshot the HIDDEN display via the accessibility service (not `screencap`), then
   pull and Read it:
   ```
   adb shell "am broadcast -a net.dangish.evogent.A11Y --es op shot --ei display D --es name step --es token $TOKEN -p net.dangish.evogent"
   sleep 1
   adb pull /storage/emulated/0/Android/data/net.dangish.evogent/files/step.png /tmp/evo-step.png
   ```
   Then **Read `/tmp/evo-step.png`** — never guess what's on screen.
2. **Decide** the single next action from what you see. Coordinates are real device pixels,
   1080x2400, origin top-left.
3. **Act on display D** (never on display 0):
   - tap: `adb shell input -d D tap <x> <y>`
   - scroll: `adb shell input -d D swipe 540 1800 540 500 250`
   - type: `adb shell input -d D text "your%stext"` (`%s` = space)
   - back / enter: `adb shell input -d D keyevent KEYCODE_BACK` / `KEYCODE_ENTER`
   - tap a labelled control by its text (robust vs. exact pixels):
     `adb shell "am broadcast -a net.dangish.evogent.A11Y --es op clicktext --ei display D --es text 'Share' --es token $TOKEN"`
4. Wait ~1.5s after an action before the next screenshot so the UI settles.
5. Dismiss first-run / consent dialogs if any appear.

Because everything targets display D, `adb shell dumpsys activity activities | grep -A2 'Display: mDisplayId=0'`
should still show `net.dangish.evogent/.MainActivity` resumed the whole time — confirm the user's
screen never changed.

## Getting real, linkable content (no APIs — pure computer use)

Read titles/authors/counts off the screenshots. To capture a real, canonical link for an item,
use the app's own Share to Evogent (Evogent is a registered share target; it captures the real
URL and files it to the cache): drive `<item> ⋮/Share → More → Evogent` on display D via
`clicktext`. For YouTube specifically this is proven: `clicktext 'Action menu' → 'Share' → 'More'
→ 'Evogent'`. For apps whose share doesn't carry a clean URL (Gmail), read the sender/subject/body
off the screenshot and submit those fields directly (below).

## Submitting to the browse cache (the curator reads this, then decides)

Fill the cache — do NOT post to the feed. Use the **base source name the curator already reads**
(`youtube`, `twitter`, `substack`, `hackernews`), NOT a `<app>-phone` suffix: `curate.md` reads
`GET browse-cache/items?source=youtube` per installed source skill, so a suffixed source is
silently ignored and never curated. Acquisition method stays diagnosable via `triggeredBy` and the
per-item `payload.captureMethod`. (Gmail is different — it's a life-admin source, not a content
source; cache it as `source:"gmail"` for the life-admin sweep, and don't expect it in the content feed.)

```
NOW=$(($(date +%s)*1000))
~/phone-tools/evo-curl -s -X POST http://127.0.0.1:${PORT:-3001}/api/internal/browse-cache/submit -H 'content-type: application/json' -d '{
  "source":"youtube","triggeredBy":"phone-browse-chat",
  "startedAtMs":'"$NOW"',"completedAtMs":'"$NOW"',"status":"completed","itemsAdded":1,
  "items":[{
    "sourceId":"<stable id, e.g. the video id / tweet id / gmail message id>",
    "url":"<canonical url if you have one>","title":"<title/subject>",
    "authorUsername":"<channel/handle/sender>",
    "fetchedAtMs":'"$NOW"',"expiresAtMs":'"$(($NOW+1209600000))"',
    "payload":{"type":"youtube","title":"<title>","url":"<url>","captureMethod":"phone-background-browse"}
  }]
}'
```

- Every item needs `sourceId`, `fetchedAtMs`, and `expiresAtMs` (14 days = `NOW+1209600000`), or the
  row is silently dropped.
- `payload` carries the rich content the curator reads; include `type` and whatever fields that
  source's card needs (youtube: title/url/thumbnail; email: sender/subject/snippet; tweet:
  text/author/url).
- The endpoint returns `{ "ok": true, ... }`. Cache rows are NOT visible in the feed until a
  curation cycle runs and selects them — that is intended; the curator owns the feed.

## When done

Report back (via the normal chat-submit path) what you browsed and how many items you cached, in
plain language — e.g. "Browsed YouTube in the background for AI news, cached 4 videos for your next
curation." Keep it short. Do NOT claim items are "in your feed" — say "cached for curation."

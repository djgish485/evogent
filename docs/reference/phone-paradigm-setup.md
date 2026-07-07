# Evogent Phone Paradigm — Architecture & Real-Device Setup

Evogent can run in two paradigms that share everything except *how content is gathered*:

- **VM paradigm** (original): a server drives an authenticated headless Chrome to browse the web
  (`tweet-cache`, `youtube-cache`, `substack-cache`, `hackernews-cache`), writing candidates into
  `browse_cache_items`. The curator reads that cache and decides what reaches the feed.
- **Phone paradigm**: Evogent, installed as the phone's home screen, browses the user's **real,
  logged-in apps in the background** (on a hidden display, via on-device accessibility + Shizuku)
  and writes candidates into the **same `browse_cache_items`**. The curator is byte-for-byte
  unchanged.

**The load-bearing principle:** the phone replaces only the *acquisition layer*. The curator, the
interestingness rubric, thread detection, tweet-majority / carry-forward / promotion-penalty /
durability-decay, and the proactive life-admin judgment are all paradigm-independent. Phone-gathered
rows MUST land under the **base source name the curator reads** (`youtube`, `twitter`, `substack`,
`hackernews`) — a `-phone` suffix is silently never curated (`curate.md` reads
`GET /api/internal/browse-cache/items?source=<source>` per installed source skill). Acquisition
method stays traceable via the run's `triggeredBy` and each item's `payload.captureMethod`.

## The moving parts (all in `android-shell/`)

| Piece | Role |
|---|---|
| `EvogentAccessibilityService` | the "eyes + hands": screenshot any display (`op=shot`, works on hidden displays where `screencap -d` can't), read the node tree, scroll (`op=gesture` with `setDisplayId`), tap-by-text (`op=clicktext`). Gated by a per-install control token. |
| `EvoPrivilegedService` (Shizuku UserService, shell uid) | the only privileged bit: create a **trusted, public, own-display-group** hidden virtual display (scrcpy's flag set — public + trusted + OWN_DISPLAY_GROUP/OWN_FOCUS, or the accessibility service can't see it) and launch an app onto it (`am start --display`). |
| `ShizukuController` + `IEvoPrivileged.aidl` | Evogent's own process binds the UserService via the Shizuku SDK and calls create-display + launch. Cable-free after a one-time pairing. |
| `BrowseService` + `BrowseAlarmReceiver` + `BootReceiver` | the autonomous loop: on a schedule (30-min `AlarmManager`, re-armed on boot), create a hidden display, launch a share-based app, drive its share-to-Evogent flow via accessibility, tear the display down. Config-driven (`pkg`/`activity`/`shareLabels`), not hardcoded. |
| `ShareReceiverActivity` | Evogent is a share target; when the loop shares an item, this captures the real URL and POSTs it to `browse-cache/submit` under the base source name. |
| `.claude/skills/phone-browse` | the chat-agent skill: browse any app in the background on demand (vision loop over the hidden display). |
| `.claude/skills/phone-life-admin` | proactive sweep translated to the phone: reads cached Gmail (`source=gmail`), reasons under the guardrails, emits `life_admin` suggestion cards. |

## One-time setup on a real Android device (recommended: a Pixel)

1. **Install Evogent** (`android-shell/build.sh` output APK) and set it as home:
   `adb shell cmd package set-home-activity net.dangish.evogent/.MainActivity`.
2. **Install Shizuku** (Play Store) and start it cable-free: enable Developer Options → Wireless
   Debugging, pair Shizuku once (6-digit code), tap Start. (Non-root: re-arm after each reboot —
   a few taps, or an Automate flow; root gives auto-start.)
3. **Enable Evogent's accessibility service** once in Settings → Accessibility (survives reboot).
   On Android 15 this is behind a one-time "Restricted Settings" unlock; on Android 17 keep
   Advanced Protection Mode off (it locks out non-`isAccessibilityTool` a11y services).
4. **Authorize Evogent for Shizuku** on first use (tap "Allow all the time").
5. The **control token** (`files/control-token.txt`) is generated on first accessibility connect; the
   chat-agent skill reads it to drive the phone. Nothing else needs it.

Then: nothing else changes. `BootReceiver` schedules the background browse; the curator runs with
your key and consumes the phone-gathered cache exactly as it consumed the VM cache.

## Source mapping (phone paradigm)

| Source | Phone acquisition | Notes |
|---|---|---|
| YouTube (`youtube`) | background browse of the YouTube app → share → cache | proven |
| Twitter/X (`twitter`) | background browse of the X app | **needs a real device** — emulators fail X's Play-Integrity device attestation at login |
| Substack (`substack`) | same share-based pattern as YouTube | |
| Hacker News (`hackernews`) | unchanged — public API, no phone needed | paradigm-independent |
| Gmail (`gmail`) | background read of the Gmail app → cache | a **life-admin** source (consumed by `phone-life-admin`), not a content-curator source |

## What the phone paradigm unlocks (vs the VM)

Zero auth plumbing (real logged-in sessions; no cookie transfer / datacenter-IP blocks); apps with
no API and anti-scraping (Instagram/TikTok/iMessage/LinkedIn); acting in-app (follow, RSVP,
quick-reply); cross-app workflows in one identity; notification-reactive browsing; direct taste
signals (real watch-time/scroll-back); location/time-aware curation.

## Known constraints / open design

- **Curator + life-admin reasoning** run an agent (your API key). They don't run in a keyless
  environment; they run on the phone/VM.
- **Twitter/X** requires a real (attestation-passing) device.
- **On-device approve-to-execute** for money-adjacent actions needs a restricted action vocabulary
  that structurally cannot reach a payment/credential screen — an open design item (unbuilt on the
  VM too), so don't wire phone execution for it yet.
- **Reliability risks to watch:** Android background-killing/doze of the browse service (surface it
  as a battery line item; whitelist it); UI-label fragility (`clicktext` breaks on app updates —
  verify each step landed); the large privacy surface (the phone sees everything on screen).

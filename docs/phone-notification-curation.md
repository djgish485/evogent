# Phone notification curation

Evogent treats the Android notification stream as another local attention
surface. The goal is not to imitate Android's notification ranking or send
private notification content to a model. It is to give the user one coherent,
reversible view of incoming attention while keeping safety-critical Android
behavior intact.

The first release is deliberately staged:

- **Observe** is the safe default. Evogent mirrors, redacts, deduplicates, and
  prioritizes locally, while every Android notification behaves normally.
- **Curated shade** is an explicit user choice that organizes the same local
  evidence while preserving every Android original by default. The user may
  separately allow best-effort replacement for an individual app. Protected
  notifications and user-preserved apps remain Android-owned regardless.
- **Paused** stops recording new notification content. Android remains
  unchanged.

These modes are available under Settings → Phone Alerts. The lock-screen preview
is private by default; the user may deliberately choose a detailed preview.
Per-app “always keep original” controls appear as apps are observed. Switching
back to Observe prevents subsequent replacement decisions and does not require a
migration; it cannot recall a key-only cancellation request Android has already
received. A separate, off-by-default per-app replacement list is explicit and
reversible.

## Local pipeline

1. Android invokes `EvogentNotificationListenerService` after a notification is
   posted. Listener access is all-or-nothing at the OS boundary.
2. One worker drains two independently bounded lanes and reads only basic
   textual extras and ranking state. Live `onNotificationPosted` callbacks
   always leapfrog reconnect history that is still queued, so an old active
   scan cannot head-of-line block new attention. Within the live lane, pending
   revisions with the same Android key are coalesced, the newest pending live
   callback is always selected next, and overflow evicts the oldest unprocessed
   live work. The one already in-flight item is not preempted. Historical
   completeness is best-effort; a full historical lane rejects additional
   history. Every coalesced, evicted, or rejected event remains in Android
   unless separately processed current work later satisfies the best-effort
   replacement preconditions and reaches a key-cancellation request. The
   service may still persist older live work after a newer digest, but a
   monotonic live sequence and successfully-applied-digest watermark prevent
   that older response from overwriting the shared digest or canceling its
   original. Newer protected events that never publish a digest do not
   unnecessarily suppress older eligible work. A pending same-key successor
   and a fresh active-generation check block known stale work. These checks
   narrow but cannot eliminate Android's final key-only cancellation race. The
   worker never opens an action `PendingIntent`, reads action payloads,
   inspects `RemoteViews`, copies attachments, or reads `MessagingStyle`
   message arrays.
3. The host-testable native policy ignores Evogent's own digest, classifies
   priority, identifies protected originals, and strips
   `VISIBILITY_SECRET`, known one-time-code, and safety content before a request
   is built. Raw notification keys and channel/conversation identifiers do not
   cross loopback; keyed event identity and channel identity are SHA-256
   digests.
4. The APK sends the bounded event to the release-pinned HTTPS listener using a
   fresh process-bound direct session. Shared Android loopback is transport, not
   identity. Challenge, completion, an optional gate retry, and ingest share one
   two-second monotonic notification deadline. Every socket read receives only
   the remaining budget, and a retry is rejected when too little budget remains.
   Deadline expiry preserves the original. Reusable WebView authentication and
   explicit share ingestion keep their existing, more patient timeout behavior.
5. The Node route independently validates and reclassifies the event. A light
   deterministic pass creates or updates a notification-lane item with a
   six-hour deduplication bucket, occurrence count, priority, expiry, and
   preservation reason. No runtime agent or external service receives the
   notification.
6. Content-app events that are neither sensitive nor conversational retain the
   existing short-lived browse-cache signal, so a new source notification can
   make that source due in the next normal scheduler-owned cycle without making
   notification text an editorial answer. A push does not start its own cycle
   or model call.
7. In Curated shade only, the server may return a suppression request for a
   package on the user's explicit replacement list. The native service requires
   that permission in the response, publishes Evogent's digest, verifies that
   Android exposes it as active, and recomputes the still-active original's event
   identity immediately before requesting cancellation by key. A process-wide
   service generation and work marker prevent an old service instance from
   owning newer digest work; invalid work retracts only its own exact digest
   marker.

The event receipt binds the package, opaque notification key, post time, and
every native suppression input. It detects stale responses and known replacements
before the cancellation request. Android's public listener API nevertheless
cancels by stable notification key; it offers no atomic “cancel only if this
version still matches” operation. An app can update the same key in the narrow
gap between the final read and Android processing the request. This is why
replacement is off by default, per-app, explicitly confirmed, described as
best-effort, and reversible. Observe is the zero-cancellation mode.

Before a cancellation request, a route error, unavailable server, invalid
response, persistence failure, denied notification-posting permission, disabled
digest channel, publication delay, queue overflow, service restart, expired
network deadline, or changed active generation preserves the original.

## Originals that remain Android-owned

Curated shade never suppresses:

- calls, alarms, emergency, navigation, transport, workout, or
  location-sharing notifications;
- foreground services, ongoing, insistent, non-clearable, or full-screen
  notifications;
- high-importance notifications or notifications whose ranking is unavailable;
- Android/System UI, phone, cell-broadcast, permission, and safety-center
  notifications;
- notification group summaries;
- secret or known one-time-code/password-reset notifications;
- apps the user marked “always keep original”; or
- every app not explicitly placed on the best-effort replacement list; or
- active notifications discovered during listener reconnection.

These events can still appear in Evogent's local notification lane, with secret
or safety text replaced by a generic protected-content notice. “Curated” means
Evogent has organized the attention event; it does not mean Android's required
surface is hidden.

## Lock-screen behavior and Android limits

Evogent can observe and cancel many ordinary notifications through
`NotificationListenerService`, and it can post its own digest after the user
grants Android 13+ notification permission. It cannot:

- intercept a notification before Android initially displays it;
- replace the Android lock screen or notification shade;
- control emergency surfaces, active calls, alarms, media controls,
  authentication UI, At a Glance, device-owner policy, or other System UI;
- guarantee cancellation of ongoing or OS-owned notifications; or
- atomically bind a key-only cancellation request to one notification update; or
- prevent an eligible original from appearing briefly before a listener
  callback completes.

The default digest uses `VISIBILITY_PRIVATE`: the secure lock screen shows only
“Curated notifications are ready,” while the unlocked shade may show the newest
eligible app summary. Detailed preview uses `VISIBILITY_PUBLIC` only after the
user chooses it. Evogent requests notification-posting permission once, only
after notification-listener access is already enabled; a denial is not nagged
and disables replacement rather than hiding originals.

## Private data and retention

Notification content, app labels, package names, occurrence counts, user mode,
and per-app choices are deployment-private:

- notification cards and receipts live in the on-phone SQLite database;
- settings live in the mode-`0600`, gitignored
  `data/phone-notification-curation.json`;
- ordinary cards expire after three days and high/critical cards after seven
  days unless normal feed lifecycle actions resolve them sooner;
- no content or device observation belongs in committed intent ledgers, build
  logs, Android logs, or public bug reports.

Public source contains only the generalized policy, tests, docs, and failure
classes. Android logs state outcomes without titles, bodies, package names,
notification keys, or response content.

## Verification

Automated checks must cover:

- native redaction before request construction;
- live-before-history order, newest-live priority, same-key coalescing,
  monotonic stale-response suppression, independent lane bounds, and overload
  preservation before any cancellation request;
- notification-only fail-fast loopback budgets without shortening WebView or
  explicit-share authentication;
- a single monotonic notification-network deadline, including gate-retry
  exhaustion and bounded response reads;
- independent server exemptions for every protected class;
- Observe as the default and explicit confirmation before Curated shade;
- Android-original preservation by default plus explicit, reversible per-app
  best-effort replacement permission;
- persistence and deduplication receipts;
- content-app browse-signal continuity;
- server failure, digest failure, missing permission, stale receipt, and changed
  generation preserving the original; and
- accessible controls for modes, lock-screen preview, and per-app preservation.

Physical verification uses benign synthetic notifications, not private content.
At the glass:

1. enable notification access, then verify the one-time Android posting request;
2. in Observe, post an ordinary notification and confirm both the unchanged
   Android original and the local Evogent card;
3. choose Curated shade and private preview, then post a fresh ordinary,
   clearable, normal-importance notification; confirm its Android original still
   remains and Evogent records the exact card;
4. explicitly allow best-effort replacement for only the benign fixture app,
   post another fixture, and confirm Evogent's generic locked preview and
   detailed unlocked digest; then revoke the app permission and prove the next
   original remains;
5. post call/alarm/high-importance/ongoing/secret fixtures and prove their
   originals remain;
6. disable Evogent notifications or stop the local server and prove an ordinary
   original remains;
7. rapidly replace a notification under one key and verify known stale work is
   rejected, while reporting the remaining key-only race rather than claiming an
   atomic guarantee;
8. return to Observe and prove replacement stops for subsequent events.

Never claim full lock-screen control from this test. Report the Android-owned
surfaces that remain outside notification-listener authority.

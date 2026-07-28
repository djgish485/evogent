# Phone notification curation

Evogent treats the Android notification stream as another local attention
surface. The goal is not to imitate Android's notification ranking or send
private notification content to a model. It is to give the user one coherent,
reversible view of incoming attention while keeping safety-critical Android
behavior intact.

The first release is deliberately staged:

- **Observe** is the safe default. Evogent mirrors, redacts, deduplicates, and
  prioritizes locally, while every Android notification behaves normally.
- **Curated shade** is an explicit user choice. Eligible ordinary
  notifications may be replaced by one Evogent digest, but only after the exact
  event has a durable local receipt and Android proves the digest is active.
- **Paused** stops recording new notification content. Android remains
  unchanged.

These modes are available under Settings → Phone Alerts. The lock-screen preview
is private by default; the user may deliberately choose a detailed preview.
Per-app “always keep original” controls appear as apps are observed. Switching
back to Observe is immediate and does not require a migration.

## Local pipeline

1. Android invokes `EvogentNotificationListenerService` after a notification is
   posted. Listener access is all-or-nothing at the OS boundary.
2. A bounded single worker reads only basic textual extras and ranking state.
   It never opens an action `PendingIntent`, reads action payloads, inspects
   `RemoteViews`, copies attachments, or reads `MessagingStyle` message arrays.
   Overload drops Evogent work and leaves the original untouched.
3. The host-testable native policy ignores Evogent's own digest, classifies
   priority, identifies protected originals, and strips
   `VISIBILITY_SECRET`, known one-time-code, and safety content before a request
   is built. Raw notification keys and channel/conversation identifiers do not
   cross loopback; keyed event identity and channel identity are SHA-256
   digests.
4. The APK sends the bounded event to the release-pinned HTTPS listener using a
   fresh process-bound direct session. Shared Android loopback is transport, not
   identity.
5. The Node route independently validates and reclassifies the event. A light
   deterministic pass creates or updates a notification-lane item with a
   six-hour deduplication bucket, occurrence count, priority, expiry, and
   preservation reason. No runtime agent or external service receives the
   notification.
6. Content-app events that are neither sensitive nor conversational retain the
   existing short-lived browse-cache signal, so a new source notification can
   wake the normal hint-free source/curation path without making notification
   text an editorial answer.
7. In Curated shade only, the server may return a suppression request. The
   native service first publishes Evogent's digest, verifies that Android exposes
   it as active, recomputes the still-active original's event identity, and then
   cancels only an exact match.

The event receipt binds the package, opaque notification key, post time, and
content generation. A response for an earlier post cannot cancel a replacement
that reused the same Android key. A route error, unavailable server, invalid
response, persistence failure, denied notification-posting permission, disabled
digest channel, publication delay, queue overflow, service restart, or changed
active generation always preserves the original.

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
- independent server exemptions for every protected class;
- Observe as the default and explicit confirmation before Curated shade;
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
   clearable, normal-importance notification; confirm Evogent's generic locked
   preview, detailed unlocked digest, and exact card;
4. post call/alarm/high-importance/ongoing/secret fixtures and prove their
   originals remain;
5. disable Evogent notifications or stop the local server and prove an ordinary
   original remains;
6. rapidly replace a notification under one key and prove a stale receipt cannot
   cancel the newest generation;
7. return to Observe and prove replacement stops immediately.

Never claim full lock-screen control from this test. Report the Android-owned
surfaces that remain outside notification-listener authority.

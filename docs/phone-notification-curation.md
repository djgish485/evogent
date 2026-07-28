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
  separately allow best-effort replacement for selected apps or explicitly
  confirm replacement for all eligible low-stakes apps. Protected notifications
  and user-preserved apps remain Android-owned regardless of that scope.
- **Paused** stops recording new notification content. Android remains
  unchanged.

These modes are available under Settings → Phone Alerts. The lock-screen preview
is private by default; the user may deliberately choose a detailed preview.
Per-app “always keep original” controls appear as apps are observed and override
both replacement scopes. Switching back to Observe prevents subsequent
replacement decisions and does not require a migration; it cannot recall a
key-only cancellation request Android has already received. Replacement starts
with the narrower, off-by-default per-app list. “All eligible low-stakes apps”
requires a separate explicit best-effort confirmation and still admits only the
exact native Android categories `promo`, `recommendation`, and `social`.
Each settings update synchronizes the temporary file, renames and locks the final
file to mode `0600`, then synchronizes that final inode and its parent directory
before reporting success. A returned revocation therefore survives a crash after
the response. One process-global mutex serializes the entire read, authority
check, merge, and durable replacement across route bundles, so a concurrent
unrelated PATCH cannot resurrect revoked authority.

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
   matching `onNotificationRemoved` callback synchronously retires in-flight,
   pending-live, and reconnect-history work for that Android key before any late
   loopback response can gain cancellation authority. The worker never opens an
   action `PendingIntent`, reads action payloads,
   inspects `RemoteViews`, copies attachments, or reads `MessagingStyle`
   message arrays.
3. The host-testable native policy ignores Evogent's own digest, classifies
   priority, identifies protected originals, and strips
   `VISIBILITY_SECRET`, known one-time-code, and safety content before a request
   is built. Eligibility is decided against the raw Android category before
   normalization; whitespace, control, case, missing, and future variants fail
   closed. The server also requires the native exact-wire proof and repeats the
   closed allowlist check. Raw notification keys and channel/conversation
   identifiers do not cross loopback; keyed event identity and channel identity
   are SHA-256 digests.
4. The APK sends the bounded event to the release-pinned HTTPS listener using a
   fresh process-bound direct session. Shared Android loopback is transport, not
   identity. Capture, app-private observation storage, challenge, completion, an
   optional gate retry, ingest, durable receipt storage, digest publication, and
   digest verification share one two-second monotonic end-to-end notification
   deadline. Every socket read receives only the remaining budget, and a retry
   is rejected when too little budget remains. Deadline expiry preserves the
   original. Reusable WebView authentication and explicit share ingestion keep
   their existing, more patient timeout behavior.
5. The Node route independently validates and reclassifies the event. A light
   deterministic pass creates or updates a notification-lane item with a
   six-hour deduplication bucket, occurrence count, priority, expiry, and
   preservation reason. Once a bucket has a curated event owner, that exact
   owner and disposition remain immutable: later same-bucket occurrences are
   recorded but their Android originals stay, and an older LIFO worker response
   cannot regress the owner, content, or display timestamp. A never-curated row
   may promote only its first strictly newer eligible owner. Its durable response
   never waits for best-effort WebSocket publication; clients reconcile from
   SQLite if that broadcast is late or lost. Exact event tombstones and dismissed
   deduplication buckets prevent an Android removal or user dismissal from being
   recreated by a racing or repeated ingest. The digest is rebuilt as a ranked
   native window of at most 32 active eligible event owners. Its `activeCount`
   equals that fully owned coverage set rather than the larger server-card total,
   and the response carries the earliest expiry among exactly those covered
   rows. Android uses that absolute deadline for a native timeout, so the digest
   disappears conservatively as soon as any represented card expires even when
   no later notification wakes the server. A later eligible ingest rebuilds any
   still-active remainder. Removing every covered event can also retract the
   native digest. A new identity that falls outside the window is durably demoted to
   `preserve_original`; it cannot drift into a later digest after other rows
   disappear. Additional local rows remain available in Evogent without being
   implied by the native count. The
   supported runtime-agent evidence APIs omit the notification and the
   deterministic ingest path calls no model or external service. This is an
   application-path rule, not isolation from a same-UID process that bypasses
   those APIs.
6. Content-app events that are neither sensitive nor conversational refresh one
   fixed, content-free marker at
   `data/source-due-signals/<canonical-source>.due`. The filename contains only
   the canonical source name; the file body is a constant marker and contains
   no title, text, subtext, package, app label, event identity, or account data.
   Reconnect-history events never refresh this marker.
   It never enters the browse cache or another model-facing candidate store.
   The next normal scheduler-owned cycle compares its modification time with a
   separate per-source acknowledgement of the browse-start generation most
   recently covered. Successful work records ordinary cadence at completion,
   then acknowledges only that captured start generation. A notification
   arriving during retrieval or post-processing therefore remains newer and
   due; a missing or invalid acknowledgement fails conservatively to due. A
   push does not start its own cycle or model call.
7. In Curated shade only, the server may return a suppression request within
   the user's explicit selected-app or all-eligible scope. The native service
   requires that exact permission in the response, durably records the exact
   identity-only receipt in the APK's app-private no-backup directory, publishes
   Evogent's aggregate digest, verifies that Android exposes the exact revision
   and coverage as active, and recomputes the still-active original's event
   identity immediately before requesting cancellation by key. A process-wide
   service generation and work marker prevent an old service instance from
   owning newer digest work; invalid current-service work retracts only its event
   contribution from the exact aggregate marker it owns.

The event receipt binds the package, opaque notification key, post time, and
every native suppression input. The server persists the content card while the
native app separately synchronizes only event digest, raw Android key, post
time, lifecycle state, and update time through `AtomicFile`; no title, body, app
label, or package enters that native ledger. Cancellation requires both durable
receipts, current aggregate coverage, current policy, and repeated exact
revision checks. Android's public listener API nevertheless cancels by stable
notification key; it offers no atomic “cancel only if this version still
matches” operation. An app can update the same key in the narrow gap between the
final read and Android processing the request. This is why replacement is off by
default, separately confirmed, described as best-effort, and reversible.
Observe is the zero-cancellation mode.

Removal is content-free. Native retires matching work immediately and persists a
pending event-digest tombstone until the server acknowledges the exact event.
Pending removals replay in bounded batches when the listener reconnects and
after later successful loopback traffic, without a polling wakeup. An expected
automatic cancellation keeps its event represented in the aggregate digest; an
Android/app withdrawal or an exact user dismissal removes that coverage,
retracting the digest when empty. The native count and coverage have the same
bound, so an empty coverage set never leaves a positive-count digest behind. A lifecycle-only shrink uses a generic count
until the next ingest supplies freshly ranked labels. After a listener-process
restart, a valid silent-channel aggregate is rebound to the new service
generation; legacy or malformed markers are retracted and rebuilt only by a
later eligible ingest. The marker carries the absolute earliest-covered expiry;
generation rebinds and lifecycle-only shrinks recompute the remaining Android
timeout from that same deadline and never extend it. Android versions before API
26 preserve originals because they cannot provide this self-expiring replacement
contract. These transitions narrow stale-notification behavior without claiming
that the key-only Android operation is atomic.

Before a cancellation request, a route error, unavailable server, invalid
response, persistence failure, denied notification-posting permission, disabled
digest channel, publication delay, queue overflow, service restart, expired
network deadline, or changed active generation preserves the original.

## Originals that remain Android-owned

Curated shade never suppresses:

- anything outside the closed low-stakes category allowlist (`promo`,
  `recommendation`, and `social`). Missing, unknown, and future category values
  fail closed to Android;
- calls, alarms, emergency, navigation, transport, workout, location-sharing,
  authentication, message (`msg`), email, voicemail, and missed-call
  notifications;
- system (`sys`), error (`err`), automotive emergency (`car_emergency`),
  automotive warning (`car_warning`), and automotive information
  (`car_information`) notifications;
- foreground services, ongoing, insistent, non-clearable, or full-screen
  notifications;
- high-importance notifications or notifications whose ranking is unavailable;
- Android/System UI, phone, cell-broadcast, permission, and safety-center
  notifications;
- notification group summaries;
- secret or known one-time-code/password-reset notifications;
- apps the user marked “always keep original”; or
- with the default selected-app scope, every app not explicitly placed on the
  best-effort replacement list; or
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

The digest uses a dedicated silent `IMPORTANCE_LOW` channel, disables sound,
vibration, lights, and badges, and uses `PRIORITY_LOW` with no defaults before
Android 8. It is one non-auto-cancel aggregate: tapping it opens Evogent's
Notifications view, where dismissal first persists the exact lifecycle
tombstone and then asks native to cancel only a still-matching eligible original
when one remains. The default preview uses `VISIBILITY_PRIVATE`: the secure lock
screen shows only “Curated notifications are ready,” while the unlocked shade
may show a ranked multi-app summary. Detailed preview uses
`VISIBILITY_PUBLIC` only after the user chooses it. Evogent requests
notification-posting permission once, only after notification-listener access
is already enabled; a denial is not nagged and disables replacement rather than
hiding originals.

## Private data and retention

Notification content, app labels, package names, occurrence counts, user mode,
and per-app choices are deployment-private:

- notification cards and receipts live in the on-phone SQLite database;
- the native no-backup identity ledger is bounded to 128 content-free lifecycle
  rows, retained for at most eight days, and stores only event digest, Android
  key, post time, state, and update time;
- settings live in the mode-`0600`, gitignored
  `data/phone-notification-curation.json`;
- source-due markers live in a mode-`0700`, gitignored directory as at most one
  mode-`0600` constant marker per canonical source;
- ordinary cards expire after three days and high/critical cards after seven
  days unless normal feed lifecycle actions resolve them sooner;
- no content or device observation belongs in committed intent ledgers, build
  logs, Android logs, or public bug reports.

Public source contains only the generalized policy, tests, docs, and failure
classes. Android logs state outcomes without titles, bodies, package names,
notification keys, or response content.

### Supported runtime-agent evidence path

The authenticated WebView and the phone's automation client use different
application session kinds. A normal WebView request uses its reusable secure
web-session cookie and continues to receive local notification cards. Every
ordinary `evo-curl` request uses a fresh `Authorization: EvogentSession …`
direct session and automatically receives the agent-evidence view; callers do
not need to remember a privacy query flag.

That routing is defense in depth for normal, cooperative runtime work, not an
OS confidentiality boundary. Provider children currently run under the same
Unix UID as the server and have unsandboxed shell and filesystem access. A
compromised or adversarial provider process could therefore bypass the API and
open the shared SQLite database directly. Runtime instructions explicitly
forbid that bypass; the filters below describe the supported evidence path and
must not be presented as mechanical isolation from same-UID code.

That view removes phone-notification roots and any parent, child, or suggestion
child introduced by later hydration across feed list, detail, children, and
thread routes. Search does not expose matching private chat history. General
feed interactions on these cards are acknowledged without writing interaction,
attention, thread-feedback, preference, or vector evidence; notification
dismissal remains a content-free local lifecycle fact. “Chat about this” keeps
the user's question but replaces the selected card context with a generic
model-free notice before persistence or queueing. Preference profiles, matching,
and recent-interaction evidence independently exclude notification-linked
rows, including content snapshots and legacy source identifiers. Database
startup removes or replaces local evidence artifacts left by older builds,
atomically removes affected message IDs from the local chat audit and
Evogent-owned orchestrator history, durably removes their Evogent task logs,
and rotates/clears affected provider resume pointers while retaining the
notification cards themselves for the user. Server and worker perform the
history cleanup before loading it into memory so a later save cannot restore a
removed entry. Pointer rotation prevents future resume of the old provider
context; it does not delete or claim deletion of provider-owned on-disk
transcript files. If orchestrator history is malformed while this migration is
pending, it is already unusable as history: startup replaces it with an empty
valid document and durably clears Evogent-owned task logs rather than retaining
unclassifiable private evidence or blocking the phone. Provider-owned
transcripts remain outside that cleanup.

The content-free source-due watermark described above is the only
policy-approved bridge from an eligible notification into supported later
runtime work. It can make a canonical source due; it cannot provide a title,
body, app, account, event identity, or notification count through that path.

Before Evogent can claim mechanical confidentiality against a provider worker,
notification content must either move to Android app-private, native-only
storage that the provider UID cannot open, or provider workers must run with
genuine UID and mount/filesystem isolation from every notification-content
store. API filtering and instructions remain useful defense in depth, but they
do not substitute for that hard boundary. The app-private identity-only receipt
ledger strengthens cancellation authority and lifecycle durability; because it
does not move the SQLite title/body store, it does not by itself create this
content-confidentiality boundary.

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
  best-effort replacement permission or separately confirmed all-eligible
  low-stakes scope, with per-app preservation overriding both;
- exact raw-category fail-closed behavior before normalization;
- server persistence plus the fsynced native identity receipt before
  cancellation;
- removal retiring in-flight and queued revisions, exact event tombstones,
  immutable curated dedupe ownership, LIFO completion not regressing that
  ownership, and dismissed deduplication buckets preventing resurrection;
- deterministic aggregate ranking, a native count exactly equal to its bounded
  event coverage, durable preservation of capacity-excluded identities,
  earliest-covered native expiry preserved across rebind and lifecycle shrink,
  silent low-importance delivery, and digest taps opening the Notifications view;
- content-app source-due continuity, exact marker validation, and proof that
  notification content cannot enter signal storage or browse-cache rows;
- direct-session feed/detail/children/thread/search requests excluding root and
  transitively hydrated phone-notification content while the secure WebView
  still renders the same local cards;
- the public contract distinguishing supported evidence-path filtering and
  explicit worker policy from same-UID OS isolation, and naming the storage or
  worker-isolation requirement for a future hard confidentiality claim;
- notification interactions, attention snapshots, preference context, vector
  matching, and contextual chat remaining content-free, including startup
  cleanup of legacy artifacts;
- settings grant and revocation synchronizing the temporary file, final inode,
  and parent directory before success;
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
   post several fixtures, and confirm one silent generic locked preview, a
   ranked aggregate unlocked digest, and a tap that opens the Notifications
   view; dismiss one card and prove neither its original nor dedupe bucket
   returns; then revoke the app permission and prove the next original remains;
5. post call/alarm/high-importance/ongoing/secret fixtures and prove their
   originals remain;
6. separately confirm “all eligible low-stakes apps,” prove exact
   `promo`/`recommendation`/`social` fixtures can be curated, then mark one app
   “always keep” and prove that override plus every protected fixture remains
   Android-owned;
7. disable Evogent notifications or stop the local server and prove an ordinary
   original remains;
8. rapidly replace and remove a notification under one key and verify known stale work is
   rejected, while reporting the remaining key-only race rather than claiming an
   atomic guarantee;
9. return to Observe and prove replacement stops for subsequent events.

Never claim full lock-screen control from this test. Report the Android-owned
surfaces that remain outside notification-listener authority.

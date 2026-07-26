# Phone runtime reference

Android is Evogent's canonical production paradigm. Start with
[`docs/phone-production.md`](../phone-production.md) for the architecture and
[`phone-paradigm/device/MIGRATE-TO-NEW-PHONE.md`](../../phone-paradigm/device/MIGRATE-TO-NEW-PHONE.md)
for setup.

## Data path

Phone acquisition and curation share one local data path:

```text
logged-in Android apps
  -> hidden-display mechanics
  -> source agent / extractor
  -> browse_cache_items in SQLite
  -> curator judgment
  -> arranged feed
  -> Evogent HOME screen on display 0
```

Phone-gathered rows use the base source name the curator reads, such as
`twitter`, `youtube`, `instagram`, `substack`, or `hackernews`. Acquisition
details belong in run outcomes and `payload.captureMethod`, not in a different
source name that silently bypasses curation.

## Component boundaries

| Piece | Role |
|---|---|
| `EvogentAccessibilityService` | Token-gated capture and input mechanics |
| Shizuku-backed privileged service/controller | Creates and owns hidden displays on the stock-device path |
| `MainActivity` and overlay classes | HOME WebView, native app routing, and the anywhere composer |
| notification listener | Provides notification signals and notification-derived cache evidence |
| `ShareReceiverActivity` | Receives user/runtime share output and submits supported source URLs |
| `device/start-prod.sh` | Applies the loopback/no-Redis phone server profile |
| `evogent-scheduler.sh` | Sole cycle scheduling authority |
| `evogent-cycle.sh` | Leased browse/cache/score/curate/arrange execution |
| `evogent-watchdog.sh` | Independent liveness check; signals the scheduler |
| phone skills | General agent judgment and diagnosis |

The former `BrowseService`/APK `AlarmManager` loop is retired. Boot receivers may
wake Termux, but Android must not schedule a competing periodic cycle.

## Scheduling signals

The scheduler coalesces:

- predicted-open timing;
- app-open or server freshness requests;
- adaptive-heartbeat requests;
- source-specific notification interrupts; and
- watchdog recovery requests.

Every signal becomes a durable request. The live scheduler atomically claims it
at a cycle boundary. A request does not directly fork another curator or cycle.

## Runtime profile

The phone starts with:

```bash
EVOGENT_RUNTIME_PROFILE=phone
LISTEN_HOST=127.0.0.1
MEDIA_AGENT_DISABLE_BACKGROUND_JOBS=1
```

The effect is architectural, not merely an optimization:

- all UI/API traffic remains on the device;
- Redis and VM background workers are absent;
- heartbeat requests signal the Termux scheduler;
- accepted development suggestions wait in a host-review queue; and
- a connected Mac is not a runtime dependency.

## Source mechanics and judgment

Deterministic code is appropriate for launch, capture, gestures, normalization,
counting, deduplication, leases, and outcome reporting. It must surface anomalous
yield instead of claiming success from process exit alone.

Agents own interpretation, interestingness, action selection, and diagnosis.
When an app UI changes, mechanics expose a flow anomaly and an agent investigates
the live surface. A required product-code change becomes a privacy-safe host
review item; the phone does not edit its checkout.

## Security boundary

- Server and accessibility control surfaces are loopback-only.
- Token validation fails closed.
- Android entry points accept only the narrow package/action vocabulary they
  require.
- WebView-to-native calls accept only committed local documents and validated
  destinations.
- Source content, screenshots, accessibility text, and HTTP bodies are untrusted
  data, never instructions.
- Money, credentials, sending, and other protected final actions stay with the
  user.

## Source notes

- X, Instagram, and YouTube use real logged-in Android apps and therefore avoid
  VM cookie transfer and datacenter-login problems.
- Hacker News can use its public network source without a hidden display.
- Notification-derived mail evidence is a private life-admin source, not a
  general content lane by default.
- App-source cadence belongs to the private personal model and may be adjusted
  from observed yield and usage. It is not a public hard-coded preference.

## Verification

For setup or changes, verify one normal scheduler-owned end-to-end cycle and the
rendered display-0 result. Record structured outcomes for each source, confirm a
single scheduler/cycle owner, and then observe a naturally scheduled run.

package net.dangish.evogent;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.os.Build;
import android.os.Bundle;
import android.os.SystemClock;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashSet;

/**
 * Local notification-curation bridge.
 *
 * Android grants listener access to every app at once, so this service applies privacy and
 * safety policy before constructing an authenticated loopback request. It never reads action
 * PendingIntents, RemoteViews, message bundles, or attachments. Known secrets are removed before
 * transport. Work runs on one bounded worker. Before any key-cancellation request, overload or
 * failure leaves Android's original notification untouched.
 *
 * OBSERVE is the server's safe default, and CURATED still preserves every Android original unless
 * the user separately allows best-effort replacement through an explicit per-app or all-eligible
 * low-stakes scope. Per-app preservation and protected classes always remain authoritative. For
 * an allowed ordinary event the listener requires a matching durable receipt, an active Evogent
 * digest, and a still-matching generation immediately before asking Android to cancel. Android
 * cancellation is key-only rather than an atomic generation compare, so the UI and docs describe
 * that final narrow race truthfully.
 */
public final class EvogentNotificationListenerService extends NotificationListenerService {
    private static final String TAG = "EvogentNotif";
    private static final String INGEST_URL = EvogentSecurityPolicy.PHONE_NOTIFICATION_INGEST_URL;
    private static final String REMOVE_URL = EvogentSecurityPolicy.PHONE_NOTIFICATION_REMOVE_URL;
    static final String DIGEST_CHANNEL_ID = "evogent_curated_notifications_v2_silent";
    private static final int DIGEST_NOTIFICATION_ID = 0x45564f4e;
    private static final String PRIVATE_DIGEST_TITLE = "Evogent";
    private static final String PRIVATE_DIGEST_TEXT =
            "Curated notifications are ready.";
    private static final int MAX_LIVE_PENDING_EVENTS = 16;
    private static final int MAX_HISTORICAL_PENDING_EVENTS = 128;
    private static final int NOTIFICATION_END_TO_END_BUDGET_MS = 2000;
    private static final int DIGEST_VERIFY_MAX_MS = 400;
    private static final int REMOVAL_NETWORK_BUDGET_MS = 750;
    private static final String DIGEST_EVENT_ID_EXTRA = "evogent_event_id";
    private static final String DIGEST_SERVICE_GENERATION_EXTRA =
            "evogent_service_generation";
    private static final String DIGEST_WORK_SEQUENCE_EXTRA = "evogent_work_sequence";
    private static final String DIGEST_COVERED_EVENT_IDS_EXTRA =
            "evogent_covered_event_ids";
    private static final String DIGEST_ACTIVE_COUNT_EXTRA =
            "evogent_active_count";
    private static final String DIGEST_EXPIRES_AT_MS_EXTRA =
            "evogent_expires_at_ms";
    private static final String DIGEST_PREVIEW_PREFERENCES =
            "evogent_notification_digest_preview";
    private static final String DIGEST_PREVIEW_MODE_KEY = "mode";
    private static final String DIGEST_PREVIEW_PRIVATE = "private";
    private static final String DIGEST_PREVIEW_DETAILED = "detailed";
    private static final Object DIGEST_PUBLICATION_LOCK = new Object();
    private static long nextServiceGeneration;
    private static long activeServiceGeneration;
    private static EvogentNotificationListenerService activeService;
    private static long digestPreviewPolicyGeneration;
    private static String currentProcessDigestPreviewMode;

    private final EvogentNotificationWorkQueue<NotificationWork> workQueue =
            new EvogentNotificationWorkQueue<NotificationWork>(
                    MAX_LIVE_PENDING_EVENTS,
                    MAX_HISTORICAL_PENDING_EVENTS);
    private volatile boolean workerRunning;
    private long serviceGeneration;
    private long nextLifecycleDigestSequence;
    private Thread workerThread;
    private EvogentNotificationReceiptStore receiptStore;

    @Override
    public void onCreate() {
        super.onCreate();
        try {
            receiptStore = new EvogentNotificationReceiptStore(this);
        } catch (Throwable error) {
            receiptStore = null;
            logFailure("private receipt store unavailable", error);
        }
        synchronized (DIGEST_PUBLICATION_LOCK) {
            serviceGeneration = ++nextServiceGeneration;
            activeServiceGeneration = serviceGeneration;
            activeService = this;
            workerRunning = true;
        }
        workerThread = new Thread(new Runnable() {
            @Override public void run() {
                runWorker();
            }
        }, "evogent-notification-curation");
        workerThread.setDaemon(true);
        workerThread.start();
    }

    @Override
    public void onListenerConnected() {
        rebindActiveDigestGeneration();
        reconcilePendingCuratedCancellations();
        // A process death can occur after durable lifecycle intent but before the old process
        // shrinks its digest. Reconcile those content-free states before any reconnect ingest can
        // reuse the rebound aggregate.
        reconcilePendingUserDismissals();
        pruneResolvedLifecycleCoverage();
        StatusBarNotification[] active = null;
        try {
            active = getActiveNotifications();
        } catch (Throwable error) {
            logFailure("active scan", error);
        }
        if (active != null) {
            for (StatusBarNotification notification : active) {
                enqueue(notification, true);
            }
        }
        enqueuePendingRemovalEvents();
        Log.i(TAG, "listener connected; active scan queued");
    }

    /**
     * A listener-service process can restart while its low-importance digest remains in Android.
     * Rebind a valid current-channel marker to the new service generation so later exact lifecycle
     * events can still shrink it. Legacy/malformed digests have no durable aggregate proof and are
     * retracted; the next eligible ingest rebuilds them from SQLite.
     */
    private void rebindActiveDigestGeneration() {
        synchronized (DIGEST_PUBLICATION_LOCK) {
            if (!isCurrentServiceGeneration()) return;
            try {
                StatusBarNotification[] active = getActiveNotifications();
                if (active == null) return;
                for (StatusBarNotification candidate : active) {
                    if (candidate == null
                            || DIGEST_NOTIFICATION_ID != candidate.getId()
                            || !EvogentNotificationPolicy.EVOGENT_PACKAGE.equals(
                                    candidate.getPackageName())
                            || candidate.getNotification() == null
                            || candidate.getNotification().extras == null) {
                        continue;
                    }
                    Notification current = candidate.getNotification();
                    NotificationManager manager =
                            (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
                    if (manager == null) return;
                    if (Build.VERSION.SDK_INT < 26
                            || !DIGEST_CHANNEL_ID.equals(current.getChannelId())) {
                        manager.cancel(DIGEST_NOTIFICATION_ID);
                        return;
                    }
                    ArrayList<String> covered = current.extras.getStringArrayList(
                            DIGEST_COVERED_EVENT_IDS_EXTRA);
                    int activeCount = current.extras.getInt(DIGEST_ACTIVE_COUNT_EXTRA, 0);
                    long expiresAtMs = current.extras.getLong(
                            DIGEST_EXPIRES_AT_MS_EXTRA,
                            0L);
                    long timeoutAfterMs = EvogentNotificationPolicy.digestTimeoutAfterMs(
                            expiresAtMs,
                            System.currentTimeMillis());
                    if (!isValidCoverage(covered)
                            || activeCount <= 0
                            || activeCount != covered.size()
                            || timeoutAfterMs <= 0L) {
                        manager.cancel(DIGEST_NOTIFICATION_ID);
                        return;
                    }
                    if (serviceGeneration == current.extras.getLong(
                            DIGEST_SERVICE_GENERATION_EXTRA)) {
                        // VISIBILITY_PRIVATE delegates redaction to Android's global lock-screen
                        // preference. A user who allows private notification content would
                        // otherwise see ranked app details despite choosing Evogent's Private
                        // preview. Sanitize the primary notification itself, including a digest
                        // left by an older build, without extending its absolute expiry.
                        if (!isDetailedDigestPreviewModeLocked(this)
                                || current.visibility != Notification.VISIBILITY_PUBLIC) {
                            Notification.Builder privateBuilder =
                                    Notification.Builder.recoverBuilder(this, current);
                            applyDigestDisplayContent(
                                    this,
                                    privateBuilder,
                                    null,
                                    null,
                                    false);
                            privateBuilder.setTimeoutAfter(timeoutAfterMs);
                            manager.notify(DIGEST_NOTIFICATION_ID, privateBuilder.build());
                        }
                        return;
                    }
                    DigestMarker marker = new DigestMarker(
                            covered.isEmpty() ? zeroEventId() : covered.get(0),
                            serviceGeneration,
                            --nextLifecycleDigestSequence,
                            covered,
                            activeCount,
                            expiresAtMs);
                    Bundle markerExtras = new Bundle();
                    markerExtras.putString(DIGEST_EVENT_ID_EXTRA, marker.eventId);
                    markerExtras.putLong(
                            DIGEST_SERVICE_GENERATION_EXTRA,
                            marker.serviceGeneration);
                    markerExtras.putLong(DIGEST_WORK_SEQUENCE_EXTRA, marker.workSequence);
                    markerExtras.putStringArrayList(
                            DIGEST_COVERED_EVENT_IDS_EXTRA,
                            new ArrayList<String>(marker.coveredEventIds));
                    markerExtras.putInt(DIGEST_ACTIVE_COUNT_EXTRA, marker.activeCount);
                    markerExtras.putLong(
                            DIGEST_EXPIRES_AT_MS_EXTRA,
                            marker.expiresAtMs);
                    Notification.Builder builder =
                            Notification.Builder.recoverBuilder(this, current);
                    timeoutAfterMs = EvogentNotificationPolicy.digestTimeoutAfterMs(
                            marker.expiresAtMs,
                            System.currentTimeMillis());
                    if (timeoutAfterMs <= 0L) {
                        manager.cancel(DIGEST_NOTIFICATION_ID);
                        return;
                    }
                    builder
                            .setPriority(Notification.PRIORITY_LOW)
                            .setDefaults(0)
                            .setSound(null)
                            .setVibrate(null)
                            .setOnlyAlertOnce(true)
                            .setAutoCancel(false)
                            .setTimeoutAfter(timeoutAfterMs)
                            .addExtras(markerExtras);
                    if (!isDetailedDigestPreviewModeLocked(this)
                            || current.visibility != Notification.VISIBILITY_PUBLIC) {
                        applyDigestDisplayContent(this, builder, null, null, false);
                    }
                    manager.notify(DIGEST_NOTIFICATION_ID, builder.build());
                    return;
                }
            } catch (Throwable error) {
                logFailure("digest generation rebind", error);
            }
        }
    }

    @Override
    public void onNotificationPosted(StatusBarNotification notification) {
        enqueue(notification, false);
    }

    @Override
    public void onNotificationRemoved(
            StatusBarNotification notification,
            RankingMap rankingMap,
            int reason) {
        handleNotificationRemoved(
                notification,
                reason == NotificationListenerService.REASON_LISTENER_CANCEL);
    }

    @Override
    public void onDestroy() {
        workerRunning = false;
        synchronized (DIGEST_PUBLICATION_LOCK) {
            if (activeServiceGeneration == serviceGeneration) {
                activeServiceGeneration = 0L;
            }
            if (activeService == this) activeService = null;
        }
        Thread thread = workerThread;
        workerThread = null;
        if (thread != null) thread.interrupt();
        workQueue.clear();
        super.onDestroy();
    }

    private void runWorker() {
        while (workerRunning) {
            try {
                EvogentNotificationWorkQueue.Entry<NotificationWork> entry =
                        workQueue.take();
                try {
                    if (entry.value.removedEventId != null) {
                        publishRemoval(entry);
                    } else {
                        ingest(entry);
                    }
                } finally {
                    // Drop the StatusBarNotification/content reference as soon as the exact
                    // revision has finished. Only genuinely in-flight work needs successor
                    // tracking.
                    workQueue.complete(entry);
                }
            } catch (InterruptedException interrupted) {
                if (!workerRunning) return;
            } catch (Throwable error) {
                logFailure("worker; original preserved", error);
            }
        }
    }

    private void enqueue(
            final StatusBarNotification notification,
            final boolean historical) {
        if (notification == null) return;
        // Filter our digest before it can advance the live sequence. Waiting until capture()
        // creates a race where manager.notify() supersedes the external event whose exact
        // replacement proof is currently being applied.
        String packageName = EvogentNotificationPolicy.normalize(
                notification.getPackageName(),
                255);
        if (EvogentNotificationPolicy.EVOGENT_PACKAGE.equals(packageName)) return;
        EvogentNotificationWorkQueue.OfferResult result = workerRunning
                ? workQueue.offer(
                        NotificationWork.posted(notification),
                        historical,
                        notification.getKey())
                : EvogentNotificationWorkQueue.OfferResult.REJECTED;
        if (!result.accepted()) {
            // Safe shutdown/overload behavior: no server receipt means no cancellation.
            Log.w(TAG, "notification queue unavailable; original preserved");
        } else if (result == EvogentNotificationWorkQueue.OfferResult.EVICTED_OLDEST_LIVE) {
            Log.w(TAG, "stale live curation work evicted; Android original preserved");
        }
    }

    private void handleNotificationRemoved(
            StatusBarNotification notification,
            boolean listenerCancellation) {
        if (notification == null) return;
        String packageName = EvogentNotificationPolicy.normalize(
                notification.getPackageName(),
                255);
        if (EvogentNotificationPolicy.EVOGENT_PACKAGE.equals(packageName)) return;
        String key = notification.getKey();
        if (key == null || key.length() == 0 || key.length() > 1024) return;
        // This happens synchronously with the Android callback. A loopback response that arrives
        // afterward can persist evidence, but can no longer publish a digest or cancel by key.
        workQueue.retire(key);
        EvogentNotificationReceiptStore store = receiptStore;
        if (store == null) return;
        EvogentNotificationReceiptStore.Record record =
                store.findByKeyAndPostTime(key, notification.getPostTime());
        if (record == null) return;
        EvogentNotificationReceiptStore.RemovalDisposition disposition =
                store.markRemoved(record.eventId, listenerCancellation);
        if (disposition == EvogentNotificationReceiptStore.RemovalDisposition.EXPECTED_USER
                || disposition == EvogentNotificationReceiptStore.RemovalDisposition.EXTERNAL) {
            pruneActiveDigestCoverage(record.eventId);
        }
        if (disposition != EvogentNotificationReceiptStore.RemovalDisposition.EXTERNAL) {
            return;
        }
        enqueueRemovalEvent(record.eventId);
    }

    private void enqueueRemovalEvent(String eventId) {
        EvogentNotificationWorkQueue.OfferResult result = workerRunning
                ? workQueue.offer(
                        NotificationWork.removed(eventId),
                        false,
                        "removed:" + eventId)
                : EvogentNotificationWorkQueue.OfferResult.REJECTED;
        if (!result.accepted()) {
            Log.w(TAG, "notification removal queue unavailable; server view expires naturally");
        }
    }

    private void enqueuePendingRemovalEvents() {
        EvogentNotificationReceiptStore store = receiptStore;
        if (store == null || !workerRunning) return;
        int queued = 0;
        for (String eventId : store.pendingRemovalEventIds()) {
            if (queued >= MAX_LIVE_PENDING_EVENTS) return;
            enqueueRemovalEvent(eventId);
            queued++;
        }
    }

    private void ingest(
            EvogentNotificationWorkQueue.Entry<NotificationWork> entry) {
        try {
            long endToEndDeadlineElapsedMs =
                    SystemClock.elapsedRealtime() + NOTIFICATION_END_TO_END_BUDGET_MS;
            Snapshot snapshot = capture(entry.value.notification, entry.historical);
            if (snapshot == null || !snapshot.decision.ingest) return;
            EvogentNotificationReceiptStore store = receiptStore;
            if (store == null
                    || !store.recordObserved(
                            snapshot.eventId,
                            snapshot.notificationKey,
                            snapshot.postTimeMs)
                    || SystemClock.elapsedRealtime() >= endToEndDeadlineElapsedMs) {
                return;
            }
            JSONObject response = EvogentLoopbackAuth.postJsonDirectForJsonBefore(
                    this,
                    INGEST_URL,
                    snapshot.request.toString(),
                    endToEndDeadlineElapsedMs);
            if (response != null && response.optBoolean("ok", false)) {
                // A later healthy loopback exchange is a cheap retry trigger for any content-free
                // removals that survived a server outage; no polling or wakeup is introduced.
                enqueuePendingRemovalEvents();
            }
            if (!isCurrentWork(entry)) return;
            applyResponse(entry, snapshot, response, endToEndDeadlineElapsedMs);
        } catch (Throwable error) {
            // Never log notification text or app-provided exception messages.
            logFailure("ingest; original preserved", error);
        }
    }

    private Snapshot capture(StatusBarNotification sbn, boolean historical) {
        if (sbn == null || sbn.getNotification() == null) return null;
        Notification notification = sbn.getNotification();
        String packageName = EvogentNotificationPolicy.normalize(sbn.getPackageName(), 255);
        if (EvogentNotificationPolicy.EVOGENT_PACKAGE.equals(packageName)) return null;

        String title = null;
        String text = null;
        String subText = null;
        Bundle extras = notification.extras;
        if (extras != null) {
            title = firstText(extras, Notification.EXTRA_TITLE, Notification.EXTRA_TITLE_BIG);
            text = firstText(
                    extras,
                    Notification.EXTRA_BIG_TEXT,
                    Notification.EXTRA_TEXT,
                    Notification.EXTRA_SUMMARY_TEXT);
            subText = firstText(extras, Notification.EXTRA_SUB_TEXT, Notification.EXTRA_INFO_TEXT);
        }

        int importance = NotificationManager.IMPORTANCE_UNSPECIFIED;
        boolean conversation = false;
        try {
            Ranking ranking = new Ranking();
            RankingMap rankingMap = getCurrentRanking();
            if (rankingMap != null && rankingMap.getRanking(sbn.getKey(), ranking)) {
                importance = ranking.getImportance();
                if (Build.VERSION.SDK_INT >= 30) {
                    conversation = ranking.isConversation();
                }
            }
        } catch (Throwable ignored) {
            // Missing ranking makes suppression more conservative on the server/native policy.
        }

        boolean groupSummary = (notification.flags & Notification.FLAG_GROUP_SUMMARY) != 0;
        EvogentNotificationPolicy.Input policyInput = new EvogentNotificationPolicy.Input(
                packageName,
                notification.category,
                notification.flags,
                importance,
                sbn.isClearable(),
                sbn.isOngoing(),
                notification.fullScreenIntent != null,
                groupSummary,
                conversation,
                notification.visibility,
                title,
                text,
                subText);
        EvogentNotificationPolicy.Decision decision =
                EvogentNotificationPolicy.decide(policyInput);
        if (!decision.ingest) return null;

        String eventId = EvogentNotificationPolicy.eventId(
                policyInput,
                sbn.getKey(),
                sbn.getPostTime());
        JSONObject request = new JSONObject();
        try {
            request.put("schemaVersion", 1);
            request.put("eventId", eventId);
            request.put("packageName", packageName);
            String appLabel = applicationLabel(packageName);
            if (appLabel != null) request.put("appLabel", appLabel);
            if (notification.category != null) {
                request.put(
                        "category",
                        EvogentNotificationPolicy.normalize(notification.category, 80));
            }
            request.put("flags", notification.flags);
            request.put("importance", importance);
            request.put("clearable", sbn.isClearable());
            request.put("ongoing", sbn.isOngoing());
            request.put("fullScreen", notification.fullScreenIntent != null);
            request.put("groupSummary", groupSummary);
            request.put("conversation", conversation);
            request.put("visibility", notification.visibility);
            request.put("postedAtMs", sbn.getPostTime());
            request.put("historical", historical);
            request.put("nativePriority", decision.priority);
            request.put("nativeCanSuppress", decision.nativeCanSuppress);
            request.put(
                    "nativeCategoryWireExact",
                    policyInput.exactReplacementEligibleCategory);
            request.put("contentRedacted", decision.redactContent);
            if (decision.protectionReason != null) {
                request.put("nativeProtectionReason", decision.protectionReason);
            }
            String channelHash = EvogentNotificationPolicy.opaqueId(notification.getChannelId());
            if (channelHash != null) request.put("channelHash", channelHash);
            if (decision.safeTitle != null) request.put("title", decision.safeTitle);
            if (decision.safeText != null) request.put("text", decision.safeText);
            if (decision.safeSubText != null) request.put("subText", decision.safeSubText);
            request.put("digestCapability", hasDigestCapability());
        } catch (Exception invalid) {
            return null;
        }
        DigestPreviewFence digestPreviewFence = captureDigestPreviewFence(this);
        return new Snapshot(
                sbn.getKey(),
                sbn.getPostTime(),
                eventId,
                historical,
                decision,
                request,
                digestPreviewFence.policyGeneration,
                digestPreviewFence.detailedAuthorized);
    }

    private void applyResponse(
            EvogentNotificationWorkQueue.Entry<NotificationWork> entry,
            Snapshot snapshot,
            JSONObject response,
            long endToEndDeadlineElapsedMs) {
        try {
            if (!isCurrentWork(entry)
                    || response == null
                    || !response.optBoolean("ok", false)) return;
            JSONObject receipt = response.optJSONObject("receipt");
            JSONObject policy = response.optJSONObject("policy");
            JSONObject digest = response.optJSONObject("digest");
            if (receipt == null || policy == null || digest == null) return;

            String receiptEventId = receipt.optString("eventId", "");
            boolean persisted = receipt.optBoolean("persisted", false);
            String mode = policy.optString("mode", "");
            boolean replacementAllowed =
                    policy.optBoolean("replacementAllowed", false);
            boolean serverRequestedSuppression =
                    policy.optBoolean("suppressOriginal", false);
            boolean receiptMatches = persisted
                    && snapshot.eventId.equals(receiptEventId);
            EvogentNotificationReceiptStore store = receiptStore;
            // The worker is serialized. An older distinct event selected after a newer one gets a
            // later server response, so its aggregate is the freshest database view and may safely
            // converge the shared digest. Exact current live-work proofs may also authorize
            // cancellation of its own original; arrival sequence is not response freshness.
            boolean replacementPolicyCandidate = !entry.historical
                    && "curated".equals(mode)
                    && replacementAllowed
                    && serverRequestedSuppression
                    && receiptMatches;
            if (!replacementPolicyCandidate) return;
            boolean digestCapability = hasDigestCapability();
            if (!digestCapability
                    || SystemClock.elapsedRealtime() >= endToEndDeadlineElapsedMs) {
                return;
            }
            ArrayList<String> coveredEventIds = parseCoveredEventIds(digest);
            if (!coveredEventIds.contains(snapshot.eventId)) return;
            long digestExpiresAtMs = parseDigestExpiresAtMs(digest);
            if (EvogentNotificationPolicy.digestTimeoutAfterMs(
                            digestExpiresAtMs,
                            System.currentTimeMillis())
                    <= NOTIFICATION_END_TO_END_BUDGET_MS) {
                return;
            }
            boolean nativeReceiptStored = store != null
                    && store.recordReceipt(
                            snapshot.eventId,
                            snapshot.notificationKey,
                            snapshot.postTimeMs);
            if (!nativeReceiptStored) return;
            boolean digestActive = false;
            DigestMarker digestMarker = null;
            if (SystemClock.elapsedRealtime() < endToEndDeadlineElapsedMs) {
                if (!isPublicationCurrent(entry, snapshot)) return;
                digestMarker = new DigestMarker(
                        snapshot.eventId,
                        serviceGeneration,
                        entry.liveSequence,
                        coveredEventIds,
                        digest.optInt("activeCount", 0),
                        digestExpiresAtMs);
                digestActive = publishAndVerifyDigest(
                        digest,
                        digestMarker,
                        entry,
                        snapshot,
                        endToEndDeadlineElapsedMs);
            }
            if (digestActive && !isPublicationCurrent(entry, snapshot)) {
                retractDigestIfOwned(digestMarker);
                return;
            }
            if (digestActive) {
                // A distinct Android removal may have arrived while this request was in flight.
                // Its server tombstone can therefore be newer than the aggregate response we just
                // published. Re-apply native pending removals under exact digest ownership before
                // this response can gain cancellation authority.
                pruneResolvedLifecycleCoverage();
                if (!isDigestActive(digestMarker)) return;
            }
            if (!isCurrentWork(entry)) {
                if (digestActive) retractDigestIfOwned(digestMarker);
                return;
            }
            boolean revisionMatches = isSameActiveRevision(snapshot);
            if (!revisionMatches) {
                if (digestActive) retractDigestIfOwned(digestMarker);
                return;
            }

            boolean cancellationSequenceCurrent =
                    EvogentNotificationPolicy.mayCancelFromLiveSequence(
                            entry.historical,
                            entry.liveSequence);
            if (digestActive && !cancellationSequenceCurrent) {
                Log.i(TAG, "non-live work cannot cancel an Android original");
                return;
            }
            boolean shouldRequestKeyCancellation =
                    isCurrentWork(entry)
                    && cancellationSequenceCurrent
                    && nativeReceiptStored
                    && digestMarker != null
                    && digestMarker.covers(snapshot.eventId)
                    && EvogentNotificationPolicy.shouldCancelOriginal(
                    snapshot.decision,
                    snapshot.eventId,
                    receiptEventId,
                    persisted,
                    mode,
                    replacementAllowed,
                    serverRequestedSuppression,
                    digestCapability,
                    digestActive,
                    revisionMatches);
            if (shouldRequestKeyCancellation) {
                if (store == null
                        || !store.markCancellationPending(snapshot.eventId, false)) {
                    retractDigestIfOwned(digestMarker);
                    return;
                }
                boolean finalRevisionMatches =
                        SystemClock.elapsedRealtime() < endToEndDeadlineElapsedMs
                        && isCurrentWork(entry)
                        && isDigestActive(digestMarker)
                        && isSameActiveRevision(snapshot)
                        && SystemClock.elapsedRealtime() < endToEndDeadlineElapsedMs;
                if (!finalRevisionMatches) {
                    store.restoreReceiptAfterAbortedCancellation(snapshot.eventId, false);
                    retractDigestIfOwned(digestMarker);
                    return;
                }
                // Public Android APIs cancel by stable notification key, not by an atomic
                // event-version token. The immediately preceding generation checks narrow that
                // unavoidable race; the explicit user-selected replacement scope bounds who can
                // enter it, and per-app preservation still overrides that scope.
                try {
                    cancelNotification(snapshot.notificationKey);
                    Log.i(TAG, "allowlisted notification key cancellation requested");
                } catch (Throwable error) {
                    store.restoreReceiptAfterAbortedCancellation(snapshot.eventId, false);
                    retractDigestIfOwned(digestMarker);
                    logFailure("key cancellation request; original preserved", error);
                }
            } else if (digestActive) {
                retractDigestIfOwned(digestMarker);
            }
        } catch (Throwable error) {
            logFailure("response validation; original preserved", error);
        }
    }

    private boolean isCurrentWork(
            EvogentNotificationWorkQueue.Entry<NotificationWork> entry) {
        return workerRunning
                && isCurrentServiceGeneration()
                && workQueue.isCurrent(entry);
    }

    private boolean isCurrentServiceGeneration() {
        synchronized (DIGEST_PUBLICATION_LOCK) {
            return workerRunning
                    && serviceGeneration > 0L
                    && activeServiceGeneration == serviceGeneration;
        }
    }

    private boolean isPublicationCurrent(
            EvogentNotificationWorkQueue.Entry<NotificationWork> entry,
            Snapshot snapshot) {
        return isCurrentWork(entry)
                && hasDigestCapability()
                && isSameActiveRevision(snapshot);
    }

    private boolean isSameActiveRevision(Snapshot expected) {
        try {
            StatusBarNotification[] active = getActiveNotifications();
            if (active == null) return false;
            for (StatusBarNotification candidate : active) {
                if (candidate == null
                        || !expected.notificationKey.equals(candidate.getKey())
                        || candidate.getPostTime() != expected.postTimeMs) {
                    continue;
                }
                Snapshot current = capture(candidate, expected.historical);
                return current != null
                        && current.decision.nativeCanSuppress
                        && expected.decision.nativeCanSuppress
                        && expected.eventId.equals(current.eventId);
            }
        } catch (Throwable ignored) {
        }
        return false;
    }

    private boolean hasDigestCapability() {
        try {
            // Notification.Builder.setTimeoutAfter is API 26. Older supported Android versions
            // preserve originals because Evogent cannot guarantee a self-expiring replacement.
            if (Build.VERSION.SDK_INT < 26) return false;
            NotificationManager manager =
                    (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (manager == null || !manager.areNotificationsEnabled()) return false;
            ensureDigestChannel(manager);
            NotificationChannel channel =
                    manager.getNotificationChannel(DIGEST_CHANNEL_ID);
            return channel != null
                    && channel.getImportance() != NotificationManager.IMPORTANCE_NONE;
        } catch (Throwable ignored) {
            return false;
        }
    }

    private boolean publishAndVerifyDigest(
            JSONObject digest,
            DigestMarker marker,
            EvogentNotificationWorkQueue.Entry<NotificationWork> entry,
            Snapshot snapshot,
            long endToEndDeadlineElapsedMs) {
        if (digest == null || marker == null) return false;
        if (SystemClock.elapsedRealtime() >= endToEndDeadlineElapsedMs) return false;
        NotificationManager manager =
                (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return false;
        try {
            ensureDigestChannel(manager);
            String title = boundedResponseText(
                    digest.optString("title", "Evogent"),
                    "Evogent",
                    120);
            String text = boundedResponseText(
                    digest.optString(
                            "text",
                            "A notification is ready in your curated view."),
                    "A notification is ready in your curated view.",
                    512);
            String preview = digest.optString("lockScreenPreview", "private");
            if (!"private".equals(preview) && !"detailed".equals(preview)) {
                return false;
            }
            int activeCount = digest.optInt("activeCount", 0);
            if (activeCount <= 0
                    || marker.coveredEventIds.isEmpty()
                    || activeCount != marker.coveredEventIds.size()) {
                return false;
            }

            Intent open = new Intent(this, MainActivity.class)
                    .setAction(MainActivity.ACTION_OPEN_EVOGENT_HOME)
                    .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP
                            | Intent.FLAG_ACTIVITY_SINGLE_TOP)
                    .putExtra(MainActivity.OPEN_NOTIFICATIONS_EXTRA, true);
            PendingIntent contentIntent = PendingIntent.getActivity(
                    this,
                    DIGEST_NOTIFICATION_ID,
                    open,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

            Notification.Builder builder = Build.VERSION.SDK_INT >= 26
                    ? new Notification.Builder(this, DIGEST_CHANNEL_ID)
                    : new Notification.Builder(this);
            Bundle receiptMarker = new Bundle();
            receiptMarker.putString(DIGEST_EVENT_ID_EXTRA, marker.eventId);
            receiptMarker.putLong(
                    DIGEST_SERVICE_GENERATION_EXTRA,
                    marker.serviceGeneration);
            receiptMarker.putLong(DIGEST_WORK_SEQUENCE_EXTRA, marker.workSequence);
            receiptMarker.putStringArrayList(
                    DIGEST_COVERED_EVENT_IDS_EXTRA,
                    new ArrayList<String>(marker.coveredEventIds));
            receiptMarker.putInt(DIGEST_ACTIVE_COUNT_EXTRA, marker.activeCount);
            receiptMarker.putLong(
                    DIGEST_EXPIRES_AT_MS_EXTRA,
                    marker.expiresAtMs);
            builder
                    .setSmallIcon(R.drawable.ic_evogent)
                    .setContentIntent(contentIntent)
                    .setCategory(Notification.CATEGORY_STATUS)
                    .setPriority(Notification.PRIORITY_LOW)
                    .setDefaults(0)
                    .setSound(null)
                    .setVibrate(null)
                    .setOnlyAlertOnce(true)
                    .setAutoCancel(false)
                    .setLocalOnly(true)
                    .addExtras(receiptMarker);
            synchronized (DIGEST_PUBLICATION_LOCK) {
                // This is the final service/work/revision check before the key-owned digest is
                // replaced. Holding the process-wide lock orders old/new service instances.
                if (SystemClock.elapsedRealtime() >= endToEndDeadlineElapsedMs
                        || !isPublicationCurrent(entry, snapshot)) return false;
                boolean detailedPreview = mayPublishDetailedDigestLocked(
                        this,
                        snapshot,
                        preview);
                applyDigestDisplayContent(
                        this,
                        builder,
                        title,
                        text,
                        detailedPreview);
                long timeoutAfterMs = EvogentNotificationPolicy.digestTimeoutAfterMs(
                        marker.expiresAtMs,
                        System.currentTimeMillis());
                // Keep the digest alive beyond this work's entire remaining cancellation window.
                // Near-expiry cards remain in Android rather than creating a replacement gap.
                if (timeoutAfterMs <= NOTIFICATION_END_TO_END_BUDGET_MS) return false;
                builder.setTimeoutAfter(timeoutAfterMs);
                manager.notify(DIGEST_NOTIFICATION_ID, builder.build());
            }
            long deadline = Math.min(
                    endToEndDeadlineElapsedMs,
                    SystemClock.elapsedRealtime() + DIGEST_VERIFY_MAX_MS);
            do {
                if (!isPublicationCurrent(entry, snapshot)) {
                    retractDigestIfOwned(marker);
                    return false;
                }
                if (isDigestActive(marker)) {
                    if (isPublicationCurrent(entry, snapshot)) return true;
                    retractDigestIfOwned(marker);
                    return false;
                }
                long remainingMs = deadline - SystemClock.elapsedRealtime();
                if (remainingMs > 0L) {
                    SystemClock.sleep(Math.min(40L, remainingMs));
                }
            } while (SystemClock.elapsedRealtime() < deadline);
        } catch (Throwable error) {
            logFailure("digest publication", error);
        }
        retractDigestIfOwned(marker);
        return false;
    }

    private boolean isDigestActive(DigestMarker marker) {
        if (marker == null
                || EvogentNotificationPolicy.digestTimeoutAfterMs(
                                marker.expiresAtMs,
                                System.currentTimeMillis())
                        <= 0L) {
            return false;
        }
        try {
            StatusBarNotification[] active = getActiveNotifications();
            if (active == null) return false;
            for (StatusBarNotification candidate : active) {
                if (candidate != null
                        && DIGEST_NOTIFICATION_ID == candidate.getId()
                        && EvogentNotificationPolicy.EVOGENT_PACKAGE.equals(
                                candidate.getPackageName())
                        && candidate.getNotification() != null
                        && candidate.getNotification().extras != null
                        && marker.eventId.equals(candidate.getNotification().extras.getString(
                                DIGEST_EVENT_ID_EXTRA))
                        && marker.serviceGeneration
                                == candidate.getNotification().extras.getLong(
                                        DIGEST_SERVICE_GENERATION_EXTRA)
                        && marker.workSequence
                                == candidate.getNotification().extras.getLong(
                                        DIGEST_WORK_SEQUENCE_EXTRA)
                        && marker.hasSameCoverage(
                                candidate.getNotification().extras.getStringArrayList(
                                        DIGEST_COVERED_EVENT_IDS_EXTRA))
                        && marker.activeCount == candidate.getNotification().extras.getInt(
                                DIGEST_ACTIVE_COUNT_EXTRA, 0)
                        && marker.expiresAtMs == candidate.getNotification().extras.getLong(
                                DIGEST_EXPIRES_AT_MS_EXTRA, 0L)) {
                    return true;
                }
            }
        } catch (Throwable ignored) {
        }
        return false;
    }

    private void retractDigestIfOwned(DigestMarker marker) {
        if (marker == null) return;
        synchronized (DIGEST_PUBLICATION_LOCK) {
            if (!isDigestActive(marker)) return;
            if (!isCurrentServiceGeneration()) {
                try {
                    NotificationManager manager =
                            (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
                    if (manager != null) manager.cancel(DIGEST_NOTIFICATION_ID);
                } catch (Throwable error) {
                    logFailure("stale service digest retraction", error);
                }
                return;
            }
            // This work added one event to a shared aggregate. A late failure must not erase
            // earlier successfully curated coverage, so retract only its contribution from the
            // exact marker it owns. pruneActiveDigestCoverage cancels the digest when none remain.
            pruneActiveDigestCoverage(marker.eventId);
        }
    }

    private ArrayList<String> parseCoveredEventIds(JSONObject digest) {
        ArrayList<String> covered = new ArrayList<String>();
        if (digest == null) return covered;
        JSONArray values = digest.optJSONArray("coveredEventIds");
        if (values == null || values.length() == 0 || values.length() > 32) return covered;
        HashSet<String> unique = new HashSet<String>();
        for (int index = 0; index < values.length(); index++) {
            Object raw = values.opt(index);
            if (!(raw instanceof String)) {
                covered.clear();
                return covered;
            }
            String eventId = (String) raw;
            if (!isEventId(eventId) || !unique.add(eventId)) {
                covered.clear();
                return covered;
            }
            covered.add(eventId);
        }
        return covered;
    }

    private static long parseDigestExpiresAtMs(JSONObject digest) {
        if (digest == null) return 0L;
        Object raw = digest.opt("expiresAtMs");
        if (!(raw instanceof Number)) return 0L;
        Number number = (Number) raw;
        double numeric = number.doubleValue();
        long exact = number.longValue();
        if (Double.isNaN(numeric)
                || Double.isInfinite(numeric)
                || numeric != (double) exact) {
            return 0L;
        }
        return exact;
    }

    private static boolean isValidCoverage(ArrayList<String> values) {
        if (values == null || values.isEmpty() || values.size() > 32) return false;
        HashSet<String> unique = new HashSet<String>();
        for (String eventId : values) {
            if (!isEventId(eventId) || !unique.add(eventId)) return false;
        }
        return true;
    }

    private void publishRemoval(
            EvogentNotificationWorkQueue.Entry<NotificationWork> entry) {
        if (!isCurrentWork(entry) || entry.value.removedEventId == null) return;
        try {
            JSONObject request = new JSONObject();
            request.put("schemaVersion", 1);
            request.put("eventId", entry.value.removedEventId);
            JSONObject response = EvogentLoopbackAuth.postJsonDirectForJsonBefore(
                    this,
                    REMOVE_URL,
                    request.toString(),
                    SystemClock.elapsedRealtime() + REMOVAL_NETWORK_BUDGET_MS);
            if (response != null
                    && response.optBoolean("ok", false)
                    && entry.value.removedEventId.equals(
                            response.optString("eventId", ""))) {
                EvogentNotificationReceiptStore store = receiptStore;
                if (store != null) {
                    if (store.acknowledgeRemoval(entry.value.removedEventId)) {
                        // Idempotent second edge of the ingest/removal race: if an in-flight
                        // aggregate republished this identity, successful durable server removal
                        // must shrink it again before the receipt becomes terminal.
                        pruneActiveDigestCoverage(entry.value.removedEventId);
                        // Drain another bounded batch while loopback is known healthy.
                        enqueuePendingRemovalEvents();
                    }
                }
            }
        } catch (Throwable error) {
            // The server card retains its ordinary expiry when loopback is unavailable.
            logFailure("removal lifecycle publication", error);
        }
    }

    static boolean requestUserDismiss(String eventId) {
        EvogentNotificationListenerService service;
        synchronized (DIGEST_PUBLICATION_LOCK) {
            service = activeService;
        }
        return service != null && service.requestUserDismissInternal(eventId);
    }

    private boolean requestUserDismissInternal(String eventId) {
        if (!isEventId(eventId)
                || !isCurrentServiceGeneration()
                || !hasActiveDigestCovering(eventId)) {
            return false;
        }
        EvogentNotificationReceiptStore store = receiptStore;
        EvogentNotificationReceiptStore.Record receipt =
                store == null ? null : store.findByEventId(eventId);
        if (receipt == null
                || (!EvogentNotificationReceiptStore.STATE_RECEIPT.equals(receipt.state)
                        && !EvogentNotificationReceiptStore.STATE_CURATED_CANCEL_PENDING.equals(
                                receipt.state)
                        && !EvogentNotificationReceiptStore.STATE_USER_DISMISS_PENDING.equals(
                                receipt.state)
                        && !EvogentNotificationReceiptStore.STATE_CURATED_REMOVED.equals(
                                receipt.state)
                        && !EvogentNotificationReceiptStore.STATE_USER_DISMISSED.equals(
                                receipt.state)
                        && !EvogentNotificationReceiptStore.STATE_REMOVED.equals(
                                receipt.state))) {
            return false;
        }
        if (EvogentNotificationReceiptStore.STATE_USER_DISMISSED.equals(receipt.state)) {
            pruneActiveDigestCoverage(eventId);
            return true;
        }
        if (EvogentNotificationReceiptStore.STATE_CURATED_REMOVED.equals(receipt.state)
                || EvogentNotificationReceiptStore.STATE_REMOVED.equals(receipt.state)) {
            if (!store.markUserDismissResolved(eventId)) return false;
            pruneActiveDigestCoverage(eventId);
            return true;
        }
        boolean userIntentDurable =
                EvogentNotificationReceiptStore.STATE_USER_DISMISS_PENDING.equals(receipt.state)
                || store.markUserDismissPending(eventId);
        if (!userIntentDurable) return false;
        Snapshot current = null;
        try {
            StatusBarNotification[] active = getActiveNotifications();
            if (active == null) {
                pruneActiveDigestCoverage(eventId);
                return false;
            }
            for (StatusBarNotification candidate : active) {
                if (candidate == null
                        || !receipt.notificationKey.equals(candidate.getKey())
                        || receipt.postTimeMs != candidate.getPostTime()) {
                    continue;
                }
                Snapshot captured = capture(candidate, false);
                if (captured != null
                        && captured.decision.nativeCanSuppress
                        && eventId.equals(captured.eventId)) {
                    current = captured;
                }
                break;
            }
        } catch (Throwable ignored) {
            pruneActiveDigestCoverage(eventId);
            return false;
        }
        if (current == null) {
            store.markUserDismissResolved(eventId);
            pruneActiveDigestCoverage(eventId);
            return true;
        }
        if (!hasActiveDigestCovering(eventId)
                || !isSameActiveRevision(current)) {
            pruneActiveDigestCoverage(eventId);
            return false;
        }
        try {
            workQueue.retire(current.notificationKey);
            cancelNotification(current.notificationKey);
            pruneActiveDigestCoverage(eventId);
            Log.i(TAG, "exact user-dismiss notification key cancellation requested");
            return true;
        } catch (Throwable error) {
            // The server row was already dismissed. Keep the durable user intent for reconnect
            // retry, remove Evogent's representation, and preserve the unverified Android original.
            pruneActiveDigestCoverage(eventId);
            logFailure("user-dismiss cancellation; original preserved", error);
            return false;
        }
    }

    private void reconcilePendingUserDismissals() {
        EvogentNotificationReceiptStore store = receiptStore;
        if (store == null || !isCurrentServiceGeneration()) return;
        for (String eventId : store.pendingUserDismissEventIds()) {
            // requestUserDismissInternal either repeats the exact revision-bound cancellation or,
            // when Android already removed it, prunes the rebound digest without touching a key.
            requestUserDismissInternal(eventId);
            // An unavailable active scan must also fail closed: the durable user dismissal still
            // removes Evogent's representation, while Android's unverified original is preserved.
            pruneActiveDigestCoverage(eventId);
        }
    }

    /**
     * Recover the only unambiguous crash side of automatic cancellation.
     *
     * If the exact staged original is still active, the old process did not complete replacement:
     * restore the receipt, retract its duplicate digest contribution, and let the reconnect scan
     * re-evaluate current settings. Absence is ambiguous (the listener cancellation most likely
     * completed before its callback), so retain the bounded replacement instead of inferring a
     * server tombstone from missing callback evidence.
     */
    private void reconcilePendingCuratedCancellations() {
        EvogentNotificationReceiptStore store = receiptStore;
        if (store == null || !isCurrentServiceGeneration()) return;
        StatusBarNotification[] active;
        try {
            active = getActiveNotifications();
        } catch (Throwable error) {
            logFailure("pending curated cancellation scan", error);
            return;
        }
        if (active == null) return;
        for (String eventId : store.pendingCuratedCancellationEventIds()) {
            EvogentNotificationReceiptStore.Record receipt = store.findByEventId(eventId);
            if (receipt == null) continue;
            boolean exactOriginalActive = false;
            for (StatusBarNotification candidate : active) {
                if (candidate == null
                        || !receipt.notificationKey.equals(candidate.getKey())
                        || receipt.postTimeMs != candidate.getPostTime()) {
                    continue;
                }
                Snapshot current = capture(candidate, false);
                exactOriginalActive = current != null && eventId.equals(current.eventId);
                break;
            }
            if (exactOriginalActive
                    && store.restoreReceiptAfterAbortedCancellation(eventId, false)) {
                pruneActiveDigestCoverage(eventId);
            }
        }
    }

    private void pruneResolvedLifecycleCoverage() {
        EvogentNotificationReceiptStore store = receiptStore;
        if (store == null || !isCurrentServiceGeneration()) return;
        for (String eventId : store.resolvedLifecycleEventIds()) {
            pruneActiveDigestCoverage(eventId);
        }
    }

    private boolean hasActiveDigestCovering(String eventId) {
        if (!isEventId(eventId)) return false;
        try {
            StatusBarNotification[] active = getActiveNotifications();
            if (active == null) return false;
            for (StatusBarNotification candidate : active) {
                if (candidate == null
                        || DIGEST_NOTIFICATION_ID != candidate.getId()
                        || !EvogentNotificationPolicy.EVOGENT_PACKAGE.equals(
                                candidate.getPackageName())
                        || candidate.getNotification() == null
                        || candidate.getNotification().extras == null
                        || serviceGeneration != candidate.getNotification().extras.getLong(
                                DIGEST_SERVICE_GENERATION_EXTRA)) {
                    continue;
                }
                ArrayList<String> covered =
                        candidate.getNotification().extras.getStringArrayList(
                                DIGEST_COVERED_EVENT_IDS_EXTRA);
                int activeCount = candidate.getNotification().extras.getInt(
                        DIGEST_ACTIVE_COUNT_EXTRA,
                        0);
                long expiresAtMs = candidate.getNotification().extras.getLong(
                        DIGEST_EXPIRES_AT_MS_EXTRA,
                        0L);
                return isValidCoverage(covered)
                        && activeCount == covered.size()
                        && EvogentNotificationPolicy.digestTimeoutAfterMs(
                                        expiresAtMs,
                                        System.currentTimeMillis())
                                > 0L
                        && covered.contains(eventId);
            }
        } catch (Throwable ignored) {
        }
        return false;
    }

    /**
     * Remove a durably resolved event from the active aggregate without requiring another post.
     *
     * The server owns rich ranking/text. Native knows only the ordered event digests, so a
     * lifecycle-only shrink intentionally falls back to a generic count until the next ingest
     * returns a freshly ranked aggregate.
     */
    private void pruneActiveDigestCoverage(String eventId) {
        if (!isEventId(eventId)) return;
        synchronized (DIGEST_PUBLICATION_LOCK) {
            if (!isCurrentServiceGeneration()) return;
            try {
                StatusBarNotification[] active = getActiveNotifications();
                if (active == null) return;
                for (StatusBarNotification candidate : active) {
                    if (candidate == null
                            || DIGEST_NOTIFICATION_ID != candidate.getId()
                            || !EvogentNotificationPolicy.EVOGENT_PACKAGE.equals(
                                    candidate.getPackageName())
                            || candidate.getNotification() == null
                            || candidate.getNotification().extras == null
                            || serviceGeneration != candidate.getNotification().extras.getLong(
                                    DIGEST_SERVICE_GENERATION_EXTRA)) {
                        continue;
                    }
                    ArrayList<String> covered = candidate.getNotification().extras
                            .getStringArrayList(DIGEST_COVERED_EVENT_IDS_EXTRA);
                    NotificationManager manager =
                            (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
                    if (manager == null) return;
                    int activeCount = candidate.getNotification().extras.getInt(
                            DIGEST_ACTIVE_COUNT_EXTRA,
                            0);
                    long expiresAtMs = candidate.getNotification().extras.getLong(
                            DIGEST_EXPIRES_AT_MS_EXTRA,
                            0L);
                    long timeoutAfterMs = EvogentNotificationPolicy.digestTimeoutAfterMs(
                            expiresAtMs,
                            System.currentTimeMillis());
                    if (Build.VERSION.SDK_INT < 26
                            || !isValidCoverage(covered)
                            || activeCount != covered.size()
                            || timeoutAfterMs <= 0L) {
                        manager.cancel(DIGEST_NOTIFICATION_ID);
                        return;
                    }
                    if (!covered.contains(eventId)) return;
                    ArrayList<String> remaining = new ArrayList<String>(covered);
                    remaining.remove(eventId);
                    int remainingActiveCount = Math.max(0, activeCount - 1);
                    if (remainingActiveCount == 0) {
                        manager.cancel(DIGEST_NOTIFICATION_ID);
                        return;
                    }

                    DigestMarker marker = new DigestMarker(
                            remaining.isEmpty() ? zeroEventId() : remaining.get(0),
                            serviceGeneration,
                            --nextLifecycleDigestSequence,
                            remaining,
                            remainingActiveCount,
                            expiresAtMs);
                    Bundle markerExtras = new Bundle();
                    markerExtras.putString(DIGEST_EVENT_ID_EXTRA, marker.eventId);
                    markerExtras.putLong(
                            DIGEST_SERVICE_GENERATION_EXTRA,
                            marker.serviceGeneration);
                    markerExtras.putLong(DIGEST_WORK_SEQUENCE_EXTRA, marker.workSequence);
                    markerExtras.putStringArrayList(
                            DIGEST_COVERED_EVENT_IDS_EXTRA,
                            new ArrayList<String>(remaining));
                    markerExtras.putInt(
                            DIGEST_ACTIVE_COUNT_EXTRA,
                            remainingActiveCount);
                    markerExtras.putLong(
                            DIGEST_EXPIRES_AT_MS_EXTRA,
                            marker.expiresAtMs);
                    String title = remainingActiveCount == 1
                            ? "1 curated notification"
                            : remainingActiveCount + " curated notifications";
                    String text = "Open Evogent to review.";
                    Notification current = candidate.getNotification();
                    Notification.Builder builder = Notification.Builder.recoverBuilder(
                            this,
                            current);
                    builder
                            .setPriority(Notification.PRIORITY_LOW)
                            .setDefaults(0)
                            .setSound(null)
                            .setVibrate(null)
                            .setOnlyAlertOnce(true)
                            .setAutoCancel(false)
                            .addExtras(markerExtras);
                    applyDigestDisplayContent(
                            this,
                            builder,
                            title,
                            text,
                            current.visibility == Notification.VISIBILITY_PUBLIC
                                    && isDetailedDigestPreviewModeLocked(this));
                    timeoutAfterMs = EvogentNotificationPolicy.digestTimeoutAfterMs(
                            marker.expiresAtMs,
                            System.currentTimeMillis());
                    if (timeoutAfterMs <= 0L) {
                        manager.cancel(DIGEST_NOTIFICATION_ID);
                        return;
                    }
                    builder.setTimeoutAfter(timeoutAfterMs);
                    manager.notify(DIGEST_NOTIFICATION_ID, builder.build());
                    return;
                }
            } catch (Throwable error) {
                logFailure("digest lifecycle shrink", error);
            }
        }
    }

    /**
     * Synchronize the native publication floor before or after the authenticated settings PATCH.
     *
     * Every transition changes the in-process generation while holding the same lock as final
     * digest publication. Private is persisted before this method returns. Arming Detailed also
     * sanitizes any existing digest: ranked Android content can return only from a later ingest
     * whose snapshot and server response both authorize the new generation.
     */
    static boolean synchronizeDigestPreviewMode(Context context, boolean detailedPreview) {
        if (context == null) return false;
        Context applicationContext = context.getApplicationContext();
        if (applicationContext == null) applicationContext = context;
        synchronized (DIGEST_PUBLICATION_LOCK) {
            String targetMode = detailedPreview
                    ? DIGEST_PREVIEW_DETAILED
                    : DIGEST_PREVIEW_PRIVATE;
            advanceDigestPreviewPolicyGenerationLocked();
            currentProcessDigestPreviewMode = targetMode;
            boolean persisted = persistDigestPreviewModeLocked(applicationContext, targetMode);
            boolean sanitized = sanitizeActiveDigestLocked(applicationContext);
            if (persisted && sanitized) return true;

            // A failed persistence or sanitizer must never leave Detailed armed. Retraction is a
            // safe fallback because Evogent does not own or mutate any source notification here.
            advanceDigestPreviewPolicyGenerationLocked();
            currentProcessDigestPreviewMode = DIGEST_PREVIEW_PRIVATE;
            persistDigestPreviewModeLocked(applicationContext, DIGEST_PREVIEW_PRIVATE);
            sanitizeActiveDigestLocked(applicationContext);
            return false;
        }
    }

    private static DigestPreviewFence captureDigestPreviewFence(Context context) {
        synchronized (DIGEST_PUBLICATION_LOCK) {
            return new DigestPreviewFence(
                    digestPreviewPolicyGeneration,
                    isDetailedDigestPreviewModeLocked(context));
        }
    }

    private static boolean mayPublishDetailedDigestLocked(
            Context context,
            Snapshot snapshot,
            String serverPreview) {
        return DIGEST_PREVIEW_DETAILED.equals(serverPreview)
                && snapshot != null
                && snapshot.detailedDigestPreviewAuthorized
                && snapshot.digestPreviewPolicyGeneration == digestPreviewPolicyGeneration
                && isDetailedDigestPreviewModeLocked(context);
    }

    private static boolean isDetailedDigestPreviewModeLocked(Context context) {
        if (currentProcessDigestPreviewMode == null) {
            String persistedMode = DIGEST_PREVIEW_PRIVATE;
            try {
                SharedPreferences preferences = context.getSharedPreferences(
                        DIGEST_PREVIEW_PREFERENCES,
                        Context.MODE_PRIVATE);
                String candidate = preferences.getString(
                        DIGEST_PREVIEW_MODE_KEY,
                        DIGEST_PREVIEW_PRIVATE);
                if (DIGEST_PREVIEW_DETAILED.equals(candidate)) {
                    persistedMode = DIGEST_PREVIEW_DETAILED;
                }
            } catch (Throwable ignored) {
                // Storage uncertainty fails closed for Android notification content.
            }
            currentProcessDigestPreviewMode = persistedMode;
        }
        return DIGEST_PREVIEW_DETAILED.equals(currentProcessDigestPreviewMode);
    }

    private static void advanceDigestPreviewPolicyGenerationLocked() {
        if (digestPreviewPolicyGeneration == Long.MAX_VALUE) {
            digestPreviewPolicyGeneration = 1L;
        } else {
            digestPreviewPolicyGeneration += 1L;
        }
    }

    private static boolean persistDigestPreviewModeLocked(Context context, String mode) {
        try {
            return context.getSharedPreferences(
                            DIGEST_PREVIEW_PREFERENCES,
                            Context.MODE_PRIVATE)
                    .edit()
                    .putString(DIGEST_PREVIEW_MODE_KEY, mode)
                    .commit();
        } catch (Throwable ignored) {
            return false;
        }
    }

    /**
     * Replace only Evogent's exact untagged digest. The recovered builder preserves its action,
     * marker, coverage, and absolute expiry; no source notification is read or changed.
     */
    private static boolean sanitizeActiveDigestLocked(Context context) {
        if (Build.VERSION.SDK_INT < 26) return true;
        NotificationManager manager =
                (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return false;
        try {
            StatusBarNotification[] active = manager.getActiveNotifications();
            if (active == null) return false;
            for (StatusBarNotification candidate : active) {
                if (candidate == null
                        || candidate.getTag() != null
                        || candidate.getId() != DIGEST_NOTIFICATION_ID
                        || !EvogentNotificationPolicy.EVOGENT_PACKAGE.equals(
                                candidate.getPackageName())) {
                    continue;
                }
                Notification current = candidate.getNotification();
                if (current == null
                        || current.extras == null
                        || !DIGEST_CHANNEL_ID.equals(current.getChannelId())) {
                    manager.cancel(DIGEST_NOTIFICATION_ID);
                    return true;
                }
                ArrayList<String> covered = current.extras.getStringArrayList(
                        DIGEST_COVERED_EVENT_IDS_EXTRA);
                int activeCount = current.extras.getInt(DIGEST_ACTIVE_COUNT_EXTRA, 0);
                long expiresAtMs = current.extras.getLong(
                        DIGEST_EXPIRES_AT_MS_EXTRA,
                        0L);
                long timeoutAfterMs = EvogentNotificationPolicy.digestTimeoutAfterMs(
                        expiresAtMs,
                        System.currentTimeMillis());
                if (!isValidCoverage(covered)
                        || activeCount <= 0
                        || activeCount != covered.size()
                        || timeoutAfterMs <= 0L) {
                    manager.cancel(DIGEST_NOTIFICATION_ID);
                    return true;
                }
                Notification.Builder builder = Notification.Builder.recoverBuilder(
                        context,
                        current);
                builder
                        .setPriority(Notification.PRIORITY_LOW)
                        .setDefaults(0)
                        .setSound(null)
                        .setVibrate(null)
                        .setOnlyAlertOnce(true)
                        .setAutoCancel(false)
                        .setTimeoutAfter(timeoutAfterMs);
                applyDigestDisplayContent(context, builder, null, null, false);
                manager.notify(DIGEST_NOTIFICATION_ID, builder.build());
                return true;
            }
            return true;
        } catch (Throwable error) {
            try {
                manager.cancel(DIGEST_NOTIFICATION_ID);
            } catch (Throwable ignored) {
            }
            logFailure("digest preview synchronization", error);
            return false;
        }
    }

    /**
     * Private is an Evogent privacy choice, not a request to defer to Android's global
     * "show sensitive notification content" preference. Keep the primary native notification
     * generic in Private mode so both the shade and secure lock screen are safe under either OS
     * preference. Ranked detail remains in Evogent's authenticated Notifications view. Detailed
     * mode is the only mode that puts the ranked summary in Android's notification surface.
     */
    private static void applyDigestDisplayContent(
            Context context,
            Notification.Builder builder,
            String rankedTitle,
            String rankedText,
            boolean detailedPreview) {
        String visibleTitle = detailedPreview ? rankedTitle : PRIVATE_DIGEST_TITLE;
        String visibleText = detailedPreview ? rankedText : PRIVATE_DIGEST_TEXT;
        builder
                .setContentTitle(visibleTitle)
                .setContentText(visibleText)
                .setStyle(new Notification.BigTextStyle().bigText(visibleText))
                .setVisibility(detailedPreview
                        ? Notification.VISIBILITY_PUBLIC
                        : Notification.VISIBILITY_PRIVATE);
        if (!detailedPreview) {
            Notification.Builder publicBuilder = Build.VERSION.SDK_INT >= 26
                    ? new Notification.Builder(context, DIGEST_CHANNEL_ID)
                    : new Notification.Builder(context);
            builder.setPublicVersion(publicBuilder
                    .setSmallIcon(R.drawable.ic_evogent)
                    .setContentTitle(PRIVATE_DIGEST_TITLE)
                    .setContentText(PRIVATE_DIGEST_TEXT)
                    .setCategory(Notification.CATEGORY_STATUS)
                    .setPriority(Notification.PRIORITY_LOW)
                    .setDefaults(0)
                    .setSound(null)
                    .setVibrate(null)
                    .setVisibility(Notification.VISIBILITY_PUBLIC)
                    .build());
        }
    }

    private void ensureDigestChannel(NotificationManager manager) {
        if (Build.VERSION.SDK_INT < 26
                || manager.getNotificationChannel(DIGEST_CHANNEL_ID) != null) {
            return;
        }
        NotificationChannel channel = new NotificationChannel(
                DIGEST_CHANNEL_ID,
                "Curated notifications",
                NotificationManager.IMPORTANCE_LOW);
        channel.setDescription(
                "One silent private Evogent digest for eligible notifications you chose to curate.");
        channel.setLockscreenVisibility(Notification.VISIBILITY_PRIVATE);
        channel.setSound(null, null);
        channel.enableVibration(false);
        channel.enableLights(false);
        channel.setShowBadge(false);
        manager.createNotificationChannel(channel);
    }

    private String applicationLabel(String packageName) {
        try {
            ApplicationInfo info = getPackageManager().getApplicationInfo(packageName, 0);
            CharSequence label = getPackageManager().getApplicationLabel(info);
            return EvogentNotificationPolicy.normalize(
                    label == null ? null : label.toString(),
                    120);
        } catch (Throwable ignored) {
            return null;
        }
    }

    private static String firstText(Bundle extras, String... keys) {
        if (extras == null) return null;
        for (String key : keys) {
            try {
                CharSequence value = extras.getCharSequence(key);
                String normalized = EvogentNotificationPolicy.normalize(
                        value == null ? null : value.toString(),
                        4096);
                if (normalized != null) return normalized;
            } catch (Throwable ignored) {
            }
        }
        return null;
    }

    private static String boundedResponseText(
            String value,
            String fallback,
            int maxChars) {
        String normalized = EvogentNotificationPolicy.normalize(value, maxChars);
        return normalized == null ? fallback : normalized;
    }

    private static boolean isEventId(String value) {
        if (value == null || value.length() != 64) return false;
        for (int index = 0; index < value.length(); index++) {
            char current = value.charAt(index);
            if (!((current >= '0' && current <= '9')
                    || (current >= 'a' && current <= 'f'))) {
                return false;
            }
        }
        return true;
    }

    private static String zeroEventId() {
        return "0000000000000000000000000000000000000000000000000000000000000000";
    }

    private static void logFailure(String operation, Throwable error) {
        String kind = error == null ? "unknown" : error.getClass().getSimpleName();
        Log.w(TAG, operation + " (" + kind + ")");
    }

    private static final class DigestMarker {
        final String eventId;
        final long serviceGeneration;
        final long workSequence;
        final ArrayList<String> coveredEventIds;
        final int activeCount;
        final long expiresAtMs;

        DigestMarker(
                String eventId,
                long serviceGeneration,
                long workSequence,
                ArrayList<String> coveredEventIds,
                int activeCount,
                long expiresAtMs) {
            this.eventId = eventId;
            this.serviceGeneration = serviceGeneration;
            this.workSequence = workSequence;
            this.coveredEventIds = new ArrayList<String>(coveredEventIds);
            this.activeCount = activeCount;
            this.expiresAtMs = expiresAtMs;
        }

        boolean covers(String candidateEventId) {
            return coveredEventIds.contains(candidateEventId);
        }

        boolean hasSameCoverage(ArrayList<String> candidate) {
            return candidate != null && coveredEventIds.equals(candidate);
        }
    }

    private static final class NotificationWork {
        final StatusBarNotification notification;
        final String removedEventId;

        private NotificationWork(
                StatusBarNotification notification,
                String removedEventId) {
            this.notification = notification;
            this.removedEventId = removedEventId;
        }

        static NotificationWork posted(StatusBarNotification notification) {
            return new NotificationWork(notification, null);
        }

        static NotificationWork removed(String eventId) {
            return new NotificationWork(null, eventId);
        }
    }

    private static final class DigestPreviewFence {
        final long policyGeneration;
        final boolean detailedAuthorized;

        DigestPreviewFence(long policyGeneration, boolean detailedAuthorized) {
            this.policyGeneration = policyGeneration;
            this.detailedAuthorized = detailedAuthorized;
        }
    }

    private static final class Snapshot {
        final String notificationKey;
        final long postTimeMs;
        final String eventId;
        final boolean historical;
        final EvogentNotificationPolicy.Decision decision;
        final JSONObject request;
        final long digestPreviewPolicyGeneration;
        final boolean detailedDigestPreviewAuthorized;

        Snapshot(
                String notificationKey,
                long postTimeMs,
                String eventId,
                boolean historical,
                EvogentNotificationPolicy.Decision decision,
                JSONObject request,
                long digestPreviewPolicyGeneration,
                boolean detailedDigestPreviewAuthorized) {
            this.notificationKey = notificationKey;
            this.postTimeMs = postTimeMs;
            this.eventId = eventId;
            this.historical = historical;
            this.decision = decision;
            this.request = request;
            this.digestPreviewPolicyGeneration = digestPreviewPolicyGeneration;
            this.detailedDigestPreviewAuthorized = detailedDigestPreviewAuthorized;
        }
    }
}

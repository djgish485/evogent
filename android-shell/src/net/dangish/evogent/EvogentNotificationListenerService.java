package net.dangish.evogent;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.os.Build;
import android.os.Bundle;
import android.os.SystemClock;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;
import android.util.Log;

import org.json.JSONObject;

/**
 * Local notification-curation bridge.
 *
 * Android grants listener access to every app at once, so this service applies privacy and
 * safety policy before constructing an authenticated loopback request. It never reads action
 * PendingIntents, RemoteViews, message bundles, or attachments. Known secrets are removed before
 * transport. Work runs on one bounded worker. Before any key-cancellation request, overload or
 * failure leaves Android's original notification untouched.
 *
 * OBSERVE is the server's safe default, and CURATED still preserves every Android original
 * unless the user separately allows best-effort replacement for that package. Protected events
 * always remain Android-owned. For an allowed ordinary event the listener requires a matching
 * durable receipt, an active Evogent digest, and a still-matching generation immediately before
 * asking Android to cancel. Android cancellation is key-only rather than an atomic generation
 * compare, so the UI and docs describe that final narrow race truthfully.
 */
public final class EvogentNotificationListenerService extends NotificationListenerService {
    private static final String TAG = "EvogentNotif";
    private static final String INGEST_URL = EvogentSecurityPolicy.PHONE_NOTIFICATION_INGEST_URL;
    private static final String DIGEST_CHANNEL_ID = "evogent_curated_notifications_v1";
    private static final int DIGEST_NOTIFICATION_ID = 0x45564f4e;
    private static final int MAX_LIVE_PENDING_EVENTS = 16;
    private static final int MAX_HISTORICAL_PENDING_EVENTS = 128;
    private static final int NOTIFICATION_NETWORK_BUDGET_MS = 2000;
    private static final int DIGEST_VERIFY_BUDGET_MS = 750;
    private static final String DIGEST_EVENT_ID_EXTRA = "evogent_event_id";
    private static final String DIGEST_SERVICE_GENERATION_EXTRA =
            "evogent_service_generation";
    private static final String DIGEST_WORK_SEQUENCE_EXTRA = "evogent_work_sequence";
    private static final Object DIGEST_PUBLICATION_LOCK = new Object();
    private static long nextServiceGeneration;
    private static long activeServiceGeneration;

    private final EvogentNotificationWorkQueue<StatusBarNotification> workQueue =
            new EvogentNotificationWorkQueue<StatusBarNotification>(
                    MAX_LIVE_PENDING_EVENTS,
                    MAX_HISTORICAL_PENDING_EVENTS);
    private volatile boolean workerRunning;
    private volatile long newestAppliedLiveDigestSequence;
    private long serviceGeneration;
    private Thread workerThread;

    @Override
    public void onCreate() {
        super.onCreate();
        synchronized (DIGEST_PUBLICATION_LOCK) {
            serviceGeneration = ++nextServiceGeneration;
            activeServiceGeneration = serviceGeneration;
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
        Log.i(TAG, "listener connected; active scan queued");
    }

    @Override
    public void onNotificationPosted(StatusBarNotification notification) {
        enqueue(notification, false);
    }

    @Override
    public void onDestroy() {
        workerRunning = false;
        synchronized (DIGEST_PUBLICATION_LOCK) {
            if (activeServiceGeneration == serviceGeneration) {
                activeServiceGeneration = 0L;
            }
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
                EvogentNotificationWorkQueue.Entry<StatusBarNotification> entry =
                        workQueue.take();
                try {
                    ingest(entry);
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
                ? workQueue.offer(notification, historical, notification.getKey())
                : EvogentNotificationWorkQueue.OfferResult.REJECTED;
        if (!result.accepted()) {
            // Safe shutdown/overload behavior: no server receipt means no cancellation.
            Log.w(TAG, "notification queue unavailable; original preserved");
        } else if (result == EvogentNotificationWorkQueue.OfferResult.EVICTED_OLDEST_LIVE) {
            Log.w(TAG, "stale live curation work evicted; Android original preserved");
        }
    }

    private void ingest(
            EvogentNotificationWorkQueue.Entry<StatusBarNotification> entry) {
        try {
            Snapshot snapshot = capture(entry.value, entry.historical);
            if (snapshot == null || !snapshot.decision.ingest) return;

            long networkDeadlineElapsedMs =
                    SystemClock.elapsedRealtime() + NOTIFICATION_NETWORK_BUDGET_MS;
            JSONObject response = EvogentLoopbackAuth.postJsonDirectForJsonBefore(
                    this,
                    INGEST_URL,
                    snapshot.request.toString(),
                    networkDeadlineElapsedMs);
            if (!isCurrentWork(entry)) return;
            applyResponse(entry, snapshot, response);
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
        return new Snapshot(
                sbn.getKey(),
                sbn.getPostTime(),
                eventId,
                historical,
                decision,
                request);
    }

    private void applyResponse(
            EvogentNotificationWorkQueue.Entry<StatusBarNotification> entry,
            Snapshot snapshot,
            JSONObject response) {
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
            // The live lane is newest-first. An older distinct event may remain queued after a
            // newer digest was already published. It is still useful to persist that event, but
            // it must never regress the shared digest or cancel its Android original afterward.
            if (wouldRegressAppliedLiveDigest(entry)) return;
            boolean digestCapability = hasDigestCapability();
            boolean digestActive = false;
            DigestMarker digestMarker = null;
            if ("curated".equals(mode)
                    && replacementAllowed
                    && serverRequestedSuppression
                    && receiptMatches
                    && digestCapability) {
                if (!isPublicationCurrent(entry, snapshot)) return;
                digestMarker = new DigestMarker(
                        snapshot.eventId,
                        serviceGeneration,
                        entry.liveSequence);
                digestActive = publishAndVerifyDigest(
                        digest,
                        digestMarker,
                        entry,
                        snapshot);
            }
            if (digestActive && !isPublicationCurrent(entry, snapshot)) {
                retractDigestIfOwned(digestMarker);
                return;
            }
            if (digestActive) {
                markLiveDigestApplied(entry);
            }
            if (!isCurrentWork(entry)
                    || wouldRegressAppliedLiveDigest(entry)) {
                if (digestActive) retractDigestIfOwned(digestMarker);
                return;
            }
            boolean revisionMatches = isSameActiveRevision(snapshot);
            if (!revisionMatches) {
                if (digestActive) retractDigestIfOwned(digestMarker);
                return;
            }

            boolean shouldRequestKeyCancellation =
                    isCurrentWork(entry)
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
                // Public Android APIs cancel by stable notification key, not by an atomic
                // event-version token. The immediately preceding generation checks narrow that
                // unavoidable race; explicit per-package user consent bounds who can enter it.
                cancelNotification(snapshot.notificationKey);
                Log.i(TAG, "allowlisted notification key cancellation requested");
            } else if (digestActive) {
                retractDigestIfOwned(digestMarker);
            }
        } catch (Throwable error) {
            logFailure("response validation; original preserved", error);
        }
    }

    private boolean isCurrentWork(
            EvogentNotificationWorkQueue.Entry<StatusBarNotification> entry) {
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
            EvogentNotificationWorkQueue.Entry<StatusBarNotification> entry,
            Snapshot snapshot) {
        return isCurrentWork(entry)
                && !wouldRegressAppliedLiveDigest(entry)
                && hasDigestCapability()
                && isSameActiveRevision(snapshot);
    }

    private boolean wouldRegressAppliedLiveDigest(
            EvogentNotificationWorkQueue.Entry<StatusBarNotification> entry) {
        return entry != null
                && !entry.historical
                && entry.liveSequence > 0L
                && entry.liveSequence < newestAppliedLiveDigestSequence;
    }

    private void markLiveDigestApplied(
            EvogentNotificationWorkQueue.Entry<StatusBarNotification> entry) {
        if (entry != null
                && !entry.historical
                && entry.liveSequence > newestAppliedLiveDigestSequence) {
            newestAppliedLiveDigestSequence = entry.liveSequence;
        }
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
            NotificationManager manager =
                    (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (manager == null || !manager.areNotificationsEnabled()) return false;
            ensureDigestChannel(manager);
            if (Build.VERSION.SDK_INT >= 26) {
                NotificationChannel channel =
                        manager.getNotificationChannel(DIGEST_CHANNEL_ID);
                return channel != null
                        && channel.getImportance() != NotificationManager.IMPORTANCE_NONE;
            }
            return true;
        } catch (Throwable ignored) {
            return false;
        }
    }

    private boolean publishAndVerifyDigest(
            JSONObject digest,
            DigestMarker marker,
            EvogentNotificationWorkQueue.Entry<StatusBarNotification> entry,
            Snapshot snapshot) {
        if (digest == null || marker == null) return false;
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

            Intent open = new Intent(this, MainActivity.class)
                    .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP
                            | Intent.FLAG_ACTIVITY_SINGLE_TOP)
                    .putExtra("evogent_open_notifications", true);
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
            builder
                    .setSmallIcon(R.drawable.ic_evogent)
                    .setContentTitle(title)
                    .setContentText(text)
                    .setStyle(new Notification.BigTextStyle().bigText(text))
                    .setContentIntent(contentIntent)
                    .setCategory(Notification.CATEGORY_STATUS)
                    .setOnlyAlertOnce(true)
                    .setAutoCancel(true)
                    .setLocalOnly(true)
                    .addExtras(receiptMarker)
                    .setVisibility("detailed".equals(preview)
                            ? Notification.VISIBILITY_PUBLIC
                            : Notification.VISIBILITY_PRIVATE);

            if (!"detailed".equals(preview)) {
                Notification.Builder publicBuilder = Build.VERSION.SDK_INT >= 26
                        ? new Notification.Builder(this, DIGEST_CHANNEL_ID)
                        : new Notification.Builder(this);
                builder.setPublicVersion(publicBuilder
                        .setSmallIcon(R.drawable.ic_evogent)
                        .setContentTitle("Evogent")
                        .setContentText("Curated notifications are ready.")
                        .setCategory(Notification.CATEGORY_STATUS)
                        .setVisibility(Notification.VISIBILITY_PUBLIC)
                        .build());
            }

            Notification built = builder.build();
            synchronized (DIGEST_PUBLICATION_LOCK) {
                // This is the final service/work/revision check before the key-owned digest is
                // replaced. Holding the process-wide lock orders old/new service instances.
                if (!isPublicationCurrent(entry, snapshot)) return false;
                manager.notify(DIGEST_NOTIFICATION_ID, built);
            }
            long deadline = SystemClock.elapsedRealtime() + DIGEST_VERIFY_BUDGET_MS;
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
                SystemClock.sleep(50L);
            } while (SystemClock.elapsedRealtime() < deadline);
        } catch (Throwable error) {
            logFailure("digest publication", error);
        }
        retractDigestIfOwned(marker);
        return false;
    }

    private boolean isDigestActive(DigestMarker marker) {
        if (marker == null) return false;
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
                                        DIGEST_WORK_SEQUENCE_EXTRA)) {
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
            try {
                NotificationManager manager =
                        (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
                if (manager != null) {
                    manager.cancel(DIGEST_NOTIFICATION_ID);
                }
            } catch (Throwable error) {
                logFailure("stale digest retraction", error);
            }
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
                NotificationManager.IMPORTANCE_DEFAULT);
        channel.setDescription(
                "One private Evogent digest for eligible notifications you chose to curate.");
        channel.setLockscreenVisibility(Notification.VISIBILITY_PRIVATE);
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

    private static void logFailure(String operation, Throwable error) {
        String kind = error == null ? "unknown" : error.getClass().getSimpleName();
        Log.w(TAG, operation + " (" + kind + ")");
    }

    private static final class DigestMarker {
        final String eventId;
        final long serviceGeneration;
        final long workSequence;

        DigestMarker(String eventId, long serviceGeneration, long workSequence) {
            this.eventId = eventId;
            this.serviceGeneration = serviceGeneration;
            this.workSequence = workSequence;
        }
    }

    private static final class Snapshot {
        final String notificationKey;
        final long postTimeMs;
        final String eventId;
        final boolean historical;
        final EvogentNotificationPolicy.Decision decision;
        final JSONObject request;

        Snapshot(
                String notificationKey,
                long postTimeMs,
                String eventId,
                boolean historical,
                EvogentNotificationPolicy.Decision decision,
                JSONObject request) {
            this.notificationKey = notificationKey;
            this.postTimeMs = postTimeMs;
            this.eventId = eventId;
            this.historical = historical;
            this.decision = decision;
            this.request = request;
        }
    }
}

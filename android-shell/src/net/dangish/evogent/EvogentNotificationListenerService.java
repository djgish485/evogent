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

import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

/**
 * Local notification-curation bridge.
 *
 * Android grants listener access to every app at once, so this service applies privacy and
 * safety policy before constructing an authenticated loopback request. It never reads action
 * PendingIntents, RemoteViews, message bundles, or attachments. Known secrets are removed before
 * transport. Work runs on one bounded worker; overload or any failure leaves Android's original
 * notification untouched.
 *
 * OBSERVE is the server's safe default. In explicitly selected CURATED mode, only a clearable,
 * non-urgent notification may be replaced, and only after (1) the exact package/key/post-time/
 * content generation has a durable server receipt, (2) Evogent's digest is enabled and visible,
 * and (3) that exact generation is still active. NotificationListenerService sees notifications
 * after Android posts them, so an eligible original can appear briefly before replacement.
 */
public final class EvogentNotificationListenerService extends NotificationListenerService {
    private static final String TAG = "EvogentNotif";
    private static final String INGEST_URL = EvogentSecurityPolicy.PHONE_NOTIFICATION_INGEST_URL;
    private static final String DIGEST_CHANNEL_ID = "evogent_curated_notifications_v1";
    private static final int DIGEST_NOTIFICATION_ID = 0x45564f4e;
    private static final int MAX_PENDING_EVENTS = 128;

    private final ThreadPoolExecutor worker = new ThreadPoolExecutor(
            1,
            1,
            20L,
            TimeUnit.SECONDS,
            new ArrayBlockingQueue<Runnable>(MAX_PENDING_EVENTS),
            new ThreadFactory() {
                @Override public Thread newThread(Runnable runnable) {
                    Thread thread = new Thread(runnable, "evogent-notification-curation");
                    thread.setDaemon(true);
                    return thread;
                }
            },
            new ThreadPoolExecutor.DiscardOldestPolicy());

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
        worker.shutdownNow();
        super.onDestroy();
    }

    private void enqueue(
            final StatusBarNotification notification,
            final boolean historical) {
        if (notification == null) return;
        try {
            worker.execute(new Runnable() {
                @Override public void run() {
                    ingest(notification, historical);
                }
            });
        } catch (RejectedExecutionException rejected) {
            // Safe overload behavior: no server receipt means no cancellation.
            Log.w(TAG, "notification queue unavailable; original preserved");
        }
    }

    private void ingest(StatusBarNotification notification, boolean historical) {
        try {
            Snapshot snapshot = capture(notification, historical);
            if (snapshot == null || !snapshot.decision.ingest) return;

            JSONObject response = EvogentLoopbackAuth.postJsonDirectForJson(
                    this,
                    INGEST_URL,
                    snapshot.request.toString(),
                    6000,
                    6000);
            applyResponse(snapshot, response);
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
                packageName,
                sbn.getKey(),
                sbn.getPostTime(),
                title,
                text,
                subText);
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

    private void applyResponse(Snapshot snapshot, JSONObject response) {
        try {
            if (response == null || !response.optBoolean("ok", false)) return;
            JSONObject receipt = response.optJSONObject("receipt");
            JSONObject policy = response.optJSONObject("policy");
            JSONObject digest = response.optJSONObject("digest");
            if (receipt == null || policy == null || digest == null) return;

            String receiptEventId = receipt.optString("eventId", "");
            boolean persisted = receipt.optBoolean("persisted", false);
            String mode = policy.optString("mode", "");
            boolean serverRequestedSuppression =
                    policy.optBoolean("suppressOriginal", false);
            boolean digestCapability = hasDigestCapability();
            boolean digestActive = false;
            if ("curated".equals(mode)
                    && serverRequestedSuppression
                    && digestCapability) {
                digestActive = publishAndVerifyDigest(digest, snapshot.eventId);
            }
            boolean revisionMatches = isSameActiveRevision(snapshot);

            if (EvogentNotificationPolicy.shouldCancelOriginal(
                    snapshot.decision,
                    snapshot.eventId,
                    receiptEventId,
                    persisted,
                    mode,
                    serverRequestedSuppression,
                    digestCapability,
                    digestActive,
                    revisionMatches)) {
                cancelNotification(snapshot.notificationKey);
                Log.i(TAG, "eligible notification replaced after exact durable receipt");
            }
        } catch (Throwable error) {
            logFailure("response validation; original preserved", error);
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
                return current != null && expected.eventId.equals(current.eventId);
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

    private boolean publishAndVerifyDigest(JSONObject digest, String eventId) {
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
            receiptMarker.putString("evogent_event_id", eventId);
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

            manager.notify(DIGEST_NOTIFICATION_ID, builder.build());
            long deadline = SystemClock.elapsedRealtime() + 750L;
            do {
                if (isDigestActive(eventId)) return true;
                SystemClock.sleep(50L);
            } while (SystemClock.elapsedRealtime() < deadline);
        } catch (Throwable error) {
            logFailure("digest publication", error);
        }
        return false;
    }

    private boolean isDigestActive(String expectedEventId) {
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
                        && expectedEventId.equals(candidate.getNotification().extras.getString(
                                "evogent_event_id"))) {
                    return true;
                }
            }
        } catch (Throwable ignored) {
        }
        return false;
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

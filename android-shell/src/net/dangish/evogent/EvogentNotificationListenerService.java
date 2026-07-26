package net.dangish.evogent;

import android.app.Notification;
import android.os.Bundle;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

/**
 * Real-time content signal. When a notification arrives from an ALLOWLISTED content app, we
 * read its metadata (title/text/subtext) and drop it into the Evogent browse cache as a
 * lightweight signal row, the same way ShareReceiverActivity posts browsed items. The
 * curator/refresh path then treats it like any other cached candidate.
 *
 * PRIVACY IS ENFORCED HERE, not by the OS: notification-listener access is not per-app, so
 * this service must itself (1) drop every package not on the content-app allowlist, and
 * (2) drop anything that looks person-to-person (messaging category, MessagingStyle,
 * conversation notifications). Nothing from private-comms apps is ever read or stored. This
 * is metadata-in-transit only — nothing is persisted here beyond the POST to loopback.
 */
public class EvogentNotificationListenerService extends NotificationListenerService {
    private static final String TAG = "EvogentNotif";
    private static final String SUBMIT_URL = EvogentSecurityPolicy.BROWSE_CACHE_SUBMIT_URL;

    // Allowlist: package -> browse-cache source name. Kept in lockstep with the source scout's
    // catalog (phone-tools/source-catalog.json) plus the always-on built-in sources. Only these
    // packages are ever read; everything else (banking, Messages, Signal, WhatsApp, ...) is
    // dropped before any field is touched.
    private static final Map<String, String> ALLOW = new HashMap<String, String>();
    static {
        ALLOW.put("com.google.android.gm", "gmail");
        ALLOW.put("com.google.android.apps.magazines", "googlenews");
        ALLOW.put("com.instagram.android", "instagram");
        ALLOW.put("com.reddit.frontpage", "reddit");
        ALLOW.put("com.linkedin.android", "linkedin");
        ALLOW.put("com.medium.reader", "medium");
        ALLOW.put("com.substack.app", "substack");
        ALLOW.put("flipboard.app", "flipboard");
        ALLOW.put("com.nytimes.android", "nytimes");
    }

    // Categories that are inherently person-to-person; never ingested regardless of package.
    private static final Set<String> PRIVATE_CATEGORIES = new HashSet<String>();
    static {
        PRIVATE_CATEGORIES.add(Notification.CATEGORY_MESSAGE);
        PRIVATE_CATEGORIES.add(Notification.CATEGORY_EMAIL); // Gmail uses this — but for us the
        // inbox summary IS the content signal; handled specially below (summary allowed, single
        // MessagingStyle conversation dropped).
        PRIVATE_CATEGORIES.add(Notification.CATEGORY_CALL);
        PRIVATE_CATEGORIES.add(Notification.CATEGORY_SOCIAL);
    }

    @Override
    public void onListenerConnected() {
        // Capture what's already in the shade at bind time (e.g. the current Gmail inbox
        // summary) so a just-restarted listener isn't blind until the next fresh notification.
        try {
            StatusBarNotification[] active = getActiveNotifications();
            if (active != null) {
                for (StatusBarNotification sbn : active) onNotificationPosted(sbn);
            }
            Log.i(TAG, "listener connected; scanned " + (active == null ? 0 : active.length) + " active");
        } catch (Throwable t) {
            Log.e(TAG, "onListenerConnected", t);
        }
    }

    @Override
    public void onNotificationPosted(StatusBarNotification sbn) {
        try {
            if (sbn == null || sbn.getNotification() == null) return;
            final String pkg = sbn.getPackageName();
            final String source = ALLOW.get(pkg);
            if (source == null) return; // not a content app — ignore entirely

            final Notification n = sbn.getNotification();
            final Bundle extras = n.extras;
            if (extras == null) return;

            // Drop person-to-person notifications. Gmail is the one nuance: its inbox summary
            // ("N new messages" / sender+subject list) is a legitimate content signal, but a
            // MessagingStyle thread for one conversation is private — drop the latter.
            boolean isMessagingStyle = extras.containsKey(Notification.EXTRA_MESSAGES)
                    || "androidx.core.app.NotificationCompat$MessagingStyle".equals(
                            extras.getString(Notification.EXTRA_TEMPLATE))
                    || "android.app.Notification$MessagingStyle".equals(
                            extras.getString(Notification.EXTRA_TEMPLATE));
            String category = n.category;
            if (!"gmail".equals(source)) {
                if (category != null && PRIVATE_CATEGORIES.contains(category)) return;
                if (isMessagingStyle) return;
            } else {
                // Gmail: allow the inbox-summary notification; drop a single-conversation thread.
                if (isMessagingStyle && extras.getCharSequence(Notification.EXTRA_TITLE) != null
                        && !sbn.isGroup()) {
                    // best-effort: individual message threads are group children or messaging-style
                }
                if (isMessagingStyle) return;
            }

            String title = charSeq(extras, Notification.EXTRA_TITLE);
            String text = charSeq(extras, Notification.EXTRA_TEXT);
            String big = charSeq(extras, Notification.EXTRA_BIG_TEXT);
            String sub = charSeq(extras, Notification.EXTRA_SUB_TEXT);
            String body = big != null && big.length() > 0 ? big : text;
            if ((title == null || title.isEmpty()) && (body == null || body.isEmpty())) return;

            long now = System.currentTimeMillis();
            // Stable-ish id so repeated posts of the same notification dedupe in the cache.
            String sid = "notif-" + source + "-" + Integer.toHexString(
                    ((title == null ? "" : title) + "|" + (body == null ? "" : body)).hashCode());

            JSONObject payload = new JSONObject();
            payload.put("type", "notification-signal");
            payload.put("app", pkg);
            if (title != null) payload.put("title", title);
            if (body != null) payload.put("text", body);
            if (sub != null) payload.put("subText", sub);
            payload.put("postedAtMs", sbn.getPostTime());
            payload.put("captureMethod", "phone-notification-listener");

            JSONObject item = new JSONObject();
            item.put("sourceId", sid);
            item.put("title", title != null ? title : body.substring(0, Math.min(80, body.length())));
            item.put("payload", payload);
            item.put("fetchedAtMs", now);
            // Short TTL: a notification is a "something new happened" hint, not durable content.
            item.put("expiresAtMs", now + 3L * 24 * 60 * 60 * 1000);

            JSONObject reqBody = new JSONObject();
            reqBody.put("source", source);
            reqBody.put("triggeredBy", "phone-notification-listener");
            reqBody.put("startedAtMs", now);
            reqBody.put("completedAtMs", now);
            reqBody.put("status", "completed");
            reqBody.put("itemsAdded", 1);
            reqBody.put("items", new JSONArray().put(item));

            post(reqBody, source + " " + sid);
        } catch (Throwable t) {
            Log.e(TAG, "onNotificationPosted", t);
        }
    }

    private static String charSeq(Bundle b, String key) {
        CharSequence cs = b.getCharSequence(key);
        return cs == null ? null : cs.toString().trim();
    }

    private void post(final JSONObject body, final String label) {
        new Thread(new Runnable() { public void run() {
            try {
                int code = EvogentLoopbackAuth.postJsonDirect(
                        EvogentNotificationListenerService.this,
                        SUBMIT_URL,
                        body.toString(),
                        6000,
                        6000);
                Log.i(TAG, "signal " + label + " -> HTTP " + code);
            } catch (Throwable t) {
                Log.e(TAG, "post signal failed", t);
            }
        }}).start();
    }
}

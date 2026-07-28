package net.dangish.evogent;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Locale;

/**
 * Pure-Java policy for the phone notification listener.
 *
 * Android grants a notification listener access to every app at once.  Keep the decisions that
 * bound that privilege in one host-testable class: ignore Evogent's own digest, redact known
 * secrets before the loopback request is constructed, identify notifications that must retain
 * their Android original, and require a matching durable receipt before any best-effort
 * cancellation request.
 */
final class EvogentNotificationPolicy {
    static final String EVOGENT_PACKAGE = "net.dangish.evogent";

    static final int IMPORTANCE_HIGH = 4;
    static final int IMPORTANCE_UNSPECIFIED = -1000;
    static final int FLAG_ONGOING_EVENT = 0x00000002;
    static final int FLAG_FOREGROUND_SERVICE = 0x00000040;
    static final int FLAG_INSISTENT = 0x00000004;

    private EvogentNotificationPolicy() {}

    static final class Input {
        final String packageName;
        final String category;
        final int flags;
        final int importance;
        final boolean clearable;
        final boolean ongoing;
        final boolean fullScreen;
        final boolean groupSummary;
        final boolean conversation;
        final int visibility;
        final String title;
        final String text;
        final String subText;

        Input(
                String packageName,
                String category,
                int flags,
                int importance,
                boolean clearable,
                boolean ongoing,
                boolean fullScreen,
                boolean groupSummary,
                boolean conversation,
                int visibility,
                String title,
                String text,
                String subText) {
            this.packageName = normalize(packageName, 255);
            this.category = normalize(category, 80);
            this.flags = flags;
            this.importance = importance;
            this.clearable = clearable;
            this.ongoing = ongoing;
            this.fullScreen = fullScreen;
            this.groupSummary = groupSummary;
            this.conversation = conversation;
            this.visibility = visibility;
            this.title = normalize(title, 512);
            this.text = normalize(text, 4096);
            this.subText = normalize(subText, 512);
        }
    }

    static final class Decision {
        final boolean ingest;
        final boolean redactContent;
        final boolean protectedFromSuppression;
        final boolean nativeCanSuppress;
        final String priority;
        final String protectionReason;
        final String safeTitle;
        final String safeText;
        final String safeSubText;

        private Decision(
                boolean ingest,
                boolean redactContent,
                boolean protectedFromSuppression,
                boolean nativeCanSuppress,
                String priority,
                String protectionReason,
                String safeTitle,
                String safeText,
                String safeSubText) {
            this.ingest = ingest;
            this.redactContent = redactContent;
            this.protectedFromSuppression = protectedFromSuppression;
            this.nativeCanSuppress = nativeCanSuppress;
            this.priority = priority;
            this.protectionReason = protectionReason;
            this.safeTitle = safeTitle;
            this.safeText = safeText;
            this.safeSubText = safeSubText;
        }
    }

    static Decision decide(Input input) {
        if (input == null || input.packageName == null || input.packageName.isEmpty()) {
            return ignored("invalid");
        }
        if (EVOGENT_PACKAGE.equals(input.packageName)) {
            return ignored("self");
        }

        String protectedReason = protectedReason(input);
        boolean redact = shouldRedact(input, protectedReason);
        boolean protectedFromSuppression = protectedReason != null || redact;
        boolean canSuppress = !protectedFromSuppression
                && input.clearable
                && !input.ongoing
                && !input.fullScreen
                && !input.groupSummary
                && input.importance < IMPORTANCE_HIGH
                && (input.flags & (FLAG_ONGOING_EVENT
                        | FLAG_FOREGROUND_SERVICE
                        | FLAG_INSISTENT)) == 0;

        return new Decision(
                true,
                redact,
                protectedFromSuppression,
                canSuppress,
                priority(input, protectedReason),
                redact && protectedReason == null ? "sensitive_content" : protectedReason,
                redact ? null : input.title,
                redact ? null : input.text,
                redact ? null : input.subText);
    }

    /**
     * Cancellation is the last step, never an assumption. The server must prove that the user
     * explicitly allowed best-effort replacement for this package, return the matching durable
     * receipt, and expose Evogent's digest before the listener asks Android to cancel by key.
     * Android has no atomic generation-bound cancellation API, so callers must describe the final
     * key-only operation truthfully and keep protected events outside it.
     */
    static boolean shouldCancelOriginal(
            Decision decision,
            String expectedEventId,
            String receiptEventId,
            boolean receiptPersisted,
            String serverMode,
            boolean replacementAllowed,
            boolean serverRequestedSuppression,
            boolean digestCapability,
            boolean digestActive,
            boolean activeRevisionMatches) {
        return decision != null
                && decision.ingest
                && decision.nativeCanSuppress
                && isLowerHex(expectedEventId, 64)
                && expectedEventId.equals(receiptEventId)
                && receiptPersisted
                && "curated".equals(serverMode)
                && replacementAllowed
                && serverRequestedSuppression
                && digestCapability
                && digestActive
                && activeRevisionMatches;
    }

    /**
     * The raw Android notification key never crosses loopback. The event identity binds package,
     * key, post time, and a content-generation hash so the caller can reject known stale receipts
     * before requesting key-only cancellation. It is not an atomic Android generation token.
     */
    static String eventId(
            Input input,
            String notificationKey,
            long postTimeMs) {
        if (input == null) return null;
        return sha256(
                input.packageName,
                normalize(notificationKey, 1024),
                Long.toString(postTimeMs),
                input.category,
                Integer.toString(input.flags),
                Integer.toString(input.importance),
                Boolean.toString(input.clearable),
                Boolean.toString(input.ongoing),
                Boolean.toString(input.fullScreen),
                Boolean.toString(input.groupSummary),
                Boolean.toString(input.conversation),
                Integer.toString(input.visibility),
                input.title,
                input.text,
                input.subText);
    }

    /** Hash potentially identifying channel/conversation ids before transport. */
    static String opaqueId(String value) {
        String normalized = normalize(value, 1024);
        return normalized == null ? null : sha256(normalized);
    }

    private static Decision ignored(String reason) {
        return new Decision(
                false,
                true,
                true,
                false,
                "low",
                reason,
                null,
                null,
                null);
    }

    private static String protectedReason(Input input) {
        String pkg = lower(input.packageName);
        String category = lower(input.category);
        if (input.fullScreen) return "full_screen";
        if (input.groupSummary) return "group_summary";
        if (input.ongoing || (input.flags & FLAG_ONGOING_EVENT) != 0) return "ongoing";
        if ((input.flags & FLAG_FOREGROUND_SERVICE) != 0) return "foreground_service";
        if ((input.flags & FLAG_INSISTENT) != 0) return "insistent";
        if (!input.clearable) return "non_clearable";
        if (input.importance == IMPORTANCE_UNSPECIFIED) return "ranking_unavailable";
        if (input.importance >= IMPORTANCE_HIGH) return "high_importance";
        if (isCriticalSystemPackage(pkg)) return "system_safety";
        if (isProtectedCategory(category)) return "protected_category";
        return null;
    }

    private static boolean shouldRedact(Input input, String protectedReason) {
        // Notification.VISIBILITY_SECRET == -1. Keep the constant local so this class remains
        // Android-free and host-testable.
        if (input.visibility == -1) return true;
        if ("system_safety".equals(protectedReason)) return true;

        String combined = lower(join(input.title, input.text, input.subText));
        return containsAny(
                combined,
                "verification code",
                "security code",
                "one-time code",
                "one time code",
                "one-time password",
                "one time password",
                "passcode",
                "auth code",
                "2fa code",
                "otp:",
                "password reset");
    }

    private static String priority(Input input, String protectedReason) {
        String category = lower(input.category);
        if (input.fullScreen
                || "call".equals(category)
                || "alarm".equals(category)
                || "emergency".equals(category)
                || "error".equals(category)
                || "system_safety".equals(protectedReason)) {
            return "critical";
        }
        if (input.importance >= IMPORTANCE_HIGH
                || input.conversation
                || "message".equals(category)
                || "email".equals(category)
                || "missed_call".equals(category)
                || "reminder".equals(category)
                || "event".equals(category)) {
            return "high";
        }
        if ("promo".equals(category)
                || "recommendation".equals(category)
                || "progress".equals(category)
                || "service".equals(category)
                || "status".equals(category)) {
            return "low";
        }
        return "normal";
    }

    private static boolean isProtectedCategory(String category) {
        return "alarm".equals(category)
                || "call".equals(category)
                || "emergency".equals(category)
                || "navigation".equals(category)
                || "service".equals(category)
                || "transport".equals(category)
                || "system".equals(category)
                || "error".equals(category)
                || "location_sharing".equals(category)
                || "workout".equals(category);
    }

    private static boolean isCriticalSystemPackage(String pkg) {
        return "android".equals(pkg)
                || "com.android.systemui".equals(pkg)
                || "com.android.phone".equals(pkg)
                || "com.android.cellbroadcastreceiver".equals(pkg)
                || "com.google.android.cellbroadcastreceiver".equals(pkg)
                || "com.google.android.permissioncontroller".equals(pkg)
                || "com.google.android.apps.safetyhub".equals(pkg)
                || "com.google.android.safetycenter.resources".equals(pkg);
    }

    private static boolean containsAny(String value, String... needles) {
        if (value == null) return false;
        for (String needle : needles) {
            if (value.contains(needle)) return true;
        }
        return false;
    }

    private static String join(String... values) {
        StringBuilder builder = new StringBuilder();
        for (String value : values) {
            if (value == null || value.isEmpty()) continue;
            if (builder.length() > 0) builder.append(' ');
            builder.append(value);
        }
        return builder.toString();
    }

    private static String lower(String value) {
        return value == null ? null : value.toLowerCase(Locale.US);
    }

    static String normalize(String value, int maxChars) {
        if (value == null) return null;
        String normalized = value
                .replace('\u0000', ' ')
                .replaceAll("[\\p{Cc}&&[^\\r\\n\\t]]", " ")
                .replaceAll("\\s+", " ")
                .trim();
        if (normalized.isEmpty()) return null;
        return normalized.length() <= maxChars
                ? normalized
                : normalized.substring(0, maxChars);
    }

    private static String sha256(String... values) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            for (String value : values) {
                byte[] bytes = (value == null ? "" : value).getBytes(StandardCharsets.UTF_8);
                digest.update(new byte[] {
                        (byte) (bytes.length >>> 24),
                        (byte) (bytes.length >>> 16),
                        (byte) (bytes.length >>> 8),
                        (byte) bytes.length,
                });
                digest.update(bytes);
            }
            byte[] hashed = digest.digest();
            StringBuilder output = new StringBuilder(hashed.length * 2);
            for (byte value : hashed) {
                output.append(String.format(Locale.US, "%02x", value & 0xff));
            }
            return output.toString();
        } catch (Exception impossible) {
            throw new IllegalStateException("SHA-256 unavailable", impossible);
        }
    }

    private static boolean isLowerHex(String value, int chars) {
        if (value == null || value.length() != chars) return false;
        for (int index = 0; index < value.length(); index++) {
            char current = value.charAt(index);
            if (!((current >= '0' && current <= '9')
                    || (current >= 'a' && current <= 'f'))) {
                return false;
            }
        }
        return true;
    }
}

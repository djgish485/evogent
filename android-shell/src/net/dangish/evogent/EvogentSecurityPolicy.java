package net.dangish.evogent;

import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

/**
 * Security invariants shared by the APK's WebViews and exported control channels.
 *
 * Keep this class free of Android framework dependencies so its parsing and token behavior can
 * be exercised by the host-side build test.
 */
final class EvogentSecurityPolicy {
    // Android apps share the device loopback namespace. The APK therefore talks only to the
    // release-pinned TLS listener; Termux's internal HTTP listener remains separate on port 3001.
    static final String LOOPBACK_ORIGIN = "https://127.0.0.1:3443";
    static final String BROWSE_CACHE_SUBMIT_URL =
            LOOPBACK_ORIGIN + "/api/internal/browse-cache/submit";
    static final String PHONE_NOTIFICATION_INGEST_URL =
            LOOPBACK_ORIGIN + "/api/internal/phone-notifications/ingest";
    static final String PHONE_NOTIFICATION_REMOVE_URL =
            LOOPBACK_ORIGIN + "/api/internal/phone-notifications/remove";
    static final int MAX_NATIVE_PROMPT_CHARS = 16 * 1024;
    static final int MAX_EXTERNAL_URL_CHARS = 8 * 1024;
    static final int MAX_SHARE_TEXT_CHARS = 16 * 1024;
    static final int MAX_SHARE_SUBJECT_CHARS = 2 * 1024;

    private EvogentSecurityPolicy() {}

    /**
     * True only for the exact on-device server origin. Paths, queries, and fragments are allowed;
     * alternate hosts, schemes, ports, user-info tricks, and malformed URLs are not.
     */
    static boolean isTrustedWebUrl(String value) {
        if (value == null || value.trim().isEmpty()) return false;
        try {
            URI uri = new URI(value);
            return "https".equalsIgnoreCase(uri.getScheme())
                    && "127.0.0.1".equals(uri.getHost())
                    && uri.getPort() == 3443
                    && uri.getRawUserInfo() == null;
        } catch (Exception ignored) {
            return false;
        }
    }

    /** Native intents opened for web content are limited to ordinary, absolute HTTP(S) URLs. */
    static boolean isSafeExternalWebUrl(String value) {
        if (value == null || value.isEmpty() || value.length() > MAX_EXTERNAL_URL_CHARS) {
            return false;
        }
        try {
            URI uri = new URI(value);
            String scheme = uri.getScheme();
            return ("http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme))
                    && uri.getHost() != null
                    && !uri.getHost().isEmpty()
                    && uri.getRawUserInfo() == null;
        } catch (Exception ignored) {
            return false;
        }
    }

    /** Validate the exported share target before any content is logged or processed. */
    static boolean isValidTextShare(
            String action,
            String mimeType,
            String text,
            String subject) {
        return "android.intent.action.SEND".equals(action)
                && "text/plain".equalsIgnoreCase(mimeType)
                && text != null
                && !text.isEmpty()
                && text.length() <= MAX_SHARE_TEXT_CHARS
                && (subject == null || subject.length() <= MAX_SHARE_SUBJECT_CHARS);
    }

    /**
     * Fail closed if either side is absent/blank and compare valid tokens without early-exit
     * string timing.
     */
    static boolean tokenMatches(String expected, String supplied) {
        if (expected == null || supplied == null) return false;
        String normalizedExpected = expected.trim();
        String normalizedSupplied = supplied.trim();
        if (normalizedExpected.isEmpty() || normalizedSupplied.isEmpty()) return false;
        return MessageDigest.isEqual(
                normalizedExpected.getBytes(StandardCharsets.UTF_8),
                normalizedSupplied.getBytes(StandardCharsets.UTF_8));
    }
}

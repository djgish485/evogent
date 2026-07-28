package net.dangish.evogent;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.regex.Pattern;

/**
 * Content-free identities and bounds for one-shot benchmark share provenance.
 *
 * This class intentionally has no Android dependencies so the release build can test the exact
 * validation and digest behavior on the host before packaging the APK.
 */
final class EvogentBenchmarkSharePolicy {
    static final int MAX_SEQUENCE = 5;
    static final long MAX_ARM_AGE_MS = 2L * 60 * 1000;
    static final long MAX_ARM_COMMAND_DELAY_MS = 30L * 1000;
    static final String SHARE_RECEIPT_PREFIX = "benchmark-share-";

    private static final Pattern RUN_ID = Pattern.compile(
            "^full-browse-[A-Za-z0-9][A-Za-z0-9._:-]{7,140}$");
    private static final Pattern TOKEN = Pattern.compile("^[a-f0-9]{64}$");
    private static final Pattern DIGEST = Pattern.compile("^[a-f0-9]{64}$");

    private EvogentBenchmarkSharePolicy() {}

    static boolean isValidRunId(String value) {
        return value != null && RUN_ID.matcher(value).matches();
    }

    static boolean isValidSequence(int value) {
        return value >= 1 && value <= MAX_SEQUENCE;
    }

    static boolean isValidToken(String value) {
        return value != null && TOKEN.matcher(value).matches();
    }

    static boolean isValidDigest(String value) {
        return value != null && DIGEST.matcher(value).matches();
    }

    static boolean hasStoredArmState(
            String runId,
            int sequence,
            String tokenDigest,
            long armedAtMs) {
        return runId != null || sequence != 0 || tokenDigest != null || armedAtMs != 0;
    }

    static boolean isLiveArm(
            String runId,
            int sequence,
            String tokenDigest,
            long armedAtMs,
            long nowMs) {
        return isValidRunId(runId)
                && isValidSequence(sequence)
                && isValidDigest(tokenDigest)
                && armedAtMs > 0
                && armedAtMs <= nowMs
                && nowMs - armedAtMs <= MAX_ARM_AGE_MS;
    }

    static boolean isValidArmRequest(
            String runId,
            int sequence,
            String token,
            long armedAtMs,
            long nowMs) {
        return isValidRunId(runId)
                && isValidSequence(sequence)
                && isValidToken(token)
                && armedAtMs > 0
                && armedAtMs <= nowMs
                && nowMs - armedAtMs <= MAX_ARM_COMMAND_DELAY_MS;
    }

    static String sha256Hex(String value) {
        if (value == null) return null;
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256")
                    .digest(value.getBytes(StandardCharsets.UTF_8));
            StringBuilder output = new StringBuilder(digest.length * 2);
            for (byte part : digest) {
                output.append(String.format("%02x", part & 0xff));
            }
            return output.toString();
        } catch (Exception impossible) {
            throw new IllegalStateException("SHA-256 unavailable", impossible);
        }
    }

    static String receiptIdForTokenDigest(String tokenDigest) {
        return isValidDigest(tokenDigest) ? SHARE_RECEIPT_PREFIX + tokenDigest : null;
    }
}

package net.dangish.evogent;

import android.content.Context;
import android.content.SharedPreferences;

/**
 * A single private, durable arm consumed synchronously by the next supported YouTube share.
 *
 * Only the authenticated accessibility control channel can arm or clear it. The raw random token
 * is never persisted: the APK stores its digest, consumes the state before asynchronous ingest,
 * and puts only content-free digests in the durable refresh receipt.
 */
final class EvogentBenchmarkShareProvenance {
    private static final String PREFS = "evogent_benchmark_share_provenance";
    private static final String KEY_RUN_ID = "run_id";
    private static final String KEY_SEQUENCE = "sequence";
    private static final String KEY_TOKEN_DIGEST = "token_digest";
    private static final String KEY_ARMED_AT_MS = "armed_at_ms";
    private static final Object LOCK = new Object();

    private EvogentBenchmarkShareProvenance() {}

    static final class Consumed {
        final String benchmarkRunId;
        final int sequence;
        final String tokenDigest;
        final String receiptId;
        final long armedAtMs;

        Consumed(
                String benchmarkRunId,
                int sequence,
                String tokenDigest,
                String receiptId,
                long armedAtMs) {
            this.benchmarkRunId = benchmarkRunId;
            this.sequence = sequence;
            this.tokenDigest = tokenDigest;
            this.receiptId = receiptId;
            this.armedAtMs = armedAtMs;
        }
    }

    static boolean arm(
            Context context,
            String runId,
            int sequence,
            String token,
            long armedAtMs,
            long nowMs) {
        if (!EvogentBenchmarkSharePolicy.isValidArmRequest(
                runId, sequence, token, armedAtMs, nowMs)) {
            return false;
        }
        String tokenDigest = EvogentBenchmarkSharePolicy.sha256Hex(token);
        synchronized (LOCK) {
            SharedPreferences preferences = preferences(context);
            String existingRunId = preferences.getString(KEY_RUN_ID, null);
            int existingSequence = preferences.getInt(KEY_SEQUENCE, 0);
            String existingDigest = preferences.getString(KEY_TOKEN_DIGEST, null);
            long existingArmedAtMs = preferences.getLong(KEY_ARMED_AT_MS, 0);
            if (EvogentBenchmarkSharePolicy.isLiveArm(
                    existingRunId,
                    existingSequence,
                    existingDigest,
                    existingArmedAtMs,
                    nowMs)) {
                return false;
            }
            if (!preferences.edit().clear().commit()) return false;
            return preferences.edit()
                    .putString(KEY_RUN_ID, runId)
                    .putInt(KEY_SEQUENCE, sequence)
                    .putString(KEY_TOKEN_DIGEST, tokenDigest)
                    .putLong(KEY_ARMED_AT_MS, armedAtMs)
                    .commit();
        }
    }

    static Consumed consume(Context context, long nowMs) {
        synchronized (LOCK) {
            SharedPreferences preferences = preferences(context);
            String runId = preferences.getString(KEY_RUN_ID, null);
            int sequence = preferences.getInt(KEY_SEQUENCE, 0);
            String tokenDigest = preferences.getString(KEY_TOKEN_DIGEST, null);
            long armedAtMs = preferences.getLong(KEY_ARMED_AT_MS, 0);
            // The overwhelmingly common ordinary-share path has never been armed. Avoid a
            // synchronous main-thread preferences write when there is nothing to consume.
            if (!EvogentBenchmarkSharePolicy.hasStoredArmState(
                    runId, sequence, tokenDigest, armedAtMs)) {
                return null;
            }
            if (!EvogentBenchmarkSharePolicy.isLiveArm(
                    runId, sequence, tokenDigest, armedAtMs, nowMs)) {
                preferences.edit().clear().commit();
                return null;
            }
            String receiptId =
                    EvogentBenchmarkSharePolicy.receiptIdForTokenDigest(tokenDigest);
            // Consume before the asynchronous network request. A failed submit then fails the
            // benchmark honestly instead of leaving a token reusable by a later ambient share.
            if (receiptId == null || !preferences.edit().clear().commit()) return null;
            return new Consumed(runId, sequence, tokenDigest, receiptId, armedAtMs);
        }
    }

    static boolean clear(Context context, String runId) {
        if (!EvogentBenchmarkSharePolicy.isValidRunId(runId)) return false;
        synchronized (LOCK) {
            SharedPreferences preferences = preferences(context);
            String existingRunId = preferences.getString(KEY_RUN_ID, null);
            if (existingRunId == null) return true;
            if (!runId.equals(existingRunId)) return false;
            return preferences.edit().clear().commit();
        }
    }

    private static SharedPreferences preferences(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}

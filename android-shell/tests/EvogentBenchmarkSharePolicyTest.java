package net.dangish.evogent;

public final class EvogentBenchmarkSharePolicyTest {
    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }

    public static void main(String[] args) {
        String runId = "full-browse-suite-12345678-r1-candidate-2";
        String token = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        String digest = EvogentBenchmarkSharePolicy.sha256Hex(token);
        long armedAtMs = 10_000;

        require(EvogentBenchmarkSharePolicy.isValidRunId(runId), "valid run rejected");
        require(!EvogentBenchmarkSharePolicy.isValidRunId("browse-123"), "weak run accepted");
        require(EvogentBenchmarkSharePolicy.isValidSequence(1), "first sequence rejected");
        require(EvogentBenchmarkSharePolicy.isValidSequence(5), "last sequence rejected");
        require(!EvogentBenchmarkSharePolicy.isValidSequence(0), "zero sequence accepted");
        require(!EvogentBenchmarkSharePolicy.isValidSequence(6), "oversized sequence accepted");
        require(EvogentBenchmarkSharePolicy.isValidToken(token), "valid token rejected");
        require(!EvogentBenchmarkSharePolicy.isValidToken(token.toUpperCase()),
                "non-canonical token accepted");
        require(!token.equals(digest), "raw token survived as digest");
        require(EvogentBenchmarkSharePolicy.isValidDigest(digest), "digest rejected");
        require(!EvogentBenchmarkSharePolicy.hasStoredArmState(null, 0, null, 0),
                "empty preference defaults look armed");
        require(EvogentBenchmarkSharePolicy.hasStoredArmState(runId, 0, null, 0),
                "partial stored state was ignored");
        require(EvogentBenchmarkSharePolicy.isValidArmRequest(
                runId, 1, token, armedAtMs, armedAtMs + 10),
                "valid arm request rejected");
        require(!EvogentBenchmarkSharePolicy.isValidArmRequest(
                runId, 1, token, armedAtMs, armedAtMs - 1),
                "future arm request accepted");
        require(!EvogentBenchmarkSharePolicy.isValidArmRequest(
                runId, 1, token, armedAtMs,
                armedAtMs + EvogentBenchmarkSharePolicy.MAX_ARM_COMMAND_DELAY_MS + 1),
                "stale arm command accepted");
        require(EvogentBenchmarkSharePolicy.isLiveArm(
                runId, 1, digest, armedAtMs,
                armedAtMs + EvogentBenchmarkSharePolicy.MAX_ARM_AGE_MS),
                "live boundary rejected");
        require(!EvogentBenchmarkSharePolicy.isLiveArm(
                runId, 1, digest, armedAtMs,
                armedAtMs + EvogentBenchmarkSharePolicy.MAX_ARM_AGE_MS + 1),
                "expired arm accepted");
        require(!EvogentBenchmarkSharePolicy.isLiveArm(
                runId, 1, digest, armedAtMs + 1, armedAtMs),
                "future arm accepted");
        require(
                ("benchmark-share-" + digest).equals(
                        EvogentBenchmarkSharePolicy.receiptIdForTokenDigest(digest)),
                "receipt identity does not bind token digest");
        require(EvogentBenchmarkSharePolicy.receiptIdForTokenDigest(token.substring(1)) == null,
                "invalid digest produced a receipt");

        System.out.println("EvogentBenchmarkSharePolicyTest: PASS");
    }
}

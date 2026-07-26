package net.dangish.evogent;

import java.nio.charset.StandardCharsets;

/**
 * Cross-language fixture shared with test/phone-loopback-auth.test.mjs. A field-order, domain, or
 * length-prefix drift between Node and Android must fail before an APK is produced.
 */
public final class EvogentLoopbackAuthProtocolTest {
    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }

    public static void main(String[] args) throws Exception {
        byte[] key = "test-control-token-with-enough-entropy"
                .getBytes(StandardCharsets.UTF_8);
        String clientNonce = repeated("ab", 32);
        String serverInstanceId = repeated("00", 16);
        String challengeId = repeated("01", 16);
        String serverNonce = repeated("02", 32);
        long challengeExpiresAtMs = 1800000030000L;
        String sessionToken = "AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM";
        long sessionExpiresAtMs = 1800086400000L;

        String serverProof = EvogentLoopbackAuthProtocol.serverProof(
                key,
                clientNonce,
                serverInstanceId,
                challengeId,
                serverNonce,
                challengeExpiresAtMs);
        require(
                "07454b98e9cbd470868282108fb2cb35c5e47e24f94858f5546f7d82fafc10fc"
                        .equals(serverProof),
                "Node/Java server-proof vector drift");

        String clientProof = EvogentLoopbackAuthProtocol.clientProof(
                key,
                clientNonce,
                serverInstanceId,
                challengeId,
                serverNonce,
                challengeExpiresAtMs,
                "web");
        require(
                "c7a91ea8e75817b8c0503c8e28071e5952c28dddcbc7677f7188795e7bd6e67f"
                        .equals(clientProof),
                "Node/Java client-proof vector drift");

        String sessionProof = EvogentLoopbackAuthProtocol.sessionProof(
                key,
                clientNonce,
                serverInstanceId,
                challengeId,
                serverNonce,
                challengeExpiresAtMs,
                "web",
                sessionToken,
                sessionExpiresAtMs);
        require(
                "fa2f1562ca5930dc190a9ff8920ad0dfb6e3d29ca472b4fdbf272160e0c66e66"
                        .equals(sessionProof),
                "Node/Java session-proof vector drift");
        require(EvogentLoopbackAuthProtocol.proofMatches(sessionProof, sessionProof),
                "valid proof rejected");
        require(!EvogentLoopbackAuthProtocol.proofMatches(
                        repeated("0", 64),
                        sessionProof),
                "invalid proof accepted");
        require(EvogentLoopbackAuthProtocol.isBase64UrlToken(sessionToken),
                "valid 32-byte base64url session token rejected");
        require(!EvogentLoopbackAuthProtocol.isBase64UrlToken(sessionToken + "="),
                "padded session token accepted");

        System.out.println("EvogentLoopbackAuthProtocolTest: PASS");
    }

    private static String repeated(String value, int count) {
        StringBuilder builder = new StringBuilder(value.length() * count);
        for (int i = 0; i < count; i++) builder.append(value);
        return builder.toString();
    }
}

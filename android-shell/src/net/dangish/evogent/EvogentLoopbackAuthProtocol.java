package net.dangish.evogent;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/**
 * Pure-Java implementation of the phone loopback authentication transcript.
 *
 * The wire format is intentionally small and rigid: every UTF-8 field is prefixed with its
 * unsigned four-byte, big-endian length before HMAC-SHA256. Keep the domains and field order in
 * lockstep with lib/phone-loopback-auth.js. This class has no Android dependencies so build.sh can
 * exercise a fixed cross-language vector on the host before packaging the APK.
 */
final class EvogentLoopbackAuthProtocol {
    static final int VERSION = 1;
    static final String CHALLENGE_DOMAIN = "evogent/phone-auth/server/v1";
    static final String CLIENT_DOMAIN = "evogent/phone-auth/client/v1";
    static final String SESSION_DOMAIN = "evogent/phone-auth/session/v1";

    private EvogentLoopbackAuthProtocol() {}

    static String serverProof(
            byte[] key,
            String clientNonce,
            String serverInstanceId,
            String challengeId,
            String serverNonce,
            long expiresAtMs) throws Exception {
        return hmacHex(key, CHALLENGE_DOMAIN, challengeFields(
                clientNonce,
                serverInstanceId,
                challengeId,
                serverNonce,
                expiresAtMs));
    }

    static String clientProof(
            byte[] key,
            String clientNonce,
            String serverInstanceId,
            String challengeId,
            String serverNonce,
            long expiresAtMs,
            String sessionKind) throws Exception {
        String[] challenge = challengeFields(
                clientNonce,
                serverInstanceId,
                challengeId,
                serverNonce,
                expiresAtMs);
        return hmacHex(key, CLIENT_DOMAIN, append(challenge, sessionKind));
    }

    static String sessionProof(
            byte[] key,
            String clientNonce,
            String serverInstanceId,
            String challengeId,
            String serverNonce,
            long expiresAtMs,
            String sessionKind,
            String sessionToken,
            long sessionExpiresAtMs) throws Exception {
        String[] challenge = challengeFields(
                clientNonce,
                serverInstanceId,
                challengeId,
                serverNonce,
                expiresAtMs);
        return hmacHex(key, SESSION_DOMAIN, append(
                challenge,
                sessionKind,
                sessionToken,
                Long.toString(sessionExpiresAtMs)));
    }

    static boolean proofMatches(String supplied, String expected) {
        byte[] suppliedBytes = decodeLowerHex(supplied);
        byte[] expectedBytes = decodeLowerHex(expected);
        return suppliedBytes != null
                && expectedBytes != null
                && MessageDigest.isEqual(suppliedBytes, expectedBytes);
    }

    static boolean isLowerHex(String value, int chars) {
        if (value == null || value.length() != chars) return false;
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
        }
        return true;
    }

    static boolean isBase64UrlToken(String value) {
        if (value == null || value.length() != 43) return false;
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (!((c >= 'A' && c <= 'Z')
                    || (c >= 'a' && c <= 'z')
                    || (c >= '0' && c <= '9')
                    || c == '_'
                    || c == '-')) {
                return false;
            }
        }
        return true;
    }

    static String lowerHex(byte[] bytes) {
        char[] result = new char[bytes.length * 2];
        final char[] alphabet = "0123456789abcdef".toCharArray();
        for (int i = 0; i < bytes.length; i++) {
            int value = bytes[i] & 0xff;
            result[i * 2] = alphabet[value >>> 4];
            result[i * 2 + 1] = alphabet[value & 0x0f];
        }
        return new String(result);
    }

    private static String[] challengeFields(
            String clientNonce,
            String serverInstanceId,
            String challengeId,
            String serverNonce,
            long expiresAtMs) {
        return new String[] {
                Integer.toString(VERSION),
                clientNonce,
                serverInstanceId,
                challengeId,
                serverNonce,
                Long.toString(expiresAtMs),
        };
    }

    private static String hmacHex(byte[] key, String domain, String[] fields) throws Exception {
        if (key == null || key.length == 0) throw new IllegalArgumentException("missing key");
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(key, "HmacSHA256"));
        mac.update(encodeField(domain));
        for (String field : fields) mac.update(encodeField(field));
        return lowerHex(mac.doFinal());
    }

    private static byte[] encodeField(String value) throws Exception {
        if (value == null) throw new IllegalArgumentException("null transcript field");
        byte[] bytes = value.getBytes(StandardCharsets.UTF_8);
        ByteArrayOutputStream encoded = new ByteArrayOutputStream(bytes.length + 4);
        encoded.write(ByteBuffer.allocate(4)
                .order(ByteOrder.BIG_ENDIAN)
                .putInt(bytes.length)
                .array());
        encoded.write(bytes);
        return encoded.toByteArray();
    }

    private static String[] append(String[] fields, String... suffix) {
        String[] result = new String[fields.length + suffix.length];
        System.arraycopy(fields, 0, result, 0, fields.length);
        System.arraycopy(suffix, 0, result, fields.length, suffix.length);
        return result;
    }

    private static byte[] decodeLowerHex(String value) {
        if (!isLowerHex(value, 64)) return null;
        byte[] result = new byte[32];
        for (int i = 0; i < result.length; i++) {
            int high = Character.digit(value.charAt(i * 2), 16);
            int low = Character.digit(value.charAt(i * 2 + 1), 16);
            result[i] = (byte) ((high << 4) | low);
        }
        return result;
    }
}

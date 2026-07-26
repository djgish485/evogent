package net.dangish.evogent;

/** Small host-side test run by build.sh; no Android runtime or Gradle required. */
public final class EvogentSecurityPolicyTest {
    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }

    private static void rejects(String url) {
        require(!EvogentSecurityPolicy.isTrustedWebUrl(url), "unexpected trusted URL: " + url);
    }

    public static void main(String[] args) {
        require(EvogentSecurityPolicy.isTrustedWebUrl("https://127.0.0.1:3443"),
                "exact loopback origin rejected");
        require(EvogentSecurityPolicy.isTrustedWebUrl(
                        "https://127.0.0.1:3443/path?q=value#fragment"),
                "same-origin path rejected");

        rejects(null);
        rejects("");
        rejects("http://127.0.0.1:3001");
        rejects("http://127.0.0.1:3443");
        rejects("https://127.0.0.1:3001");
        rejects("http://localhost:3001");
        rejects("http://127.0.0.1");
        rejects("http://127.0.0.1:3002");
        rejects("http://127.0.0.1.evil.example:3001");
        rejects("http://127.0.0.1@evil.example:3001");
        rejects("http://evil.example@127.0.0.1:3001");
        rejects("http://127.0.0.1:3001.evil.example");
        rejects("https://localhost:3443");
        rejects("https://127.0.0.1.evil.example:3443");
        rejects("https://127.0.0.1@evil.example:3443");
        rejects("not a url");

        require(EvogentSecurityPolicy.isSafeExternalWebUrl("https://x.com/user/status/123"),
                "safe HTTPS URL rejected");
        require(EvogentSecurityPolicy.isSafeExternalWebUrl("http://example.com/path?q=1#part"),
                "safe HTTP URL rejected");
        require(!EvogentSecurityPolicy.isSafeExternalWebUrl("javascript:alert(1)"),
                "javascript URL accepted");
        require(!EvogentSecurityPolicy.isSafeExternalWebUrl("intent://example.com/#Intent"),
                "intent URL accepted");
        require(!EvogentSecurityPolicy.isSafeExternalWebUrl("https://user@example.com/path"),
                "credential-bearing URL accepted");
        require(!EvogentSecurityPolicy.isSafeExternalWebUrl("https:///missing-host"),
                "hostless URL accepted");
        require(!EvogentSecurityPolicy.isSafeExternalWebUrl("https://example.com/a b"),
                "malformed external URL accepted");
        require(!EvogentSecurityPolicy.isSafeExternalWebUrl(
                        "https://example.com/" + repeated(
                                'x', EvogentSecurityPolicy.MAX_EXTERNAL_URL_CHARS)),
                "oversized external URL accepted");

        require(EvogentSecurityPolicy.isValidTextShare(
                        "android.intent.action.SEND", "text/plain", "https://youtu.be/123", null),
                "valid text share rejected");
        require(!EvogentSecurityPolicy.isValidTextShare(
                        "other.action", "text/plain", "https://youtu.be/123", null),
                "wrong share action accepted");
        require(!EvogentSecurityPolicy.isValidTextShare(
                        "android.intent.action.SEND", "text/html", "<b>content</b>", null),
                "wrong share MIME accepted");
        require(!EvogentSecurityPolicy.isValidTextShare(
                        "android.intent.action.SEND", "text/plain", "", null),
                "empty text share accepted");
        require(!EvogentSecurityPolicy.isValidTextShare(
                        "android.intent.action.SEND",
                        "text/plain",
                        repeated('x', EvogentSecurityPolicy.MAX_SHARE_TEXT_CHARS + 1),
                        null),
                "oversized text share accepted");
        require(!EvogentSecurityPolicy.isValidTextShare(
                        "android.intent.action.SEND",
                        "text/plain",
                        "https://youtu.be/123",
                        repeated('x', EvogentSecurityPolicy.MAX_SHARE_SUBJECT_CHARS + 1)),
                "oversized share subject accepted");

        require(EvogentSecurityPolicy.tokenMatches("secret-token", "secret-token"),
                "matching token rejected");
        require(EvogentSecurityPolicy.tokenMatches(" secret-token ", "secret-token"),
                "normalized matching token rejected");
        require(!EvogentSecurityPolicy.tokenMatches(null, "secret-token"),
                "missing stored token accepted");
        require(!EvogentSecurityPolicy.tokenMatches("secret-token", null),
                "missing supplied token accepted");
        require(!EvogentSecurityPolicy.tokenMatches("", ""),
                "blank tokens accepted");
        require(!EvogentSecurityPolicy.tokenMatches("secret-token", "other-token"),
                "mismatched token accepted");

        System.out.println("EvogentSecurityPolicyTest: PASS");
    }

    private static String repeated(char value, int count) {
        StringBuilder builder = new StringBuilder(count);
        for (int i = 0; i < count; i++) builder.append(value);
        return builder.toString();
    }
}

package net.dangish.evogent;

/** Host-side privacy and one-shot tests for assistant screen-context handoff. */
public final class EvogentAssistantContextStoreTest {
    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }

    public static void main(String[] args) {
        tokensAreOpaqueAndStrictlyParsed();
        contextIsBoundedNormalizedAndOneShot();
        unknownTokensFailClosed();
        System.out.println("EvogentAssistantContextStoreTest: PASS");
    }

    private static void tokensAreOpaqueAndStrictlyParsed() {
        String token = EvogentAssistantContextStore.begin();
        require(EvogentAssistantContextStore.isTokenShape(token),
                "new assistant handoff token was malformed");
        require(!EvogentAssistantContextStore.isTokenShape(null),
                "missing token accepted");
        require(!EvogentAssistantContextStore.isTokenShape(token + "0"),
                "oversized token accepted");
        require(!EvogentAssistantContextStore.isTokenShape(
                        token.substring(0, 35) + "z"),
                "non-hex token accepted");
        EvogentAssistantContextStore.discard(token);
    }

    private static void contextIsBoundedNormalizedAndOneShot() {
        String token = EvogentAssistantContextStore.begin();
        StringBuilder large = new StringBuilder();
        large.append("  first\n\tsecond").append('\0').append(' ');
        for (int i = 0; i < EvogentAssistantContextStore.MAX_TEXT_CHARS + 200; i++) {
            large.append('x');
        }
        EvogentAssistantContextStore.update(token, "  example.app  ", large.toString());
        EvogentAssistantContextStore.ContextData first =
                EvogentAssistantContextStore.consume(token);
        require("example.app".equals(first.app), "app identity was not normalized");
        require(first.text.startsWith("first second "),
                "visible text whitespace/control characters were not normalized");
        require(first.text.length() <= EvogentAssistantContextStore.MAX_TEXT_CHARS,
                "assistant context exceeded its privacy bound");

        EvogentAssistantContextStore.ContextData second =
                EvogentAssistantContextStore.consume(token);
        require(second.app == null && second.text.isEmpty(),
                "assistant context was reusable after first consumption");
    }

    private static void unknownTokensFailClosed() {
        EvogentAssistantContextStore.update(
                "00000000-0000-0000-0000-000000000000", "app", "secret");
        EvogentAssistantContextStore.ContextData missing =
                EvogentAssistantContextStore.consume(
                        "00000000-0000-0000-0000-000000000000");
        require(missing.app == null && missing.text.isEmpty(),
                "unknown token created or exposed context");
    }
}

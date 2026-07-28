package net.dangish.evogent;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicInteger;

/** Host-side privacy and one-shot tests for assistant screen-context handoff. */
public final class EvogentAssistantContextStoreTest {
    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }

    public static void main(String[] args) throws Exception {
        tokensAreOpaqueAndStrictlyParsed();
        sealedContextIsBoundedNormalizedAndOneShot();
        firstSealWinsAcrossAssistAndTimeout();
        concurrentSealsHaveOneWinner();
        sensitiveOrHiddenAncestorsPruneTheirWholeSubtree();
        unsealedContextFailsClosed();
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

    private static void sealedContextIsBoundedNormalizedAndOneShot() {
        String token = EvogentAssistantContextStore.begin();
        StringBuilder large = new StringBuilder();
        large.append("  first\n\tsecond").append('\0').append(' ');
        for (int i = 0; i < EvogentAssistantContextStore.MAX_TEXT_CHARS + 200; i++) {
            large.append('x');
        }
        require(EvogentAssistantContextStore.seal(
                        token,
                        "  example.app  ",
                        large.toString()),
                "first context seal was rejected");
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

    private static void firstSealWinsAcrossAssistAndTimeout() {
        String assistFirst = EvogentAssistantContextStore.begin();
        require(EvogentAssistantContextStore.seal(
                        assistFirst,
                        "first.app",
                        "first context"),
                "real assist context did not seal");
        require(!EvogentAssistantContextStore.seal(
                        assistFirst,
                        null,
                        ""),
                "timeout overwrote already-sealed assist context");
        EvogentAssistantContextStore.ContextData first =
                EvogentAssistantContextStore.consume(assistFirst);
        require("first.app".equals(first.app) && "first context".equals(first.text),
                "first-writer assist context was not retained");

        String timeoutFirst = EvogentAssistantContextStore.begin();
        require(EvogentAssistantContextStore.seal(timeoutFirst, null, ""),
                "empty timeout context did not seal");
        require(!EvogentAssistantContextStore.seal(
                        timeoutFirst,
                        "late.app",
                        "late private context"),
                "late assist callback overwrote timeout context");
        EvogentAssistantContextStore.ContextData timedOut =
                EvogentAssistantContextStore.consume(timeoutFirst);
        require(timedOut.app == null && timedOut.text.isEmpty(),
                "late assist context escaped after timeout");
    }

    private static void unsealedContextFailsClosed() {
        String token = EvogentAssistantContextStore.begin();
        EvogentAssistantContextStore.ContextData empty =
                EvogentAssistantContextStore.consume(token);
        require(empty.app == null && empty.text.isEmpty(),
                "unsealed assistant context returned data");
        require(!EvogentAssistantContextStore.seal(token, "late.app", "late"),
                "consumed unsealed token was resurrected");
    }

    private static void sensitiveOrHiddenAncestorsPruneTheirWholeSubtree() {
        require(!EvogentAssistantTraversalPolicy.shouldPruneSubtree(
                        true,
                        false,
                        false),
                "ordinary visible assist subtree was pruned");
        require(EvogentAssistantTraversalPolicy.shouldPruneSubtree(
                        true,
                        true,
                        false),
                "password ancestor allowed descendant traversal");
        require(EvogentAssistantTraversalPolicy.shouldPruneSubtree(
                        false,
                        false,
                        false),
                "hidden ancestor allowed visible-default descendants to escape");
        require(EvogentAssistantTraversalPolicy.shouldPruneSubtree(
                        false,
                        true,
                        false),
                "hidden password ancestor did not fail closed");
        require(EvogentAssistantTraversalPolicy.shouldPruneSubtree(
                        true,
                        false,
                        true),
                "source app's assist-blocked subtree was traversable");
    }

    private static void concurrentSealsHaveOneWinner() throws Exception {
        final String token = EvogentAssistantContextStore.begin();
        final CountDownLatch start = new CountDownLatch(1);
        final AtomicInteger winners = new AtomicInteger();
        Thread[] writers = new Thread[12];
        for (int index = 0; index < writers.length; index++) {
            final int writer = index;
            writers[index] = new Thread(new Runnable() {
                @Override public void run() {
                    await(start);
                    if (EvogentAssistantContextStore.seal(
                            token,
                            "app." + writer,
                            "context " + writer)) {
                        winners.incrementAndGet();
                    }
                }
            });
            writers[index].start();
        }
        start.countDown();
        for (Thread writer : writers) writer.join();
        require(winners.get() == 1,
                "concurrent context callbacks produced " + winners.get() + " winners");
        EvogentAssistantContextStore.ContextData context =
                EvogentAssistantContextStore.consume(token);
        require(context.app != null
                        && context.app.startsWith("app.")
                        && context.text.startsWith("context "),
                "winning sealed context was missing");
    }

    private static void await(CountDownLatch latch) {
        try {
            latch.await();
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new AssertionError("test thread interrupted");
        }
    }

    private static void unknownTokensFailClosed() {
        require(!EvogentAssistantContextStore.seal(
                        "00000000-0000-0000-0000-000000000000",
                        "app",
                        "secret"),
                "unknown token accepted a context seal");
        EvogentAssistantContextStore.ContextData missing =
                EvogentAssistantContextStore.consume(
                        "00000000-0000-0000-0000-000000000000");
        require(missing.app == null && missing.text.isEmpty(),
                "unknown token created or exposed context");
    }
}

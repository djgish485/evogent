package net.dangish.evogent;

import java.nio.file.Files;
import java.nio.file.Path;

public final class EvogentProcessRunnerTest {
    private static void check(boolean value, String message) {
        if (!value) throw new AssertionError(message);
    }

    public static void main(String[] args) throws Exception {
        EvogentProcessRunner.Result success = EvogentProcessRunner.run(
                new String[]{"/bin/sh", "-c", "printf 'ready\\n'"}, 64, 2000);
        check(success.succeeded(), "short successful command must pass");
        check("ready\n".equals(success.output()), "successful output must be captured exactly");

        EvogentProcessRunner.Result nonzero = EvogentProcessRunner.run(
                new String[]{"/bin/sh", "-c", "exit 7"}, 64, 2000);
        check(!nonzero.succeeded() && nonzero.exitCode() == 7,
                "non-zero command must fail with its exit code");

        EvogentProcessRunner.Result overflow = EvogentProcessRunner.run(
                new String[]{"/bin/sh", "-c", "printf '0123456789'"}, 4, 2000);
        check(!overflow.succeeded(), "output beyond the memory bound must fail closed");

        long startedNanos = System.nanoTime();
        EvogentProcessRunner.Result timeout = EvogentProcessRunner.run(
                new String[]{"/bin/sleep", "5"}, 64, 100);
        long elapsedMs = (System.nanoTime() - startedNanos) / 1000000L;
        check(!timeout.succeeded() && timeout.timedOut(),
                "hung command must report a timeout");
        check(elapsedMs < 1500L,
                "hung command and reader must return within a hard outer bound, elapsed="
                + elapsedMs);

        Path survivor = Files.createTempFile("evogent-process-runner-", ".survived");
        Files.delete(survivor);
        String script =
                "trap '' TERM; sleep 1; printf survived > \"$1\"";
        EvogentProcessRunner.Result forceKilled = EvogentProcessRunner.run(
                new String[]{"/bin/sh", "-c", script, "runner", survivor.toString()},
                64,
                100);
        check(forceKilled.timedOut(), "TERM-ignoring child must time out");
        Thread.sleep(1200L);
        check(!Files.exists(survivor),
                "TERM-ignoring child must be forcibly terminated before it can survive timeout");

        System.out.println("EvogentProcessRunnerTest: ok");
    }
}

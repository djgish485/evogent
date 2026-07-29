package net.dangish.evogent;

import java.io.Closeable;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.lang.reflect.Method;
import java.util.concurrent.TimeUnit;

/** Android-free, memory-bounded child-process runner with no unbounded read or wait. */
final class EvogentProcessRunner {
    private static final long EXIT_POLL_MS = 20L;
    static final long TERMINATE_GRACE_MS = 100L;
    static final long FORCE_TERMINATE_GRACE_MS = 150L;
    private static final long READER_DRAIN_MS = 250L;

    static final class Result {
        private final boolean success;
        private final boolean timedOut;
        private final int exitCode;
        private final String output;

        private Result(boolean success, boolean timedOut, int exitCode, String output) {
            this.success = success;
            this.timedOut = timedOut;
            this.exitCode = exitCode;
            this.output = output;
        }

        boolean succeeded() {
            return success;
        }

        boolean timedOut() {
            return timedOut;
        }

        int exitCode() {
            return exitCode;
        }

        String output() {
            return output;
        }
    }

    private static final class OutputCollector implements Runnable {
        private final InputStream input;
        private final int maxChars;
        private final StringBuilder output = new StringBuilder();
        private volatile boolean overflow;
        private volatile boolean failed;

        OutputCollector(InputStream input, int maxChars) {
            this.input = input;
            this.maxChars = maxChars;
        }

        @Override
        public void run() {
            char[] buffer = new char[2048];
            try {
                InputStreamReader reader = new InputStreamReader(input);
                int count;
                while ((count = reader.read(buffer)) != -1) {
                    int remaining = maxChars - output.length();
                    if (remaining > 0) {
                        output.append(buffer, 0, Math.min(remaining, count));
                    }
                    if (count > remaining) overflow = true;
                }
            } catch (Throwable error) {
                failed = true;
            }
        }
    }

    private EvogentProcessRunner() {}

    static Result run(String[] command, int maxChars, long timeoutMs) {
        if (command == null || command.length == 0 || maxChars < 0 || timeoutMs <= 0) {
            return new Result(false, false, -1, "");
        }

        Process process = null;
        InputStream input = null;
        Thread readerThread = null;
        try {
            process = new ProcessBuilder(command).redirectErrorStream(true).start();
            closeQuietly(process.getOutputStream());
            input = process.getInputStream();
            OutputCollector collector = new OutputCollector(input, maxChars);
            readerThread = new Thread(collector, "evogent-process-output");
            readerThread.setDaemon(true);
            readerThread.start();

            long deadlineNanos =
                    System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMs);
            Integer exitCode = pollExitCode(process, deadlineNanos);
            if (exitCode == null) {
                terminateBounded(process);
                closeQuietly(input);
                joinUntil(readerThread, System.nanoTime()
                        + TimeUnit.MILLISECONDS.toNanos(READER_DRAIN_MS));
                return new Result(false, true, -1, "");
            }

            boolean drained = joinUntil(readerThread, System.nanoTime()
                    + TimeUnit.MILLISECONDS.toNanos(READER_DRAIN_MS));
            if (!drained) return new Result(false, false, exitCode, "");
            if (collector.failed || collector.overflow || exitCode != 0) {
                return new Result(false, false, exitCode, collector.output.toString());
            }
            return new Result(true, false, exitCode, collector.output.toString());
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            return new Result(false, false, -1, "");
        } catch (Throwable error) {
            return new Result(false, false, -1, "");
        } finally {
            if (process != null && isAlive(process)) terminateBounded(process);
            closeQuietly(input);
            if (process != null) {
                closeQuietly(process.getErrorStream());
                closeQuietly(process.getOutputStream());
            }
            if (readerThread != null && readerThread.isAlive()) readerThread.interrupt();
        }
    }

    private static Integer pollExitCode(Process process, long deadlineNanos)
            throws InterruptedException {
        while (true) {
            try {
                return process.exitValue();
            } catch (IllegalThreadStateException stillRunning) {
                long remainingNanos = deadlineNanos - System.nanoTime();
                if (remainingNanos <= 0) return null;
                long remainingMs = Math.max(
                        1L, TimeUnit.NANOSECONDS.toMillis(remainingNanos));
                Thread.sleep(Math.min(EXIT_POLL_MS, remainingMs));
            }
        }
    }

    private static boolean joinUntil(Thread thread, long deadlineNanos)
            throws InterruptedException {
        while (thread.isAlive()) {
            long remainingNanos = deadlineNanos - System.nanoTime();
            if (remainingNanos <= 0) return false;
            long remainingMs = Math.max(
                    1L, TimeUnit.NANOSECONDS.toMillis(remainingNanos));
            thread.join(remainingMs);
        }
        return true;
    }

    private static boolean isAlive(Process process) {
        try {
            process.exitValue();
            return false;
        } catch (IllegalThreadStateException stillRunning) {
            return true;
        }
    }

    private static void terminateBounded(Process process) {
        process.destroy();
        if (awaitExitIgnoringInterrupt(process, TERMINATE_GRACE_MS)) return;
        try {
            Method method = Process.class.getMethod("destroyForcibly");
            method.invoke(process);
        } catch (Throwable unavailableBeforeApi26) {
            // Process.destroyForcibly is unavailable on the oldest supported Android releases.
            // Re-issue destroy rather than introduce an API-26 linkage failure.
            process.destroy();
        }
        awaitExitIgnoringInterrupt(process, FORCE_TERMINATE_GRACE_MS);
    }

    private static boolean awaitExitIgnoringInterrupt(Process process, long timeoutMs) {
        long deadlineNanos =
                System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMs);
        boolean interrupted = Thread.interrupted();
        try {
            while (isAlive(process)) {
                long remainingNanos = deadlineNanos - System.nanoTime();
                if (remainingNanos <= 0) return false;
                long remainingMs = Math.max(
                        1L, TimeUnit.NANOSECONDS.toMillis(remainingNanos));
                try {
                    Thread.sleep(Math.min(EXIT_POLL_MS, remainingMs));
                } catch (InterruptedException error) {
                    interrupted = true;
                }
            }
            return true;
        } finally {
            if (interrupted) Thread.currentThread().interrupt();
        }
    }

    private static void closeQuietly(Closeable closeable) {
        if (closeable == null) return;
        try {
            closeable.close();
        } catch (Throwable ignored) {}
    }
}

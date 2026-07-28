package net.dangish.evogent;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicInteger;

/** Host-side ordering/race tests for one assistant composer launch per invocation. */
public final class EvogentAssistantLaunchGateTest {
    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }

    public static void main(String[] args) throws Exception {
        showThenAssistLaunchesOnce();
        assistThenShowLaunchesOnce();
        timeoutUsesTheSameReadinessPath();
        cancellationRejectsEveryLateSignal();
        concurrentSignalsLaunchExactlyOnce();
        System.out.println("EvogentAssistantLaunchGateTest: PASS");
    }

    private static void showThenAssistLaunchesOnce() {
        EvogentAssistantLaunchGate gate = new EvogentAssistantLaunchGate();
        require(gate.onShow() == EvogentAssistantLaunchGate.Decision.WAIT,
                "show launched before context was sealed");
        require(gate.onContextReady() == EvogentAssistantLaunchGate.Decision.LAUNCH,
                "assist readiness did not launch the shown session");
        require(gate.onContextReady() == EvogentAssistantLaunchGate.Decision.WAIT,
                "duplicate assist callback launched a second composer");
        require(gate.onShow() == EvogentAssistantLaunchGate.Decision.WAIT,
                "duplicate show callback launched a second composer");
    }

    private static void assistThenShowLaunchesOnce() {
        EvogentAssistantLaunchGate gate = new EvogentAssistantLaunchGate();
        require(gate.onContextReady() == EvogentAssistantLaunchGate.Decision.WAIT,
                "context launched before Android showed the session");
        require(gate.onShow() == EvogentAssistantLaunchGate.Decision.LAUNCH,
                "shown session ignored already-sealed context");
        require(gate.onShow() == EvogentAssistantLaunchGate.Decision.WAIT,
                "repeated show relaunched the composer");
    }

    private static void timeoutUsesTheSameReadinessPath() {
        EvogentAssistantLaunchGate gate = new EvogentAssistantLaunchGate();
        require(gate.onShow() == EvogentAssistantLaunchGate.Decision.WAIT,
                "show launched without assist or timeout");
        require(gate.onContextReady() == EvogentAssistantLaunchGate.Decision.LAUNCH,
                "empty timeout context did not release the composer");
        require(gate.onContextReady() == EvogentAssistantLaunchGate.Decision.WAIT,
                "late real assist context relaunched after timeout");
    }

    private static void cancellationRejectsEveryLateSignal() {
        EvogentAssistantLaunchGate gate = new EvogentAssistantLaunchGate();
        require(gate.onShow() == EvogentAssistantLaunchGate.Decision.WAIT,
                "precondition failed");
        gate.cancel();
        require(gate.onContextReady() == EvogentAssistantLaunchGate.Decision.WAIT,
                "late assist launched a cancelled session");
        require(gate.onShow() == EvogentAssistantLaunchGate.Decision.WAIT,
                "late show launched a cancelled session");
    }

    private static void concurrentSignalsLaunchExactlyOnce() throws Exception {
        final EvogentAssistantLaunchGate gate = new EvogentAssistantLaunchGate();
        final CountDownLatch start = new CountDownLatch(1);
        final AtomicInteger launches = new AtomicInteger();
        Thread show = new Thread(new Runnable() {
            @Override public void run() {
                await(start);
                for (int attempt = 0; attempt < 1000; attempt++) {
                    if (gate.onShow() == EvogentAssistantLaunchGate.Decision.LAUNCH) {
                        launches.incrementAndGet();
                    }
                }
            }
        });
        Thread context = new Thread(new Runnable() {
            @Override public void run() {
                await(start);
                for (int attempt = 0; attempt < 1000; attempt++) {
                    if (gate.onContextReady() == EvogentAssistantLaunchGate.Decision.LAUNCH) {
                        launches.incrementAndGet();
                    }
                }
            }
        });
        show.start();
        context.start();
        start.countDown();
        show.join();
        context.join();
        require(launches.get() == 1,
                "concurrent callbacks emitted " + launches.get() + " launches");
    }

    private static void await(CountDownLatch latch) {
        try {
            latch.await();
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new AssertionError("test thread interrupted");
        }
    }
}

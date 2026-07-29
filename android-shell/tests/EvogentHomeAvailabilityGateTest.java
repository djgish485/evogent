package net.dangish.evogent;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/** Host-side race checks for system-HOME's bounded wait and native fallback. */
public final class EvogentHomeAvailabilityGateTest {
    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }

    public static void main(String[] args) {
        everyInvocationRequiresFreshProof();
        freshProofPermitsEvogentExactlyOnce();
        failureOrTimeoutRedirectsExactlyOnce();
        staleSignalsCannotRedirectALaterInvocation();
        explicitLaunchCancellationWins();
        pauseBeforeFallbackPreventsLaunch();
        backgroundDeadlineExpiresWithoutLaunching();
        resumeRearmIsAtomicAgainstOldDeadline();
        fallbackLaunchAndPauseHaveOneOrder();
        failedLaunchIsNotPreservedAcrossPause();
        System.out.println("EvogentHomeAvailabilityGateTest: PASS");
    }

    private static EvogentHomeAvailabilityGate foregroundGate() {
        EvogentHomeAvailabilityGate gate = new EvogentHomeAvailabilityGate();
        gate.enterForeground();
        return gate;
    }

    private static void everyInvocationRequiresFreshProof() {
        EvogentHomeAvailabilityGate gate = foregroundGate();
        long request = gate.arm();
        require(request != 0L, "system HOME trusted a cached process proof");
        require(gate.isActive(request), "new system HOME request was not active");
    }

    private static void freshProofPermitsEvogentExactlyOnce() {
        EvogentHomeAvailabilityGate gate = foregroundGate();
        long request = gate.arm();
        require(gate.markUsable(request),
                "fresh process proof did not release Evogent HOME");
        require(!gate.isActive(request),
                "proved HOME request remained active");
        require(!gate.markUsable(request),
                "duplicate process proof released Evogent HOME twice");
        require(gate.onUnavailable(request)
                        == EvogentHomeAvailabilityGate.Decision.WAIT,
                "proved Evogent HOME was redirected by a pending timeout");
    }

    private static void failureOrTimeoutRedirectsExactlyOnce() {
        EvogentHomeAvailabilityGate gate = foregroundGate();
        long request = gate.arm();
        require(request != 0L, "unavailable Evogent HOME did not arm a fallback");
        require(gate.onUnavailable(request)
                        == EvogentHomeAvailabilityGate.Decision.FALL_BACK_TO_ANDROID,
                "first unavailability signal did not request Android HOME");
        require(gate.onUnavailable(request)
                        == EvogentHomeAvailabilityGate.Decision.WAIT,
                "duplicate failure requested a second Android HOME launch");
    }

    private static void staleSignalsCannotRedirectALaterInvocation() {
        EvogentHomeAvailabilityGate gate = foregroundGate();
        long first = gate.arm();
        long second = gate.arm();
        require(first != second, "system-HOME requests reused a race token");
        require(!gate.isActive(first) && gate.isActive(second),
                "new HOME request did not supersede the old watchdog token");
        require(gate.onUnavailable(first)
                        == EvogentHomeAvailabilityGate.Decision.WAIT,
                "stale timeout redirected a later HOME invocation");
        require(!gate.markUsable(first),
                "stale proof released a later HOME invocation");
        require(gate.markUsable(second),
                "current fresh proof did not release HOME");
        require(gate.onUnavailable(second)
                        == EvogentHomeAvailabilityGate.Decision.WAIT,
                "proved document was redirected by a pending timeout");
    }

    private static void explicitLaunchCancellationWins() {
        EvogentHomeAvailabilityGate gate = foregroundGate();
        long systemHome = gate.arm();
        gate.cancel();
        require(gate.onUnavailable(systemHome)
                        == EvogentHomeAvailabilityGate.Decision.WAIT,
                "explicit Evogent launch was redirected by old system-HOME work");
        require(!gate.markUsable(systemHome),
                "old process proof dispatched into an explicit Evogent launch");
    }

    private static void pauseBeforeFallbackPreventsLaunch() {
        EvogentHomeAvailabilityGate gate = foregroundGate();
        long request = gate.arm();
        require(!gate.leaveForeground(request),
                "an unlaunched fallback was preserved across pause");
        final boolean[] called = { false };
        require(gate.launchFallbackIfCurrent(
                        request,
                        new EvogentHomeAvailabilityGate.FallbackAction() {
                            @Override public boolean launch() {
                                called[0] = true;
                                return true;
                            }
                        })
                        == EvogentHomeAvailabilityGate.FallbackResult.NOT_CURRENT,
                "paused HOME request retained fallback authority");
        require(!called[0], "paused HOME request launched Android");
    }

    private static void backgroundDeadlineExpiresWithoutLaunching() {
        EvogentHomeAvailabilityGate gate = new EvogentHomeAvailabilityGate();
        long request = gate.arm();
        final boolean[] called = { false };
        require(gate.launchFallbackIfCurrent(
                        request,
                        new EvogentHomeAvailabilityGate.FallbackAction() {
                            @Override public boolean launch() {
                                called[0] = true;
                                return true;
                            }
                        })
                        == EvogentHomeAvailabilityGate.FallbackResult
                                .EXPIRED_WHILE_BACKGROUND,
                "background HOME deadline did not explicitly expire its token");
        require(!called[0], "background HOME deadline launched over another app");
        require(!gate.isActive(request),
                "background HOME deadline left an expired request reusable on resume");
    }

    private static void resumeRearmIsAtomicAgainstOldDeadline() {
        EvogentHomeAvailabilityGate gate = new EvogentHomeAvailabilityGate();
        long oldRequest = gate.arm();
        long resumedRequest = gate.enterForegroundAndArm();
        require(oldRequest != resumedRequest,
                "resume reused the paused HOME request");
        final boolean[] oldCalled = { false };
        require(gate.launchFallbackIfCurrent(
                        oldRequest,
                        new EvogentHomeAvailabilityGate.FallbackAction() {
                            @Override public boolean launch() {
                                oldCalled[0] = true;
                                return true;
                            }
                        })
                        == EvogentHomeAvailabilityGate.FallbackResult.NOT_CURRENT,
                "old background deadline retained authority after atomic resume rearm");
        require(!oldCalled[0], "old background deadline launched during resume");
        require(gate.isActive(resumedRequest),
                "fresh foreground HOME budget was not active after resume");
    }

    private static void fallbackLaunchAndPauseHaveOneOrder() {
        final EvogentHomeAvailabilityGate gate = foregroundGate();
        final long request = gate.arm();
        final CountDownLatch launchEntered = new CountDownLatch(1);
        final CountDownLatch releaseLaunch = new CountDownLatch(1);
        final CountDownLatch pauseAttempted = new CountDownLatch(1);
        final CountDownLatch pauseReturned = new CountDownLatch(1);
        final EvogentHomeAvailabilityGate.FallbackResult[] result = {
                EvogentHomeAvailabilityGate.FallbackResult.NOT_CURRENT
        };
        final boolean[] preserved = { false };

        Thread launcher = new Thread(new Runnable() {
            @Override public void run() {
                result[0] = gate.launchFallbackIfCurrent(
                        request,
                        new EvogentHomeAvailabilityGate.FallbackAction() {
                            @Override public boolean launch() {
                                launchEntered.countDown();
                                try {
                                    return releaseLaunch.await(2, TimeUnit.SECONDS);
                                } catch (InterruptedException interrupted) {
                                    Thread.currentThread().interrupt();
                                    return false;
                                }
                            }
                        });
            }
        });
        Thread pauser = new Thread(new Runnable() {
            @Override public void run() {
                pauseAttempted.countDown();
                preserved[0] = gate.leaveForeground(request);
                pauseReturned.countDown();
            }
        });
        launcher.start();
        try {
            require(launchEntered.await(2, TimeUnit.SECONDS),
                    "fallback action did not enter");
            pauser.start();
            require(pauseAttempted.await(2, TimeUnit.SECONDS),
                    "pause thread did not attempt the lifecycle transition");
            long blockedDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(2);
            while (pauser.getState() != Thread.State.BLOCKED
                    && pauseReturned.getCount() != 0L
                    && System.nanoTime() < blockedDeadline) {
                Thread.yield();
            }
            require(pauser.getState() == Thread.State.BLOCKED,
                    "pause was not serialized behind the in-flight fallback launch");
            releaseLaunch.countDown();
            launcher.join(2000);
            pauser.join(2000);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new AssertionError("fallback race test interrupted");
        }
        require(result[0] == EvogentHomeAvailabilityGate.FallbackResult.LAUNCHED,
                "fallback launch did not complete");
        require(preserved[0],
                "pause did not preserve the already-completed fallback cleanup");
    }

    private static void failedLaunchIsNotPreservedAcrossPause() {
        EvogentHomeAvailabilityGate gate = foregroundGate();
        long request = gate.arm();
        require(gate.launchFallbackIfCurrent(
                        request,
                        new EvogentHomeAvailabilityGate.FallbackAction() {
                            @Override public boolean launch() {
                                return false;
                            }
                        })
                        == EvogentHomeAvailabilityGate.FallbackResult.LAUNCH_FAILED,
                "failed fallback action was not reported");
        require(!gate.leaveForeground(request),
                "failed fallback was preserved as a successful launch");
    }
}

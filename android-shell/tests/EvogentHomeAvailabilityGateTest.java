package net.dangish.evogent;

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
        System.out.println("EvogentHomeAvailabilityGateTest: PASS");
    }

    private static void everyInvocationRequiresFreshProof() {
        EvogentHomeAvailabilityGate gate = new EvogentHomeAvailabilityGate();
        long request = gate.arm();
        require(request != 0L, "system HOME trusted a cached process proof");
    }

    private static void freshProofPermitsEvogentExactlyOnce() {
        EvogentHomeAvailabilityGate gate = new EvogentHomeAvailabilityGate();
        long request = gate.arm();
        require(gate.markUsable(request),
                "fresh process proof did not release Evogent HOME");
        require(!gate.markUsable(request),
                "duplicate process proof released Evogent HOME twice");
        require(gate.onUnavailable(request)
                        == EvogentHomeAvailabilityGate.Decision.WAIT,
                "proved Evogent HOME was redirected by a pending timeout");
    }

    private static void failureOrTimeoutRedirectsExactlyOnce() {
        EvogentHomeAvailabilityGate gate = new EvogentHomeAvailabilityGate();
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
        EvogentHomeAvailabilityGate gate = new EvogentHomeAvailabilityGate();
        long first = gate.arm();
        long second = gate.arm();
        require(first != second, "system-HOME requests reused a race token");
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
        EvogentHomeAvailabilityGate gate = new EvogentHomeAvailabilityGate();
        long systemHome = gate.arm();
        gate.cancel();
        require(gate.onUnavailable(systemHome)
                        == EvogentHomeAvailabilityGate.Decision.WAIT,
                "explicit Evogent launch was redirected by old system-HOME work");
        require(!gate.markUsable(systemHome),
                "old process proof dispatched into an explicit Evogent launch");
    }
}

package net.dangish.evogent;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/** Host-side checks for explicit HOME-surface memory and system-HOME routing. */
public final class EvogentHomeChoicePolicyTest {
    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }

    public static void main(String[] args) {
        unknownOrMissingPreferenceDefaultsToEvogent();
        onlyExplicitSurfaceChoicesMutateIntent();
        systemHomeFollowsRememberedSurface();
        androidTransitionPersistsBeforeLaunch();
        failedAndroidTransitionsRestoreEvogent();
        rememberedAndroidRouteDoesNotRewriteChoice();
        automaticFallbackNeverChangesExplicitChoice();
        System.out.println("EvogentHomeChoicePolicyTest: PASS");
    }

    private static void unknownOrMissingPreferenceDefaultsToEvogent() {
        require(EvogentHomeChoicePolicy.decode(null)
                        == EvogentHomeChoicePolicy.Choice.EVOGENT,
                "missing preference did not fail safe to Evogent");
        require(EvogentHomeChoicePolicy.decode("corrupt")
                        == EvogentHomeChoicePolicy.Choice.EVOGENT,
                "corrupt preference escaped to another launcher");
        require(EvogentHomeChoicePolicy.decode("android")
                        == EvogentHomeChoicePolicy.Choice.ANDROID,
                "valid Android preference was not restored");
    }

    private static void onlyExplicitSurfaceChoicesMutateIntent() {
        require(EvogentHomeChoicePolicy.explicitlyChoosesEvogent(
                        true, true, false, false),
                "tapping Evogent's launcher icon did not choose Evogent");
        require(EvogentHomeChoicePolicy.explicitlyChoosesEvogent(
                        false, false, false, true),
                "explicit stock-home return did not choose Evogent");
        require(!EvogentHomeChoicePolicy.explicitlyChoosesEvogent(
                        true, false, true, false),
                "system HOME gesture overwrote the remembered surface");
        require(!EvogentHomeChoicePolicy.explicitlyChoosesEvogent(
                        false, false, false, false),
                "ordinary activity resume overwrote the remembered surface");
        require(!EvogentHomeChoicePolicy.explicitlyChoosesEvogent(
                        false, true, false, false),
                "malformed non-MAIN launcher intent mutated the remembered surface");
    }

    private static void systemHomeFollowsRememberedSurface() {
        require(EvogentHomeChoicePolicy.isSystemHomeInvocation(true, true, false),
                "exact MAIN+HOME invocation was not classified as system HOME");
        require(!EvogentHomeChoicePolicy.isSystemHomeInvocation(true, true, true),
                "ambiguous HOME+LAUNCHER invocation was classified as system HOME");
        require(!EvogentHomeChoicePolicy.isSystemHomeInvocation(false, true, false),
                "non-MAIN HOME invocation was classified as system HOME");
        require(EvogentHomeChoicePolicy.shouldRouteSystemHomeToAndroid(
                        true, true, false, EvogentHomeChoicePolicy.Choice.ANDROID),
                "HOME ignored the user's stock-launcher choice");
        require(!EvogentHomeChoicePolicy.shouldRouteSystemHomeToAndroid(
                        true, true, false, EvogentHomeChoicePolicy.Choice.EVOGENT),
                "HOME left Evogent after the user chose Evogent");
        require(!EvogentHomeChoicePolicy.shouldRouteSystemHomeToAndroid(
                        true, false, true, EvogentHomeChoicePolicy.Choice.ANDROID),
                "launcher-icon invocation was misrouted to Android HOME");
        require(!EvogentHomeChoicePolicy.shouldRouteSystemHomeToAndroid(
                        true, true, true, EvogentHomeChoicePolicy.Choice.ANDROID),
                "ambiguous explicit launch was treated as a system HOME gesture");
        require(!EvogentHomeChoicePolicy.shouldRouteSystemHomeToAndroid(
                        false, true, false, EvogentHomeChoicePolicy.Choice.ANDROID),
                "malformed non-MAIN HOME intent escaped to Android HOME");
    }

    private static void androidTransitionPersistsBeforeLaunch() {
        final List<String> calls = new ArrayList<String>();
        boolean launched = EvogentHomeChoicePolicy.chooseAndLaunchAndroidHome(
                new EvogentHomeChoicePolicy.AndroidHomeActions<String>() {
                    @Override public String resolve() {
                        calls.add("resolve");
                        return "pixel";
                    }

                    @Override public boolean persist(EvogentHomeChoicePolicy.Choice choice) {
                        calls.add("persist:" + EvogentHomeChoicePolicy.encode(choice));
                        return true;
                    }

                    @Override public boolean launch(String target) {
                        calls.add("launch:" + target);
                        return true;
                    }
                });
        require(launched, "valid Android HOME transition failed");
        require(calls.equals(Arrays.asList(
                        "resolve",
                        "persist:android",
                        "launch:pixel")),
                "Android HOME launched before its choice was durably persisted: " + calls);
    }

    private static void failedAndroidTransitionsRestoreEvogent() {
        requireFailedTransition(
                null,
                true,
                true,
                Arrays.asList("resolve", "persist:evogent"),
                "missing Android HOME target");
        requireFailedTransition(
                "pixel",
                false,
                true,
                Arrays.asList("resolve", "persist:android", "persist:evogent"),
                "failed Android preference commit");
        requireFailedTransition(
                "pixel",
                true,
                false,
                Arrays.asList(
                        "resolve",
                        "persist:android",
                        "launch:pixel",
                        "persist:evogent"),
                "failed Android HOME start");
    }

    private static void automaticFallbackNeverChangesExplicitChoice() {
        final List<String> successfulCalls = new ArrayList<String>();
        boolean launched = EvogentHomeChoicePolicy.launchAndroidHomeWithoutChangingChoice(
                new EvogentHomeChoicePolicy.AndroidHomeActions<String>() {
                    @Override public String resolve() {
                        successfulCalls.add("resolve");
                        return "pixel";
                    }

                    @Override public boolean persist(EvogentHomeChoicePolicy.Choice choice) {
                        successfulCalls.add(
                                "persist:" + EvogentHomeChoicePolicy.encode(choice));
                        throw new AssertionError(
                                "automatic fallback attempted to mutate explicit choice");
                    }

                    @Override public boolean launch(String target) {
                        successfulCalls.add("launch:" + target);
                        return true;
                    }
                });
        require(launched, "automatic Android HOME fallback did not launch");
        require(successfulCalls.equals(Arrays.asList("resolve", "launch:pixel")),
                "automatic fallback changed explicit choice: " + successfulCalls);

        final List<String> failedCalls = new ArrayList<String>();
        boolean failed = EvogentHomeChoicePolicy.launchAndroidHomeWithoutChangingChoice(
                new EvogentHomeChoicePolicy.AndroidHomeActions<String>() {
                    @Override public String resolve() {
                        failedCalls.add("resolve");
                        return "pixel";
                    }

                    @Override public boolean persist(EvogentHomeChoicePolicy.Choice choice) {
                        failedCalls.add(
                                "persist:" + EvogentHomeChoicePolicy.encode(choice));
                        throw new AssertionError(
                                "failed fallback attempted to mutate explicit choice");
                    }

                    @Override public boolean launch(String target) {
                        failedCalls.add("launch:" + target);
                        return false;
                    }
                });
        require(!failed, "failed automatic Android HOME launch reported success");
        require(failedCalls.equals(Arrays.asList("resolve", "launch:pixel")),
                "failed fallback rewrote explicit choice: " + failedCalls);
    }

    private static void rememberedAndroidRouteDoesNotRewriteChoice() {
        final List<String> successfulCalls = new ArrayList<String>();
        boolean launched = EvogentHomeChoicePolicy.launchRememberedAndroidHome(
                new EvogentHomeChoicePolicy.AndroidHomeActions<String>() {
                    @Override public String resolve() {
                        successfulCalls.add("resolve");
                        return "pixel";
                    }

                    @Override public boolean persist(EvogentHomeChoicePolicy.Choice choice) {
                        successfulCalls.add(
                                "persist:" + EvogentHomeChoicePolicy.encode(choice));
                        return true;
                    }

                    @Override public boolean launch(String target) {
                        successfulCalls.add("launch:" + target);
                        return true;
                    }
                });
        require(launched, "remembered Android HOME did not launch");
        require(successfulCalls.equals(Arrays.asList("resolve", "launch:pixel")),
                "system HOME rewrote its remembered Android choice: " + successfulCalls);

        final List<String> failedCalls = new ArrayList<String>();
        boolean failed = EvogentHomeChoicePolicy.launchRememberedAndroidHome(
                new EvogentHomeChoicePolicy.AndroidHomeActions<String>() {
                    @Override public String resolve() {
                        failedCalls.add("resolve");
                        return "pixel";
                    }

                    @Override public boolean persist(EvogentHomeChoicePolicy.Choice choice) {
                        failedCalls.add(
                                "persist:" + EvogentHomeChoicePolicy.encode(choice));
                        return true;
                    }

                    @Override public boolean launch(String target) {
                        failedCalls.add("launch:" + target);
                        return false;
                    }
                });
        require(!failed, "failed remembered Android HOME launch reported success");
        require(failedCalls.equals(Arrays.asList(
                        "resolve",
                        "launch:pixel",
                        "persist:evogent")),
                "failed remembered route did not clear its stale choice: " + failedCalls);
    }

    private static void requireFailedTransition(
            final String target,
            final boolean persistAndroid,
            final boolean launchResult,
            List<String> expectedCalls,
            String label) {
        final List<String> calls = new ArrayList<String>();
        boolean launched = EvogentHomeChoicePolicy.chooseAndLaunchAndroidHome(
                new EvogentHomeChoicePolicy.AndroidHomeActions<String>() {
                    @Override public String resolve() {
                        calls.add("resolve");
                        return target;
                    }

                    @Override public boolean persist(EvogentHomeChoicePolicy.Choice choice) {
                        calls.add("persist:" + EvogentHomeChoicePolicy.encode(choice));
                        return choice != EvogentHomeChoicePolicy.Choice.ANDROID
                                || persistAndroid;
                    }

                    @Override public boolean launch(String resolved) {
                        calls.add("launch:" + resolved);
                        return launchResult;
                    }
                });
        require(!launched, label + " unexpectedly reported success");
        require(calls.equals(expectedCalls),
                label + " did not restore the safe choice in order: " + calls);
    }
}

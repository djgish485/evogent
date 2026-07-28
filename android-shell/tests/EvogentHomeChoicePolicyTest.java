package net.dangish.evogent;

/** Host-side checks for explicit HOME-surface memory and system-HOME routing. */
public final class EvogentHomeChoicePolicyTest {
    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }

    public static void main(String[] args) {
        unknownOrMissingPreferenceDefaultsToEvogent();
        onlyExplicitSurfaceChoicesMutateIntent();
        systemHomeFollowsRememberedSurface();
        failedStockLaunchCannotCreateAHomeLoop();
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

    private static void failedStockLaunchCannotCreateAHomeLoop() {
        require(EvogentHomeChoicePolicy.choiceAfterAndroidLaunchAttempt(true)
                        == EvogentHomeChoicePolicy.Choice.ANDROID,
                "successful explicit stock launch was not remembered");
        require(EvogentHomeChoicePolicy.choiceAfterAndroidLaunchAttempt(false)
                        == EvogentHomeChoicePolicy.Choice.EVOGENT,
                "failed stock launch left a choice that would loop on every HOME gesture");
    }
}

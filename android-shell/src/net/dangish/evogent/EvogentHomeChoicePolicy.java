package net.dangish.evogent;

/**
 * Pure launcher-routing policy.
 *
 * Android has exactly one HOME role holder. Evogent remains that holder and acts as a tiny
 * preference-aware router when the user most recently chose the stock launcher. The preference
 * changes only on an explicit surface switch: opening an ordinary app never changes it.
 */
final class EvogentHomeChoicePolicy {
    static final String VALUE_EVOGENT = "evogent";
    static final String VALUE_ANDROID = "android";

    enum Choice {
        EVOGENT,
        ANDROID
    }

    private EvogentHomeChoicePolicy() {}

    static Choice decode(String storedValue) {
        return VALUE_ANDROID.equals(storedValue) ? Choice.ANDROID : Choice.EVOGENT;
    }

    static String encode(Choice choice) {
        return choice == Choice.ANDROID ? VALUE_ANDROID : VALUE_EVOGENT;
    }

    /**
     * CATEGORY_LAUNCHER or Evogent's explicit return action means the user chose Evogent.
     * CATEGORY_HOME by itself is a system HOME gesture and must not overwrite remembered intent.
     */
    static boolean explicitlyChoosesEvogent(
            boolean isMainAction,
            boolean hasLauncherCategory,
            boolean hasHomeCategory,
            boolean hasExplicitReturnAction) {
        return hasExplicitReturnAction
                || (isMainAction && hasLauncherCategory && !hasHomeCategory);
    }

    static boolean shouldRouteSystemHomeToAndroid(
            boolean isMainAction,
            boolean hasHomeCategory,
            boolean hasLauncherCategory,
            Choice rememberedChoice) {
        return isMainAction
                && hasHomeCategory
                && !hasLauncherCategory
                && rememberedChoice == Choice.ANDROID;
    }

    /** A missing/stale stock component must collapse back to the role-holding safe surface. */
    static Choice choiceAfterAndroidLaunchAttempt(boolean launched) {
        return launched ? Choice.ANDROID : Choice.EVOGENT;
    }
}

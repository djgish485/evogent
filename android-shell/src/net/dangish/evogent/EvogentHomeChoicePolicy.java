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

    /**
     * Android-facing operations for the explicit stock-HOME transition.
     *
     * Keeping the ordering in this pure policy makes the important durability contract
     * host-testable: resolve first, persist Android synchronously, then launch. Any failure
     * attempts to restore Evogent before the caller exposes its native app-drawer fallback.
     */
    interface AndroidHomeActions<T> {
        T resolve();
        boolean persist(Choice choice);
        boolean launch(T target);
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
        return isSystemHomeInvocation(
                        isMainAction,
                        hasHomeCategory,
                        hasLauncherCategory)
                && rememberedChoice == Choice.ANDROID;
    }

    static boolean isSystemHomeInvocation(
            boolean isMainAction,
            boolean hasHomeCategory,
            boolean hasLauncherCategory) {
        return isMainAction && hasHomeCategory && !hasLauncherCategory;
    }

    /**
     * Resolve, durably remember, and only then leave for Android HOME.
     *
     * The callback boundary deliberately treats exceptions as failure because PackageManager,
     * SharedPreferences, and startActivity are all outside the pure policy. A failed recovery
     * write cannot make the current launch succeed, but the caller remains on Evogent's native
     * recovery surface and the next HOME invocation gets another chance to repair the choice.
     */
    static <T> boolean chooseAndLaunchAndroidHome(AndroidHomeActions<T> actions) {
        if (actions == null) return false;
        T target;
        try {
            target = actions.resolve();
        } catch (Throwable ignored) {
            restoreEvogent(actions);
            return false;
        }
        if (target == null) {
            restoreEvogent(actions);
            return false;
        }

        boolean persistedAndroid;
        try {
            persistedAndroid = actions.persist(Choice.ANDROID);
        } catch (Throwable ignored) {
            persistedAndroid = false;
        }
        if (!persistedAndroid) {
            restoreEvogent(actions);
            return false;
        }

        boolean launched;
        try {
            launched = actions.launch(target);
        } catch (Throwable ignored) {
            launched = false;
        }
        if (!launched) restoreEvogent(actions);
        return launched;
    }

    /**
     * Follow an already-remembered Android choice without rewriting it on every HOME gesture.
     *
     * A missing or failed Android component is the one exception: restore Evogent so the stale
     * remembered component cannot create a permanent HOME loop.
     */
    static <T> boolean launchRememberedAndroidHome(AndroidHomeActions<T> actions) {
        if (actions == null) return false;
        T target;
        try {
            target = actions.resolve();
        } catch (Throwable ignored) {
            restoreEvogent(actions);
            return false;
        }
        if (target == null) {
            restoreEvogent(actions);
            return false;
        }
        boolean launched;
        try {
            launched = actions.launch(target);
        } catch (Throwable ignored) {
            launched = false;
        }
        if (!launched) restoreEvogent(actions);
        return launched;
    }

    /**
     * Leave an unavailable Evogent HOME for Android without changing the user's explicit choice.
     *
     * A runtime outage is not a surface selection. In particular, this path must never call
     * {@link AndroidHomeActions#persist}; once Evogent recovers, the next system-HOME invocation
     * still follows the last surface the user explicitly chose.
     */
    static <T> boolean launchAndroidHomeWithoutChangingChoice(AndroidHomeActions<T> actions) {
        if (actions == null) return false;
        T target;
        try {
            target = actions.resolve();
        } catch (Throwable ignored) {
            return false;
        }
        if (target == null) return false;
        try {
            return actions.launch(target);
        } catch (Throwable ignored) {
            return false;
        }
    }

    private static <T> void restoreEvogent(AndroidHomeActions<T> actions) {
        try {
            actions.persist(Choice.EVOGENT);
        } catch (Throwable ignored) {
            // The native recovery surface remains usable even if durable storage is unavailable.
        }
    }
}

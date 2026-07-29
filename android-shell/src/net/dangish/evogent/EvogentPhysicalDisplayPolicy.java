package net.dangish.evogent;

import java.util.HashSet;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Android-free guard used at the shell-uid force-stop boundary. */
final class EvogentPhysicalDisplayPolicy {
    private static final Pattern DISPLAY =
            Pattern.compile("^\\s*Display\\s+#?([0-9]+)(?:[\\s:(].*)?$");
    private static final Pattern COMPONENT = Pattern.compile(
            "\\b([A-Za-z][A-Za-z0-9_]*(?:\\.[A-Za-z][A-Za-z0-9_]*)+)/\\S+");
    private static final Pattern PACKAGE = Pattern.compile(
            "^[A-Za-z][A-Za-z0-9_]*(?:\\.[A-Za-z][A-Za-z0-9_]*)+$");
    private static final Pattern WAKE_FIELD =
            Pattern.compile("\\b(?:mWakefulness|mInteractive)=([^\\s]+)");
    private static final Pattern KEYGUARD_ALIAS = Pattern.compile(
            "\\b(?:mDreamingLockscreen|mShowingLockscreen|mKeyguardShowing"
            + "|isKeyguardShowing)=(true|false)");
    private static final Pattern DELEGATE_SHOWING =
            Pattern.compile("^showing=(true|false)$");
    private static final Pattern DELEGATE_OCCLUDED =
            Pattern.compile("^occluded=(true|false)$");
    private static final Pattern MONITOR_SHOWING =
            Pattern.compile("^mIsShowing=(true|false)$");

    enum WakeState {
        AWAKE,
        NOT_AWAKE,
        UNKNOWN
    }

    enum LockscreenState {
        LOCKED,
        UNLOCKED,
        UNKNOWN
    }

    enum OcclusionState {
        OCCLUDED,
        NON_OCCLUDED,
        UNKNOWN
    }

    private EvogentPhysicalDisplayPolicy() {}

    static String displayZeroResumedPackage(String dump) {
        if (dump == null || dump.isEmpty()) return null;
        boolean inDisplayZero = false;
        Set<String> packages = new HashSet<String>();
        for (String line : dump.split("\\r?\\n")) {
            Matcher display = DISPLAY.matcher(line);
            if (display.matches()) {
                inDisplayZero = "0".equals(display.group(1));
                continue;
            }
            if (!inDisplayZero
                    || !(line.contains("topResumedActivity=")
                         || line.contains("mResumedActivity:"))) {
                continue;
            }
            Matcher component = COMPONENT.matcher(line);
            if (component.find()) packages.add(component.group(1));
        }
        return packages.size() == 1 ? packages.iterator().next() : null;
    }

    static WakeState screenWakeStateFromDump(String dump) {
        if (dump == null || dump.isEmpty()) return WakeState.UNKNOWN;
        boolean awake = false;
        boolean notAwake = false;
        boolean unknown = false;
        Matcher field = WAKE_FIELD.matcher(dump);
        while (field.find()) {
            String value = field.group(1);
            if ("Awake".equals(value) || "1".equals(value) || "true".equals(value)) {
                awake = true;
            } else if ("Asleep".equals(value) || "Dreaming".equals(value)
                    || "Dozing".equals(value) || "0".equals(value)
                    || "2".equals(value) || "3".equals(value)
                    || "false".equals(value)) {
                notAwake = true;
            } else {
                unknown = true;
            }
        }
        if (unknown || awake == notAwake) return WakeState.UNKNOWN;
        return awake ? WakeState.AWAKE : WakeState.NOT_AWAKE;
    }

    static LockscreenState lockscreenStateFromDump(String dump) {
        if (dump == null || dump.isEmpty()) return LockscreenState.UNKNOWN;
        boolean locked = false;
        boolean unlocked = false;
        boolean inDelegate = false;
        boolean inMonitor = false;
        int delegateIndent = -1;
        int monitorIndent = -1;

        for (String raw : dump.split("\\r?\\n")) {
            int indent = leadingWhitespace(raw);
            String trimmed = raw.trim();

            if ("KeyguardServiceDelegate".equals(trimmed)) {
                delegateIndent = indent;
                inDelegate = true;
                inMonitor = false;
                continue;
            }
            if (inDelegate && !trimmed.isEmpty() && indent <= delegateIndent) {
                inDelegate = false;
                inMonitor = false;
            }
            if (inDelegate && "KeyguardStateMonitor".equals(trimmed)
                    && indent == delegateIndent + 2) {
                monitorIndent = indent;
                inMonitor = true;
                continue;
            }
            if (inMonitor && !trimmed.isEmpty() && indent <= monitorIndent) {
                inMonitor = false;
            }

            Matcher showing = DELEGATE_SHOWING.matcher(trimmed);
            if (inDelegate && indent == delegateIndent + 2 && showing.matches()) {
                if ("true".equals(showing.group(1))) locked = true;
                else unlocked = true;
            }
            Matcher monitorShowing = MONITOR_SHOWING.matcher(trimmed);
            if (inMonitor && indent == monitorIndent + 2 && monitorShowing.matches()) {
                if ("true".equals(monitorShowing.group(1))) locked = true;
                else unlocked = true;
            }

            Matcher alias = KEYGUARD_ALIAS.matcher(raw);
            while (alias.find()) {
                if ("true".equals(alias.group(1))) locked = true;
                else unlocked = true;
            }
        }
        if (locked == unlocked) return LockscreenState.UNKNOWN;
        return locked ? LockscreenState.LOCKED : LockscreenState.UNLOCKED;
    }

    static OcclusionState keyguardOcclusionStateFromDump(String dump) {
        if (dump == null || dump.isEmpty()) return OcclusionState.UNKNOWN;
        boolean occluded = false;
        boolean nonOccluded = false;
        boolean inDelegate = false;
        int delegateIndent = -1;

        for (String raw : dump.split("\\r?\\n")) {
            int indent = leadingWhitespace(raw);
            String trimmed = raw.trim();
            if ("KeyguardServiceDelegate".equals(trimmed)) {
                delegateIndent = indent;
                inDelegate = true;
                continue;
            }
            if (inDelegate && !trimmed.isEmpty() && indent <= delegateIndent) {
                inDelegate = false;
            }
            Matcher field = DELEGATE_OCCLUDED.matcher(trimmed);
            if (inDelegate && indent == delegateIndent + 2 && field.matches()) {
                if ("true".equals(field.group(1))) occluded = true;
                else nonOccluded = true;
            }
        }
        if (occluded == nonOccluded) return OcclusionState.UNKNOWN;
        return occluded ? OcclusionState.OCCLUDED : OcclusionState.NON_OCCLUDED;
    }

    static boolean isValidTargetPackage(String targetPackage) {
        return targetPackage != null && PACKAGE.matcher(targetPackage).matches();
    }

    static boolean isStrictlyLockedAndNonOccluded(String windowDump) {
        return lockscreenStateFromDump(windowDump) == LockscreenState.LOCKED
                && keyguardOcclusionStateFromDump(windowDump)
                == OcclusionState.NON_OCCLUDED;
    }

    static boolean isStrictlyUnlocked(String windowDump) {
        return lockscreenStateFromDump(windowDump) == LockscreenState.UNLOCKED;
    }

    static boolean isStrictlyAwake(String powerDump) {
        return screenWakeStateFromDump(powerDump) == WakeState.AWAKE;
    }

    static boolean isStrictlyNotAwake(String powerDump) {
        return screenWakeStateFromDump(powerDump) == WakeState.NOT_AWAKE;
    }

    /**
     * Final awake-and-unlocked branch proof. The caller must collect this activity dump last and
     * invoke the mutation immediately after a true result. Lock/sleep evidence deliberately is not
     * accepted here, so an older unattended snapshot cannot override a later target-foreground
     * transition.
     */
    static boolean hasExactDifferentDisplayZeroForeground(
            String targetPackage, String activityDump) {
        if (!isValidTargetPackage(targetPackage)) return false;
        String foreground = displayZeroResumedPackage(activityDump);
        return foreground != null && !foreground.equals(targetPackage);
    }

    private static int leadingWhitespace(String value) {
        int index = 0;
        while (index < value.length() && Character.isWhitespace(value.charAt(index))) index++;
        return index;
    }
}

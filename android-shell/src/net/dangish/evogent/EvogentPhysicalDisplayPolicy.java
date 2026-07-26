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

    static boolean mayForceStop(String targetPackage, String activityDump) {
        if (targetPackage == null || !PACKAGE.matcher(targetPackage).matches()) return false;
        String foreground = displayZeroResumedPackage(activityDump);
        return foreground != null && !foreground.equals(targetPackage);
    }
}

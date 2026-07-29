package net.dangish.evogent;

import android.content.Context;
import android.graphics.PixelFormat;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.ImageReader;
import android.util.Log;

/**
 * Shizuku UserService: instantiated by Shizuku in a process running as the
 * shell user (uid 2000). Because it runs as shell it can create a TRUSTED
 * virtual display (which a normal app cannot — an app-owned untrusted display
 * refuses to host another app's activity) and launch an arbitrary app onto it.
 * The display is kept alive by holding its ImageReader/VirtualDisplay here.
 */
public class EvoPrivilegedService extends IEvoPrivileged.Stub {
    private static final String TAG = "EvoPriv";
    private static final long DUMPSYS_TIMEOUT_MS = 2000L;
    private static final long PACKAGE_COMMAND_TIMEOUT_MS = 3000L;
    private static final long ACTIVITY_START_TIMEOUT_MS = 5000L;
    private static final int COMMAND_OUTPUT_MAX_CHARS = 256 * 1024;
    // Mirror scrcpy's --new-display flag set exactly. The important ones: PUBLIC
    // (else the display is private and invisible to the accessibility service),
    // TRUSTED + OWN_DISPLAY_GROUP + OWN_FOCUS + ALWAYS_UNLOCKED (a self-contained,
    // independently-focusable secondary screen a foreign app can launch onto and
    // the on-device a11y service can enumerate/gesture/screenshot). @hide values,
    // stable since API 30/33.
    private static final int FLAG_PUBLIC = 1 << 0;
    private static final int FLAG_PRESENTATION = 1 << 1;
    private static final int FLAG_OWN_CONTENT_ONLY = 1 << 3;
    private static final int FLAG_ROTATES_WITH_CONTENT = 1 << 7;
    private static final int FLAG_DESTROY_CONTENT_ON_REMOVAL = 1 << 8;
    private static final int FLAG_SHOULD_SHOW_SYSTEM_DECORATIONS = 1 << 9;
    private static final int FLAG_TRUSTED = 1 << 10;
    private static final int FLAG_OWN_DISPLAY_GROUP = 1 << 11;
    private static final int FLAG_ALWAYS_UNLOCKED = 1 << 12;
    private static final int FLAG_TOUCH_FEEDBACK_DISABLED = 1 << 13;
    private static final int FLAG_OWN_FOCUS = 1 << 14;

    private final Context context;
    private ImageReader reader;
    private VirtualDisplay virtualDisplay;

    // Shizuku instantiates with a Context (preferred) — keep a no-arg fallback too.
    public EvoPrivilegedService(Context context) { this.context = context; }
    public EvoPrivilegedService() { this.context = null; }

    @Override
    public int createDisplay(int width, int height, int dpi) {
        try {
            // We run as uid 2000 (shell). createVirtualDisplay validates that the
            // context's packageName matches the calling uid, so use a context for
            // "com.android.shell" (uid 2000) instead of Evogent's own package.
            Context ctx = context;
            try {
                ctx = context.createPackageContext("com.android.shell", 0);
            } catch (Throwable t) {
                Log.w(TAG, "createPackageContext(shell) failed, using base context", t);
            }
            DisplayManager dm = ctx != null
                    ? (DisplayManager) ctx.getSystemService(Context.DISPLAY_SERVICE)
                    : null;
            if (dm == null) { Log.e(TAG, "no DisplayManager (context=" + ctx + ")"); return -1; }
            // Release any prior hidden display before creating a new one. Without this each
            // createDisplay orphaned the previous VirtualDisplay (the field was overwritten but the
            // display stayed alive until reboot); repeated op=launch — e.g. MainActivity registering
            // its receiver more than once so one broadcast fires several launches — leaked a new
            // "evo-hidden" display every time. Bounds the device to a single hidden display.
            if (virtualDisplay != null) { try { virtualDisplay.release(); } catch (Throwable ignored) {} virtualDisplay = null; }
            if (reader != null) { try { reader.close(); } catch (Throwable ignored) {} reader = null; }
            reader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2);
            int flags = FLAG_PUBLIC | FLAG_PRESENTATION | FLAG_OWN_CONTENT_ONLY
                      | FLAG_ROTATES_WITH_CONTENT | FLAG_DESTROY_CONTENT_ON_REMOVAL
                      | FLAG_SHOULD_SHOW_SYSTEM_DECORATIONS | FLAG_TRUSTED
                      | FLAG_OWN_DISPLAY_GROUP | FLAG_ALWAYS_UNLOCKED
                      | FLAG_TOUCH_FEEDBACK_DISABLED | FLAG_OWN_FOCUS;
            virtualDisplay = dm.createVirtualDisplay("evo-hidden", width, height, dpi,
                    reader.getSurface(), flags);
            int id = virtualDisplay.getDisplay().getDisplayId();
            Log.i(TAG, "createDisplay id=" + id + " (uid=" + android.os.Process.myUid() + ")");
            return id;
        } catch (Throwable t) {
            Log.e(TAG, "createDisplay failed", t);
            return -1;
        }
    }

    @Override
    public boolean launch(String pkg, String activity, int displayId) {
        try {
            int ownedDisplayId = virtualDisplay == null || virtualDisplay.getDisplay() == null
                    ? -1 : virtualDisplay.getDisplay().getDisplayId();
            if (displayId <= 0 || displayId != ownedDisplayId) {
                Log.e(TAG, "refusing launch on unowned/non-hidden display " + displayId);
                return false;
            }
            // singleTask/singleInstance apps (Gmail, YouTube, Twitter) would otherwise be
            // absorbed by an existing foreground instance instead of moving to the hidden
            // display, so force-stop first for a clean launch on the target display. Re-check at
            // this shell-uid mutation boundary as defense in depth: direct/internal callers may
            // not bypass phone.sh and kill the exact app resumed on physical display 0.
            if (!EvogentPhysicalDisplayPolicy.isValidTargetPackage(pkg)) {
                Log.w(TAG, "refusing invalid force-stop target");
                return false;
            }
            String windows = commandOutput(
                    new String[]{"dumpsys", "window"}, 2 * 1024 * 1024);
            // Each unattended proof is immediately followed by the mutation. Do not collect later
            // snapshots and then let older locked/asleep evidence override a foreground transition.
            if (EvogentPhysicalDisplayPolicy.isStrictlyLockedAndNonOccluded(windows)) {
                return forceStopAndLaunch(pkg, activity, displayId);
            }

            String power = commandOutput(
                    new String[]{"dumpsys", "power"}, 512 * 1024);
            if (EvogentPhysicalDisplayPolicy.isStrictlyNotAwake(power)) {
                return forceStopAndLaunch(pkg, activity, displayId);
            }
            if (!EvogentPhysicalDisplayPolicy.isStrictlyUnlocked(windows)
                    || !EvogentPhysicalDisplayPolicy.isStrictlyAwake(power)) {
                Log.w(TAG, "refusing force-stop without exact awake/unlocked proof for " + pkg);
                return false;
            }

            // On an awake and unlocked phone, activity is the final observation immediately before
            // mutation. It must prove one exact different package on physical display 0.
            String activities = commandOutput(
                    new String[]{"dumpsys", "activity", "activities"}, 2 * 1024 * 1024);
            if (!EvogentPhysicalDisplayPolicy.hasExactDifferentDisplayZeroForeground(
                    pkg, activities)) {
                Log.w(TAG, "refusing force-stop without unambiguous display-0 safety for " + pkg);
                return false;
            }
            return forceStopAndLaunch(pkg, activity, displayId);
        } catch (Throwable t) {
            Log.e(TAG, "launch failed", t);
            return false;
        }
    }

    private String commandOutput(String[] command, int maxChars) {
        EvogentProcessRunner.Result result =
                EvogentProcessRunner.run(command, maxChars, DUMPSYS_TIMEOUT_MS);
        if (!result.succeeded()) {
            Log.w(TAG, "bounded command failed"
                    + (result.timedOut() ? " (timeout)" : ""));
            return null;
        }
        return result.output();
    }

    private boolean forceStopAndLaunch(String pkg, String activity, int displayId) {
        EvogentProcessRunner.Result stop = EvogentProcessRunner.run(
                new String[]{"am", "force-stop", pkg},
                COMMAND_OUTPUT_MAX_CHARS,
                PACKAGE_COMMAND_TIMEOUT_MS);
        if (!stop.succeeded()) {
            Log.e(TAG, "force-stop failed for " + pkg
                    + (stop.timedOut() ? " (timeout)" : ""));
            return false;
        }

        String act = (activity != null && !activity.isEmpty())
                ? pkg + "/" + activity : resolveLauncher(pkg);
        String[] command = act != null
                ? new String[]{"am", "start", "--display", String.valueOf(displayId), "-n", act}
                : new String[]{"am", "start", "--display", String.valueOf(displayId),
                        "-a", "android.intent.action.MAIN",
                        "-c", "android.intent.category.LAUNCHER", "-p", pkg};
        EvogentProcessRunner.Result start = EvogentProcessRunner.run(
                command, COMMAND_OUTPUT_MAX_CHARS, ACTIVITY_START_TIMEOUT_MS);
        Log.i(TAG, "launch " + pkg + " (" + act + ") on display " + displayId
                + " ok=" + start.succeeded());
        return start.succeeded();
    }

    /** Resolve a package's launcher "pkg/activity" so callers needn't know the activity name. */
    private String resolveLauncher(String pkg) {
        EvogentProcessRunner.Result result = EvogentProcessRunner.run(
                new String[]{"cmd", "package", "resolve-activity", "--brief",
                        "-c", "android.intent.category.LAUNCHER", pkg},
                COMMAND_OUTPUT_MAX_CHARS,
                PACKAGE_COMMAND_TIMEOUT_MS);
        if (!result.succeeded()) return null;
        String last = null;
        for (String line : result.output().split("\\r?\\n")) {
            if (line.contains("/")) last = line.trim();
        }
        return last;
    }

    @Override
    public void releaseDisplay() {
        // Tear down the hidden display but keep the shell-uid service alive for reuse
        // (avoids virtual displays accumulating until reboot; next cycle re-creates one).
        try {
            if (virtualDisplay != null) { virtualDisplay.release(); virtualDisplay = null; }
            if (reader != null) { reader.close(); reader = null; }
            Log.i(TAG, "releaseDisplay done");
        } catch (Throwable ignored) {}
    }

    @Override
    public void destroy() {
        try {
            if (virtualDisplay != null) { virtualDisplay.release(); virtualDisplay = null; }
            if (reader != null) { reader.close(); reader = null; }
            Log.i(TAG, "destroy done");
        } catch (Throwable ignored) {}
        // Shizuku expects the process to exit on destroy for non-daemon services.
        System.exit(0);
    }
}

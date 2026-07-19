package net.dangish.evogent;

import android.content.Context;
import android.graphics.PixelFormat;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import android.os.Handler;
import android.os.HandlerThread;
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
    private HandlerThread readerThread;

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
            if (readerThread != null) { try { readerThread.quitSafely(); } catch (Throwable ignored) {} readerThread = null; }
            reader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 3);
            // Drain the surface. Handing the display an ImageReader surface that nobody consumes
            // works on userdebug builds but NOT on a stock user build (e.g. the Pixel 10 Pro):
            // once the buffer queue fills, the compositor treats the display as having no active
            // consumer and WindowManager parks every activity on it as visibleRequested=false, so
            // the app is placed on the display but never draws (blank screencap + null a11y root).
            // Acquiring and immediately closing each frame keeps the queue flowing, so the display
            // stays a live output and its activities resume and render. This is what lets the
            // on-device browse read/screenshot the hidden display on a non-flashed phone.
            readerThread = new HandlerThread("evo-reader");
            readerThread.start();
            reader.setOnImageAvailableListener(new ImageReader.OnImageAvailableListener() {
                @Override public void onImageAvailable(ImageReader r) {
                    Image img = null;
                    try { img = r.acquireLatestImage(); }
                    catch (Throwable ignored) {}
                    finally { if (img != null) { try { img.close(); } catch (Throwable ignored) {} } }
                }
            }, new Handler(readerThread.getLooper()));
            // NB: FLAG_PRESENTATION is deliberately OMITTED. A "presentation" display is for the
            // Presentation API (a secondary screen showing supplementary content) and the window
            // manager will not host a normal activity task stack on it — on a stock user build
            // (Pixel 10 Pro) that left createVirtualDisplay's display with canHostTasks=false, so
            // launched apps were parked (visibleRequested=false) and never drew: blank screencap,
            // null a11y root. Dropping PRESENTATION (scrcpy's --new-display does the same) lets the
            // trusted display host and resume the app. FLAG_TRUSTED + SYSTEM_DECORATIONS +
            // OWN_DISPLAY_GROUP + ALWAYS_UNLOCKED remain the load-bearing set.
            int flags = FLAG_PUBLIC | FLAG_OWN_CONTENT_ONLY
                      | FLAG_ROTATES_WITH_CONTENT | FLAG_DESTROY_CONTENT_ON_REMOVAL
                      | FLAG_SHOULD_SHOW_SYSTEM_DECORATIONS | FLAG_TRUSTED
                      | FLAG_OWN_DISPLAY_GROUP | FLAG_ALWAYS_UNLOCKED
                      | FLAG_TOUCH_FEEDBACK_DISABLED | FLAG_OWN_FOCUS;
            virtualDisplay = dm.createVirtualDisplay("evo-hidden", width, height, dpi,
                    reader.getSurface(), flags);
            int id = virtualDisplay.getDisplay().getDisplayId();
            // Explicitly tell WindowManager this display hosts the system decor / task stack.
            // The FLAG_SHOULD_SHOW_SYSTEM_DECORATIONS creation flag is NOT honored for a
            // shell-created virtual display on a stock user build (Pixel 10 Pro: canHostTasks
            // stayed false, launched apps parked and never drew). The explicit @hide WM call —
            // the same one scrcpy uses for --new-display — is what actually flips task hosting.
            // We run as uid 2000 (shell), which holds the permission on a normal build.
            enableSystemDecorations(id);
            Log.i(TAG, "createDisplay id=" + id + " (uid=" + android.os.Process.myUid() + ")");
            return id;
        } catch (Throwable t) {
            Log.e(TAG, "createDisplay failed", t);
            return -1;
        }
    }

    /** Flip the display to a task-hosting, system-decor display via the @hide IWindowManager
     *  API (reflection — the method is not in the SDK). Best-effort: logs and continues if a
     *  particular call is unavailable on this build. */
    private void enableSystemDecorations(int displayId) {
        try {
            android.os.IBinder b = (android.os.IBinder) Class.forName("android.os.ServiceManager")
                    .getMethod("getService", String.class).invoke(null, "window");
            Object wm = Class.forName("android.view.IWindowManager$Stub")
                    .getMethod("asInterface", android.os.IBinder.class).invoke(null, b);
            try {
                wm.getClass().getMethod("setShouldShowSystemDecors", int.class, boolean.class)
                        .invoke(wm, displayId, true);
                Log.i(TAG, "setShouldShowSystemDecors(" + displayId + ", true) ok");
            } catch (Throwable t) { Log.w(TAG, "setShouldShowSystemDecors failed", t); }
            try {
                // 0 = SHOW_IME_WITH_HARD_KEYBOARD-style local policy; keeps IME on this display.
                wm.getClass().getMethod("setDisplayImePolicy", int.class, int.class)
                        .invoke(wm, displayId, 0);
            } catch (Throwable ignored) {}
        } catch (Throwable t) {
            Log.w(TAG, "enableSystemDecorations failed", t);
        }
    }

    @Override
    public boolean launch(String pkg, String activity, int displayId) {
        try {
            // singleTask/singleInstance apps (Gmail, YouTube, Twitter) would otherwise be
            // absorbed by an existing foreground instance instead of moving to the hidden
            // display, so force-stop first for a clean launch on the target display. Safe for
            // background browsing (runs when the app isn't in active foreground use).
            try { Runtime.getRuntime().exec(new String[]{"am", "force-stop", pkg}).waitFor(); }
            catch (Throwable ignored) {}
            String act = (activity != null && !activity.isEmpty())
                    ? pkg + "/" + activity : resolveLauncher(pkg);
            String[] cmd = act != null
                    ? new String[]{"am", "start", "--display", String.valueOf(displayId), "-n", act}
                    : new String[]{"am", "start", "--display", String.valueOf(displayId),
                            "-a", "android.intent.action.MAIN",
                            "-c", "android.intent.category.LAUNCHER", "-p", pkg};
            Process p = Runtime.getRuntime().exec(cmd);
            int rc = p.waitFor();
            Log.i(TAG, "launch " + pkg + " (" + act + ") on display " + displayId + " rc=" + rc);
            return rc == 0;
        } catch (Throwable t) {
            Log.e(TAG, "launch failed", t);
            return false;
        }
    }

    /** Resolve a package's launcher "pkg/activity" so callers needn't know the activity name. */
    private String resolveLauncher(String pkg) {
        try {
            Process p = Runtime.getRuntime().exec(new String[]{"cmd", "package",
                    "resolve-activity", "--brief", "-c", "android.intent.category.LAUNCHER", pkg});
            java.io.BufferedReader r = new java.io.BufferedReader(
                    new java.io.InputStreamReader(p.getInputStream()));
            String line, last = null;
            while ((line = r.readLine()) != null) if (line.contains("/")) last = line.trim();
            p.waitFor();
            return last;
        } catch (Throwable t) { return null; }
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

package net.dangish.evogent;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.IBinder;
import android.os.SystemClock;
import android.util.Log;

/**
 * The whole background browse loop, on-device. No host, no adb: this service
 * (a) asks Shizuku to create a hidden trusted display and launch the real,
 * logged-in YouTube app onto it, then (b) drives it entirely through the
 * on-device accessibility service — scroll (dispatchGesture), and the
 * Action-menu -> Share -> More -> Evogent flow that hands a real watch URL to
 * ShareReceiver, which posts it to the feed. Reschedules itself so it runs on
 * an interval; BootReceiver kicks the first run after a reboot.
 */
public class BrowseService extends Service {
    private static final String TAG = "EvoBrowse";
    private static final String YT_PKG = "com.google.android.youtube";
    private static final String YT_ACT = "com.google.android.apps.youtube.app.WatchWhileActivity";
    private static final long DEFAULT_INTERVAL_MS = 30 * 60 * 1000L; // 30 min

    @Override public IBinder onBind(Intent intent) { return null; }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        final int count = intent != null ? intent.getIntExtra("count", 5) : 5;
        final long interval = intent != null
                ? intent.getLongExtra("intervalMs", DEFAULT_INTERVAL_MS) : DEFAULT_INTERVAL_MS;
        final boolean reschedule = intent == null || intent.getBooleanExtra("reschedule", true);
        // App + share-flow are config, not hardcoded (instructions-over-code): a chat agent or
        // config can point the autonomous loop at any share-based app by passing pkg/activity and
        // the ordered tap-labels that reach Evogent's share target.
        final String pkg = intent != null && intent.getStringExtra("pkg") != null
                ? intent.getStringExtra("pkg") : YT_PKG;
        final String activity = intent != null && intent.getStringExtra("activity") != null
                ? intent.getStringExtra("activity") : (pkg.equals(YT_PKG) ? YT_ACT : null);
        final String labelsCsv = intent != null && intent.getStringExtra("shareLabels") != null
                ? intent.getStringExtra("shareLabels") : "Action menu,Share,More,Evogent";
        final String[] labels = labelsCsv.split("\\s*,\\s*");
        Log.i(TAG, "browse cycle start pkg=" + pkg + " count=" + count + " reschedule=" + reschedule);

        final ShizukuController shizuku = new ShizukuController(this);
        if (!shizuku.shizukuAlive()) {
            Log.e(TAG, "Shizuku not available; cannot create hidden display");
            if (reschedule) scheduleNext(this, interval, count);
            stopSelf();
            return START_NOT_STICKY;
        }
        shizuku.createHiddenAndLaunch(pkg, activity, new ShizukuController.OnDisplay() {
            @Override public void ready(int displayId) {
                if (displayId <= 0) { Log.e(TAG, "no hidden display"); stopSelf(); return; }
                new Thread(new Runnable() {
                    @Override public void run() {
                        try { runLoop(displayId, count, labels); }
                        catch (Throwable t) { Log.e(TAG, "loop error", t); }
                        finally {
                            shizuku.releaseDisplay(); // tear down so displays don't accumulate
                            if (reschedule) scheduleNext(BrowseService.this, interval, count);
                            stopSelf();
                        }
                    }
                }).start();
            }
        });
        return START_NOT_STICKY;
    }

    private void runLoop(int displayId, int count, String[] shareLabels) throws InterruptedException {
        Thread.sleep(8000); // let the app render its feed on the hidden display
        for (int n = 0; n < count; n++) {
            Log.i(TAG, "browse item " + (n + 1) + "/" + count + " on display " + displayId);
            // Scroll a few items into view (a11y gesture on the hidden display).
            for (int s = 0; s < 3; s++) { gesture(displayId); Thread.sleep(1200); }
            // Walk the share flow to Evogent, all via on-device accessibility node clicks.
            for (String label : shareLabels) { click(displayId, label); Thread.sleep(2800); }
        }
        Log.i(TAG, "browse cycle done");
    }

    // ---- drive the on-device accessibility service in-process (no adb) --------

    private String token;

    private String controlToken() {
        if (token != null) return token;
        try {
            java.io.File f = new java.io.File(getExternalFilesDir(null), "control-token.txt");
            if (f.exists()) {
                java.io.BufferedReader r = new java.io.BufferedReader(new java.io.FileReader(f));
                token = r.readLine();
                r.close();
                if (token != null) token = token.trim();
            }
        } catch (Throwable ignored) {}
        return token;
    }

    private void a11y(Intent i) {
        i.setAction("net.dangish.evogent.A11Y");
        i.setPackage(getPackageName());
        if (controlToken() != null) i.putExtra("token", controlToken());
        sendBroadcast(i);
    }

    private void click(int displayId, String text) {
        Intent i = new Intent();
        i.putExtra("op", "clicktext");
        i.putExtra("display", displayId);
        i.putExtra("text", text);
        a11y(i);
    }

    private void gesture(int displayId) {
        Intent i = new Intent();
        i.putExtra("op", "gesture");
        i.putExtra("display", displayId);
        i.putExtra("y1", 1800);
        i.putExtra("y2", 500);
        i.putExtra("ms", 250);
        a11y(i);
    }

    // ---- scheduling -----------------------------------------------------------

    static void scheduleNext(Context ctx, long delayMs, int count) {
        try {
            AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
            Intent i = new Intent(ctx, BrowseAlarmReceiver.class);
            i.putExtra("count", count);
            PendingIntent pi = PendingIntent.getBroadcast(ctx, 0, i,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            long at = SystemClock.elapsedRealtime() + delayMs;
            am.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, at, pi);
            Log.i(TAG, "next browse cycle scheduled in " + (delayMs / 1000) + "s");
        } catch (Throwable t) { Log.e(TAG, "scheduleNext failed", t); }
    }
}

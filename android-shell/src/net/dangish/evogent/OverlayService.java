package net.dangish.evogent;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;

/**
 * Owns the anywhere-composer overlay. It lives in a FOREGROUND SERVICE (not the accessibility
 * service) because on Android 16 an AccessibilityService cannot obtain a drawable
 * application-overlay surface — the window attaches but SurfaceFlinger never composites it. A
 * foreground service with SYSTEM_ALERT_WINDOW is the standard "chat head" host and DOES get a
 * real overlay surface. The accessibility service drives it (foreground-app changes, screen
 * context reads) via OverlayService.overlay().
 */
public class OverlayService extends Service {
    private static final String TAG = "EvogentOverlaySvc";
    private static final String CHANNEL = "evogent_overlay";

    private static OverlayService self;
    private OverlayComposer composer;

    /** The live overlay, or null if the service isn't running yet. */
    static OverlayComposer overlay() {
        return self != null ? self.composer : null;
    }

    @Override public void onCreate() {
        super.onCreate();
        self = this;
        startInForeground();
        try {
            composer = new OverlayComposer(this);
            // Seed the initial foreground-app state from the a11y service so the bubble shows
            // immediately if we're already over another app.
            EvogentAccessibilityService a = EvogentAccessibilityService.instance;
            if (a != null) composer.onForegroundPackage(a.captureForegroundContext(0)[0]);
        } catch (Throwable t) {
            Log.e(TAG, "overlay init failed", t);
        }
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        return START_STICKY;
    }

    private void startInForeground() {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26 && nm != null && nm.getNotificationChannel(CHANNEL) == null) {
            NotificationChannel ch = new NotificationChannel(
                    CHANNEL, "Evogent overlay", NotificationManager.IMPORTANCE_MIN);
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        }
        Notification n = new Notification.Builder(this, CHANNEL)
                .setSmallIcon(android.R.drawable.ic_menu_edit)
                .setContentTitle("Evogent")
                .setContentText("Tap the bubble to message Evogent from any app")
                .setOngoing(true)
                .build();
        try {
            if (Build.VERSION.SDK_INT >= 34) {
                startForeground(42, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
            } else {
                startForeground(42, n);
            }
        } catch (Throwable t) {
            Log.e(TAG, "startForeground failed", t);
        }
    }

    @Override public IBinder onBind(Intent intent) { return null; }

    @Override public void onDestroy() {
        if (composer != null) { composer.destroy(); composer = null; }
        if (self == this) self = null;
        super.onDestroy();
    }
}

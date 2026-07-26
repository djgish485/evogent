package net.dangish.evogent;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

/**
 * Inert migration receiver for alarms created by legacy APK versions.
 *
 * Autonomous scheduling now belongs exclusively to the Termux runtime. Keep this component for
 * one migration horizon so an already-persisted PendingIntent has a safe destination that cancels
 * itself instead of launching the removed BrowseService.
 */
public final class BrowseAlarmReceiver extends BroadcastReceiver {
    static void cancelLegacySchedule(Context ctx) {
        try {
            Intent legacyIntent = new Intent(ctx, BrowseAlarmReceiver.class);
            PendingIntent legacy = PendingIntent.getBroadcast(
                    ctx,
                    0,
                    legacyIntent,
                    PendingIntent.FLAG_NO_CREATE | PendingIntent.FLAG_IMMUTABLE);
            if (legacy == null) return;
            AlarmManager alarms = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
            if (alarms != null) alarms.cancel(legacy);
            legacy.cancel();
            Log.i("EvoBrowse", "legacy APK browse alarm canceled");
        } catch (Throwable t) {
            Log.e("EvoBrowse", "failed to cancel legacy APK browse alarm", t);
        }
    }

    @Override public void onReceive(Context ctx, Intent intent) {
        Log.i("EvoBrowse", "ignored legacy APK browse alarm");
        cancelLegacySchedule(ctx);
    }
}

package net.dangish.evogent;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

/** After a reboot, schedule the first background browse cycle. */
public class BootReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context ctx, Intent intent) {
        if (intent == null || intent.getAction() == null) return;
        if (Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())
                || Intent.ACTION_LOCKED_BOOT_COMPLETED.equals(intent.getAction())) {
            Log.i("EvoBrowse", "boot -> scheduling first browse cycle");
            BrowseService.scheduleNext(ctx, 60 * 1000L, 5); // first run 1 min after boot
        }
    }
}

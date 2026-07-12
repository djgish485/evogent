package net.dangish.evogent;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.util.Log;

/**
 * On boot, bring the whole on-device stack up WITHOUT any Mac or Termux:Boot addon:
 *  1. Schedule the first background browse cycle (the APK's own alarm).
 *  2. Fire a Termux RUN_COMMAND intent to run ~/phone-tools/evogent-boot.sh, which starts the
 *     Evogent server + the periodic scheduler and re-applies the keep-alive settings.
 *
 * Termux runs external RUN_COMMAND intents because its config sets allow-external-apps=true;
 * we hold com.termux.permission.RUN_COMMAND. evogent-boot.sh is idempotent, so if the user
 * also has the Termux:Boot addon installed (belt-and-suspenders), running it twice is harmless.
 */
public class BootReceiver extends BroadcastReceiver {
    private static final String TAG = "EvoBoot";

    @Override public void onReceive(Context ctx, Intent intent) {
        if (intent == null || intent.getAction() == null) return;
        if (!Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())
                && !Intent.ACTION_LOCKED_BOOT_COMPLETED.equals(intent.getAction())) {
            return;
        }
        Log.i(TAG, "boot -> scheduling browse + starting on-device stack");
        BrowseService.scheduleNext(ctx, 60 * 1000L, 5); // first browse ~1 min after boot

        try {
            Intent run = new Intent();
            run.setClassName("com.termux", "com.termux.app.RunCommandService");
            run.setAction("com.termux.RUN_COMMAND");
            run.putExtra("com.termux.RUN_COMMAND_PATH",
                    "/data/data/com.termux/files/usr/bin/bash");
            run.putExtra("com.termux.RUN_COMMAND_ARGUMENTS", new String[] {
                    "/data/data/com.termux/files/home/phone-tools/evogent-boot.sh" });
            run.putExtra("com.termux.RUN_COMMAND_BACKGROUND", true);
            run.putExtra("com.termux.RUN_COMMAND_SESSION_ACTION", "0");
            run.setData(Uri.parse("evogent-boot"));
            // After a reboot Termux is in the "stopped" state (nothing has launched it yet);
            // an intent won't reach a stopped package without this flag — the whole boot chain
            // silently fails without it. This is what makes RUN_COMMAND work FROM boot.
            run.addFlags(Intent.FLAG_INCLUDE_STOPPED_PACKAGES);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                ctx.startForegroundService(run);
            } else {
                ctx.startService(run);
            }
            Log.i(TAG, "dispatched RUN_COMMAND -> evogent-boot.sh");
        } catch (Throwable t) {
            // Termux may not be installed / may reject the intent; the browse alarm still fires
            // and the Termux:Boot addon path (if present) covers startup.
            Log.e(TAG, "RUN_COMMAND dispatch failed; relying on Termux:Boot if installed", t);
        }
    }
}

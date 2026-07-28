package net.dangish.evogent;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.util.Log;

/**
 * On boot, bring the whole on-device stack up WITHOUT any Mac or Termux:Boot addon:
 *  1. Cancel any legacy APK browse alarm left by a pre-phone-runtime build.
 *  2. Fire a Termux RUN_COMMAND intent to run ~/phone-tools/evogent-boot.sh, which starts the
 *     Evogent server + the periodic scheduler and re-applies the keep-alive settings.
 *
 * Termux runs external RUN_COMMAND intents because its config sets allow-external-apps=true;
 * we hold com.termux.permission.RUN_COMMAND. evogent-boot.sh is idempotent, so if the user
 * also has the Termux:Boot addon installed (belt-and-suspenders), running it twice is harmless.
 */
public class BootReceiver extends BroadcastReceiver {
    private static final String TAG = "EvoBoot";
    private static final String RECOVERY_PREFIX =
            "ROOT=\"$HOME/.local/share/evogent\"; "
            + "J=\"$ROOT/install-transaction/journal.json\"; "
            + "R=\"$ROOT/install-transaction/install-release.sh\"; ";
    private static final String RECOVER_IF_PENDING =
            "if [ -e \"$J\" ] || [ -L \"$J\" ]; then "
            + "  [ -f \"$J\" ] && [ ! -L \"$J\" ] "
            + "    && [ -f \"$R\" ] && [ ! -L \"$R\" ] "
            + "    || exit 70; "
            + "  exec bash \"$R\" --recover \"$J\"; "
            + "fi; ";
    private static final String BOOT_COMMAND =
            RECOVERY_PREFIX + RECOVER_IF_PENDING
            + "exec bash \"$HOME/phone-tools/evogent-boot.sh\"";
    private static final String RECOVERY_ONLY_COMMAND =
            RECOVERY_PREFIX + RECOVER_IF_PENDING + "exit 0";

    @Override public void onReceive(Context ctx, Intent intent) {
        if (intent == null || intent.getAction() == null) return;
        if (Intent.ACTION_MY_PACKAGE_REPLACED.equals(intent.getAction())) {
            BrowseAlarmReceiver.cancelLegacySchedule(ctx);
            Log.i(TAG, "package updated -> canceled legacy alarm + requested recovery only");
            dispatchRunCommand(ctx, RECOVERY_ONLY_COMMAND, "package-recovery");
            return;
        }
        if (!Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) {
            return;
        }
        BrowseAlarmReceiver.cancelLegacySchedule(ctx);
        Log.i(TAG, "boot -> canceled legacy APK browse alarm + starting on-device stack");
        dispatchRunCommand(ctx, BOOT_COMMAND, "boot");
    }

    static boolean dispatchRecoveryOrBoot(Context ctx) {
        return dispatchRunCommand(ctx, BOOT_COMMAND, "foreground-retry");
    }

    private static boolean dispatchRunCommand(
            Context ctx, String command, String reason) {
        try {
            Intent run = new Intent();
            run.setClassName("com.termux", "com.termux.app.RunCommandService");
            run.setAction("com.termux.RUN_COMMAND");
            run.putExtra("com.termux.RUN_COMMAND_PATH",
                    "/data/data/com.termux/files/usr/bin/bash");
            run.putExtra("com.termux.RUN_COMMAND_ARGUMENTS", new String[] {
                    "-c", command });
            run.putExtra("com.termux.RUN_COMMAND_BACKGROUND", true);
            run.putExtra("com.termux.RUN_COMMAND_SESSION_ACTION", "0");
            run.setData(Uri.parse("evogent-" + reason));
            // After a reboot Termux is in the "stopped" state (nothing has launched it yet);
            // an intent won't reach a stopped package without this flag — the whole boot chain
            // silently fails without it. This is what makes RUN_COMMAND work FROM boot.
            run.addFlags(Intent.FLAG_INCLUDE_STOPPED_PACKAGES);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                ctx.startForegroundService(run);
            } else {
                ctx.startService(run);
            }
            Log.i(TAG, "dispatched RUN_COMMAND: " + reason);
            return true;
        } catch (Throwable t) {
            // Termux may not be installed / may reject the intent; the Termux:Boot addon path
            // (if present) still covers startup.
            Log.e(TAG, "RUN_COMMAND dispatch failed for " + reason, t);
            return false;
        }
    }
}

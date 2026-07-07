package net.dangish.evogent;

import android.content.ComponentName;
import android.content.Context;
import android.content.ServiceConnection;
import android.content.pm.PackageManager;
import android.os.IBinder;
import android.util.Log;

import rikka.shizuku.Shizuku;

/**
 * Evogent-side (uid 10xxx) bridge to the shell-uid privileged ops via Shizuku.
 * Binds the {@link EvoPrivilegedService} UserService, handles the one-time
 * permission grant, and exposes createHiddenAndLaunch() — the only two things
 * Evogent can't do itself. Cable-free: this is the ADB the loop used, minus ADB.
 */
public class ShizukuController {
    private static final String TAG = "EvoShizuku";
    private static final int PERM_REQ = 4201;

    public interface OnDisplay { void ready(int displayId); }

    private final Context app;
    private final Shizuku.UserServiceArgs args;
    private IEvoPrivileged svc;
    private Runnable pending;

    public ShizukuController(Context ctx) {
        app = ctx.getApplicationContext();
        args = new Shizuku.UserServiceArgs(
                new ComponentName(app.getPackageName(), EvoPrivilegedService.class.getName()))
                .daemon(false)
                .processNameSuffix("evopriv")
                .debuggable(false)
                .version(1);
    }

    private final ServiceConnection conn = new ServiceConnection() {
        @Override public void onServiceConnected(ComponentName name, IBinder binder) {
            svc = IEvoPrivileged.Stub.asInterface(binder);
            Log.i(TAG, "UserService connected: " + (binder != null && binder.pingBinder()));
            Runnable r = pending; pending = null;
            if (r != null) r.run();
        }
        @Override public void onServiceDisconnected(ComponentName name) {
            svc = null; Log.i(TAG, "UserService disconnected");
        }
    };

    private final Shizuku.OnRequestPermissionResultListener permListener =
            new Shizuku.OnRequestPermissionResultListener() {
        @Override public void onRequestPermissionResult(int requestCode, int grantResult) {
            if (requestCode != PERM_REQ) return;
            Shizuku.removeRequestPermissionResultListener(this);
            if (grantResult == PackageManager.PERMISSION_GRANTED) {
                Log.i(TAG, "Shizuku permission granted");
                Runnable r = pending; pending = null; bindAndRun(r);
            } else {
                Log.e(TAG, "Shizuku permission denied");
            }
        }
    };

    /** Ensure Shizuku is up + permitted, bind the UserService, then run onReady. */
    private void ensure(Runnable onReady) {
        if (!Shizuku.pingBinder()) { Log.e(TAG, "Shizuku binder not available"); return; }
        if (svc != null) { onReady.run(); return; }
        if (Shizuku.checkSelfPermission() == PackageManager.PERMISSION_GRANTED) {
            bindAndRun(onReady);
        } else {
            pending = onReady;
            Shizuku.addRequestPermissionResultListener(permListener);
            Shizuku.requestPermission(PERM_REQ);
            Log.i(TAG, "requested Shizuku permission");
        }
    }

    private void bindAndRun(Runnable onReady) {
        pending = onReady;
        try {
            Shizuku.bindUserService(args, conn);
            Log.i(TAG, "bindUserService called");
        } catch (Throwable t) { Log.e(TAG, "bindUserService failed", t); }
    }

    /** Create a trusted hidden display and launch pkg/activity onto it (shell uid, via Shizuku). */
    public void createHiddenAndLaunch(final String pkg, final String activity, final OnDisplay cb) {
        ensure(new Runnable() {
            @Override public void run() {
                try {
                    int id = svc.createDisplay(1080, 2400, 420);
                    Log.i(TAG, "createDisplay -> " + id);
                    if (id > 0) {
                        boolean ok = svc.launch(pkg, activity, id);
                        Log.i(TAG, "launch ok=" + ok);
                    }
                    cb.ready(id);
                } catch (Throwable t) {
                    Log.e(TAG, "createHiddenAndLaunch failed", t);
                    cb.ready(-1);
                }
            }
        });
    }

    /** Tear down the current hidden display (keep the shell service for reuse). */
    public void releaseDisplay() {
        try { if (svc != null) svc.releaseDisplay(); }
        catch (Throwable t) { Log.e(TAG, "releaseDisplay failed", t); }
    }

    public boolean shizukuAlive() { return Shizuku.pingBinder(); }
}

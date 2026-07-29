package net.dangish.evogent;

import android.content.ComponentName;
import android.content.Context;
import android.content.ServiceConnection;
import android.content.pm.PackageManager;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;

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
    private static final long PENDING_READY_TIMEOUT_MS = 8000L;

    public interface OnDisplay { void ready(int displayId); }

    private static final class PendingRequest {
        final long generation;
        final Runnable ready;
        final Runnable failure;

        PendingRequest(long generation, Runnable ready, Runnable failure) {
            this.generation = generation;
            this.ready = ready;
            this.failure = failure;
        }
    }

    private final Context app;
    private final Shizuku.UserServiceArgs args;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService launchWorker = Executors.newSingleThreadExecutor();
    private volatile IEvoPrivileged svc;
    private volatile boolean closed;
    private long nextPendingGeneration;
    private PendingRequest pending;

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
            PendingRequest request = takePending();
            if (request != null) request.ready.run();
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
                PendingRequest request = takePending();
                if (request != null) bindAndRun(request.ready, request.failure);
            } else {
                Log.e(TAG, "Shizuku permission denied");
                PendingRequest request = takePending();
                if (request != null) request.failure.run();
            }
        }
    };

    /** Ensure Shizuku is up + permitted, bind the UserService, then run onReady. */
    private void ensure(Runnable onReady, Runnable onFailure) {
        if (closed) {
            onFailure.run();
            return;
        }
        if (!Shizuku.pingBinder()) {
            Log.e(TAG, "Shizuku binder not available");
            onFailure.run();
            return;
        }
        if (svc != null) { onReady.run(); return; }
        if (Shizuku.checkSelfPermission() == PackageManager.PERMISSION_GRANTED) {
            bindAndRun(onReady, onFailure);
        } else {
            PendingRequest request = installPending(onReady, onFailure);
            try {
                Shizuku.addRequestPermissionResultListener(permListener);
                Shizuku.requestPermission(PERM_REQ);
                Log.i(TAG, "requested Shizuku permission");
            } catch (Throwable error) {
                if (clearPending(request)) request.failure.run();
                Log.e(TAG, "requestPermission failed", error);
            }
        }
    }

    private void bindAndRun(Runnable onReady, Runnable onFailure) {
        if (onReady == null || onFailure == null) return;
        PendingRequest request = installPending(onReady, onFailure);
        try {
            Shizuku.bindUserService(args, conn);
            Log.i(TAG, "bindUserService called");
        } catch (Throwable error) {
            boolean current = clearPending(request);
            Log.e(TAG, "bindUserService failed", error);
            if (current) request.failure.run();
        }
    }

    private PendingRequest installPending(Runnable ready, Runnable failure) {
        final PendingRequest request;
        PendingRequest superseded;
        synchronized (this) {
            superseded = pending;
            request = new PendingRequest(++nextPendingGeneration, ready, failure);
            pending = request;
        }
        if (superseded != null) superseded.failure.run();
        main.postDelayed(new Runnable() {
            @Override public void run() {
                if (!clearPending(request)) return;
                try { Shizuku.removeRequestPermissionResultListener(permListener); }
                catch (Throwable ignored) {}
                Log.e(TAG, "Shizuku readiness timed out generation=" + request.generation);
                request.failure.run();
            }
        }, PENDING_READY_TIMEOUT_MS);
        return request;
    }

    private synchronized PendingRequest takePending() {
        PendingRequest request = pending;
        pending = null;
        return request;
    }

    private synchronized boolean clearPending(PendingRequest request) {
        if (pending != request) return false;
        pending = null;
        return true;
    }

    /** Create a trusted hidden display and launch pkg/activity onto it (shell uid, via Shizuku). */
    public void createHiddenAndLaunch(final String pkg, final String activity, final OnDisplay cb) {
        ensure(
                new Runnable() {
                    @Override public void run() {
                        submitLaunch(pkg, activity, cb);
                    }
                },
                new Runnable() {
                    @Override public void run() {
                        deliverResult(cb, -1);
                    }
                });
    }

    private void submitLaunch(
            final String pkg, final String activity, final OnDisplay callback) {
        try {
            launchWorker.execute(new Runnable() {
                @Override public void run() {
                    int result = -1;
                    try {
                        IEvoPrivileged service = svc;
                        if (service == null) throw new IllegalStateException("service disconnected");
                        int id = service.createDisplay(1080, 2400, 420);
                        Log.i(TAG, "createDisplay -> " + id);
                        if (id > 0) {
                            boolean ok = service.launch(pkg, activity, id);
                            Log.i(TAG, "launch ok=" + ok);
                            if (!ok) {
                                try { service.releaseDisplay(); } catch (Throwable ignored) {}
                            } else {
                                result = id;
                            }
                        }
                    } catch (Throwable error) {
                        Log.e(TAG, "createHiddenAndLaunch failed", error);
                    }
                    deliverResult(callback, result);
                }
            });
        } catch (RejectedExecutionException error) {
            deliverResult(callback, -1);
        }
    }

    private void deliverResult(final OnDisplay callback, final int displayId) {
        main.post(new Runnable() {
            @Override public void run() {
                if (!closed) callback.ready(displayId);
            }
        });
    }

    /** Tear down the current hidden display (keep the shell service for reuse). */
    public void releaseDisplay() {
        try {
            launchWorker.execute(new Runnable() {
                @Override public void run() {
                    try {
                        IEvoPrivileged service = svc;
                        if (service != null) service.releaseDisplay();
                    } catch (Throwable error) {
                        Log.e(TAG, "releaseDisplay failed", error);
                    }
                }
            });
        } catch (RejectedExecutionException ignored) {}
    }

    public boolean shizukuAlive() { return Shizuku.pingBinder(); }

    public void shutdown() {
        closed = true;
        takePending();
        try { Shizuku.removeRequestPermissionResultListener(permListener); }
        catch (Throwable ignored) {}
        launchWorker.shutdownNow();
        main.removeCallbacksAndMessages(null);
    }
}

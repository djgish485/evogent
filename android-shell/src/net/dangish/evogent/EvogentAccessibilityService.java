package net.dangish.evogent;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.graphics.Bitmap;
import android.graphics.PixelFormat;
import android.graphics.Path;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.ImageReader;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.Display;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;

import java.io.File;
import java.io.FileOutputStream;
import java.util.List;

/**
 * On-device agent primitives for Phase 1. Proves that with ONLY the user's
 * one-time "enable accessibility" toggle — no root, no ADB, no scrcpy — this
 * service can, against ANY other app:
 *   - read the semantic node tree           (op=nodes  / op=windows)
 *   - inject taps and swipes                 (op=tap    / op=swipe)
 *   - capture real pixels of a display       (op=shot)  via takeScreenshot()
 *
 * The broadcast trigger below stands in for the Evogent agent brain calling
 * these in-process; the broadcast itself is only how the demo pokes it. Every
 * capability runs at app privilege, gated solely by the accessibility grant.
 */
public class EvogentAccessibilityService extends AccessibilityService {
    private static final String TAG = "EvogentA11y";
    private static final String ACTION = "net.dangish.evogent.A11Y";
    private static final String REPLY_MAGIC = "EVOGENT_A11Y_V1";
    private static final int MIN_REPLY_PORT = 1024;
    private static final int MAX_REPLY_PORT = 65535;
    private final Handler main = new Handler(Looper.getMainLooper());

    private String controlToken;

    private final BroadcastReceiver cmd = new BroadcastReceiver() {
        @Override public void onReceive(Context ctx, Intent i) {
            String op = i.getStringExtra("op");
            if (op == null) return;
            // The receiver is exported so adb (the chat agent) and in-process callers can reach
            // it, which also means any installed app could. Gate every op on a per-install secret
            // stored in Evogent's scoped external dir (unreadable by other apps under scoped
            // storage and copied to Termux during provisioning). Fail closed when token
            // initialization failed: no valid stored token means no drive/read of other apps.
            if (!EvogentSecurityPolicy.tokenMatches(
                    controlToken, i.getStringExtra("token"))) {
                Log.w(TAG, "rejected op=" + op + " — bad/absent control token");
                return;
            }
            ReplyTarget reply = validatedReplyTarget(i);
            boolean hasReplyExtra = i.hasExtra("reply_port") || i.hasExtra("reply_nonce");
            if ((hasReplyExtra || operationReturnsData(op)) && reply == null) {
                Log.w(TAG, "rejected op=" + op + " — invalid/missing reply target");
                return;
            }
            Log.i(TAG, "cmd op=" + op);
            switch (op) {
                case "nodes": {
                    // Return a window's node tree straight to the caller via the ordered broadcast
                    // result AND the loopback push, so an on-device agent (Termux/claude, a different
                    // app uid that cannot read our scoped storage or logcat) can read it. With an
                    // explicit `display` extra, dump that display's top app window instead of the
                    // active (display-0) window — the background-browse read path: the user's feed
                    // stays on display 0 while the agent reads an app on a hidden virtual display.
                    int nd = i.getIntExtra("display", Display.DEFAULT_DISPLAY);
                    String nodesResult = (nd == Display.DEFAULT_DISPLAY)
                            ? dumpActiveTree()
                            : dumpTreeOnDisplay(nd);
                    try { if (isOrderedBroadcast()) setResultData(nodesResult); } catch (Throwable ignored) {}
                    sendToLocalAgent(reply, nodesResult);
                    break;
                }
                case "windows": {
                    String windowsResult = dumpAllWindows();
                    try { if (isOrderedBroadcast()) setResultData(windowsResult); } catch (Throwable ignored) {}
                    sendToLocalAgent(reply, windowsResult);
                    break;
                }
                case "swipe":   swipe(i.getIntExtra("x1", 540), i.getIntExtra("y1", 1800),
                                      i.getIntExtra("x2", 540), i.getIntExtra("y2", 600),
                                      i.getIntExtra("ms", 250)); break;
                case "tap":     tap(i.getIntExtra("x", 540), i.getIntExtra("y", 1200)); break;
                case "shot":    shot(i.getIntExtra("display", Display.DEFAULT_DISPLAY),
                                     i.getStringExtra("name")); break;
                case "shotnode": shotNode(i.getIntExtra("display", Display.DEFAULT_DISPLAY),
                                     i.getStringExtra("match"), i.getStringExtra("name")); break;
                case "clip": {
                    // Read the system clipboard directly. Android gates clipboard reads on the
                    // caller having focus, but Evogent's MainActivity is the foreground app on
                    // display 0, so this process is allowed — even while Instagram copied a post
                    // link on a hidden display (there's one system clipboard, not one per display).
                    // Far more robust than pasting into an app field and reading it back.
                    String clip = readClipboard();
                    try { if (isOrderedBroadcast()) setResultData(clip); } catch (Throwable ignored) {}
                    sendToLocalAgent(reply, clip == null ? "" : clip);
                    break;
                }
                case "paste": {
                    // Paste the clipboard into a focused editable field and read it back. This is
                    // how we recover a URL an app only exposes via "Copy link" (e.g. an Instagram
                    // post permalink): background apps can't read the clipboard, but ACTION_PASTE
                    // is performed by the system into an editable node, and the pasted text is then
                    // plain accessibility text. Returns the field text over loopback + result.
                    String pasted = pasteAndRead(i.getIntExtra("display", Display.DEFAULT_DISPLAY));
                    try { if (isOrderedBroadcast()) setResultData(pasted); } catch (Throwable ignored) {}
                    sendToLocalAgent(reply, pasted == null ? "" : pasted);
                    break;
                }
                case "scroll":  scrollOnDisplay(i.getIntExtra("display", Display.DEFAULT_DISPLAY)); break;
                case "clicktext": {
                    String clickResult = clickTextOnDisplay(
                            i.getIntExtra("display", Display.DEFAULT_DISPLAY),
                            i.getStringExtra("text"));
                    try { if (isOrderedBroadcast()) setResultData(clickResult); } catch (Throwable ignored) {}
                    // clicktext remains backwards-compatible for authenticated fire-and-forget
                    // broadcasts. When a reply target is supplied, its result is authoritative.
                    sendToLocalAgent(reply, clickResult);
                    break;
                }
                case "makedisplay": makeDisplay(); break;
                case "deldisplay":  delDisplay(); break;
                case "gesture": gestureOnDisplay(i.getIntExtra("display", Display.DEFAULT_DISPLAY),
                                     i.getIntExtra("x1", 540), i.getIntExtra("y1", 1700),
                                     i.getIntExtra("x2", 540), i.getIntExtra("y2", 500),
                                     i.getIntExtra("ms", 250)); break;
            }
        }
    };

    private static boolean operationReturnsData(String op) {
        return "nodes".equals(op)
                || "windows".equals(op)
                || "clip".equals(op)
                || "paste".equals(op);
    }

    /**
     * A reply destination is accepted only after the control token has authenticated the
     * explicit broadcast. The address is always hard-coded loopback; callers choose only an
     * OS-assigned port and a fresh 256-bit correlation nonce.
     */
    private ReplyTarget validatedReplyTarget(Intent i) {
        if (!i.hasExtra("reply_port") && !i.hasExtra("reply_nonce")) return null;
        final int port;
        final String nonce;
        try {
            port = i.getIntExtra("reply_port", -1);
            nonce = i.getStringExtra("reply_nonce");
        } catch (Throwable malformedExtra) {
            return null;
        }
        if (port < MIN_REPLY_PORT || port > MAX_REPLY_PORT
                || nonce == null || nonce.length() != 64) {
            return null;
        }
        for (int n = 0; n < nonce.length(); n++) {
            char c = nonce.charAt(n);
            if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return null;
        }
        return new ReplyTarget(port, nonce);
    }

    private static final class ReplyTarget {
        final int port;
        final String nonce;

        ReplyTarget(int port, String nonce) {
            this.port = port;
            this.nonce = nonce;
        }
    }

    @Override protected void onServiceConnected() {
        super.onServiceConnected();
        Log.i(TAG, "connected; registering command receiver");
        loadOrCreateControlToken();
        IntentFilter f = new IntentFilter(ACTION);
        // Exported so adb (chat agent) and in-process callers reach it; gated by control token.
        registerReceiver(cmd, f, Context.RECEIVER_EXPORTED);
    }

    /** Per-install secret gating the control channel. Stored in Evogent's scoped external dir. */
    private void loadOrCreateControlToken() {
        try {
            controlToken = EvogentControlToken.loadOrCreate(this);
            Log.i(TAG, "control token ready");
        } catch (Throwable t) { Log.e(TAG, "control token init failed", t); controlToken = null; }
    }

    private VirtualDisplay virtualDisplay;
    private ImageReader imageReader;

    /** A1 probe: can Evogent create its own (untrusted) hidden display? Can shell launch onto it? */
    private void makeDisplay() {
        try {
            DisplayManager dm = (DisplayManager) getSystemService(DISPLAY_SERVICE);
            imageReader = ImageReader.newInstance(1080, 2400, PixelFormat.RGBA_8888, 2);
            int flags = DisplayManager.VIRTUAL_DISPLAY_FLAG_OWN_CONTENT_ONLY
                      | DisplayManager.VIRTUAL_DISPLAY_FLAG_PRESENTATION;
            virtualDisplay = dm.createVirtualDisplay("evo-hidden", 1080, 2400, 420,
                    imageReader.getSurface(), flags);
            int id = virtualDisplay.getDisplay().getDisplayId();
            Log.i(TAG, "MAKEDISPLAY id=" + id);
        } catch (Throwable t) { Log.e(TAG, "makeDisplay", t); }
    }

    private void delDisplay() {
        if (virtualDisplay != null) { virtualDisplay.release(); virtualDisplay = null; }
        if (imageReader != null) { imageReader.close(); imageReader = null; }
        Log.i(TAG, "DELDISPLAY done");
    }

    /** A2 probe: dispatchGesture onto a specific (hidden) display via setDisplayId (API 30+). */
    private void gestureOnDisplay(int displayId, int x1, int y1, int x2, int y2, int ms) {
        Path p = new Path(); p.moveTo(x1, y1); p.lineTo(x2, y2);
        GestureDescription.Builder b = new GestureDescription.Builder();
        b.addStroke(new GestureDescription.StrokeDescription(p, 0, ms));
        try { b.setDisplayId(displayId); } catch (Throwable t) { Log.e(TAG, "setDisplayId", t); }
        boolean ok = dispatchGesture(b.build(), new GestureResultCallback() {
            @Override public void onCompleted(GestureDescription d) { Log.i(TAG, "GESTURE completed disp=" + displayId); }
            @Override public void onCancelled(GestureDescription d) { Log.i(TAG, "GESTURE cancelled disp=" + displayId); }
        }, main);
        Log.i(TAG, "GESTURE disp=" + displayId + " dispatched=" + ok);
    }

    @Override public void onAccessibilityEvent(AccessibilityEvent event) {
        // Event delivery keeps the service ready for authenticated on-device control operations.
        // Persistent display-0 UI was intentionally removed; no event may create an overlay.
    }

    @Override public void onInterrupt() { Log.i(TAG, "interrupted"); }

    @Override public void onDestroy() {
        try { unregisterReceiver(cmd); } catch (Exception ignored) {}
        super.onDestroy();
    }

    // ---- EYES: node tree ---------------------------------------------------

    private String dumpActiveTree() {
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null) { Log.i(TAG, "NODES: root=null"); return "NODES: root=null"; }
        StringBuilder sb = new StringBuilder();
        sb.append("NODES pkg=").append(root.getPackageName()).append('\n');
        walk(root, 0, sb, new int[]{0}, 400);
        Log.i(TAG, "NODES BEGIN\n" + sb + "\nNODES END");
        String payload = sb.toString();
        writeFile("nodes.txt", payload.getBytes());
        return payload;
    }

    /** Dump the node tree of the top app window on a SPECIFIC display (e.g. a hidden virtual
     *  display created by Shizuku op=launch) and push it to the on-device agent over the loopback.
     *  This is the background-browse read path: display 0 keeps showing the user's Evogent feed
     *  while the agent reads the target app running invisibly on `displayId`. */
    private String dumpTreeOnDisplay(int displayId) {
        AccessibilityNodeInfo root = rootOnDisplay(displayId);
        if (root == null) {
            String r = "NODES display=" + displayId + " root=null";
            Log.i(TAG, r);
            return r;
        }
        StringBuilder sb = new StringBuilder();
        sb.append("NODES display=").append(displayId)
          .append(" pkg=").append(root.getPackageName()).append('\n');
        walk(root, 0, sb, new int[]{0}, 400);
        Log.i(TAG, "NODES BEGIN\n" + sb + "\nNODES END");
        String payload = sb.toString();
        writeFile("nodes.txt", payload.getBytes());
        return payload;
    }

    /** Read the primary clipboard text (must run on the main thread; clipboard access is UI-thread
     *  bound on some OEMs). Returns "" if empty or blocked. */
    private String readClipboard() {
        final String[] box = { "" };
        final Object lock = new Object();
        main.post(new Runnable() { public void run() {
            try {
                android.content.ClipboardManager cm =
                        (android.content.ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                if (cm != null && cm.hasPrimaryClip() && cm.getPrimaryClip() != null
                        && cm.getPrimaryClip().getItemCount() > 0) {
                    CharSequence t = cm.getPrimaryClip().getItemAt(0).coerceToText(getApplicationContext());
                    box[0] = t != null ? t.toString() : "";
                }
            } catch (Throwable t) {
                Log.e(TAG, "CLIP read", t);
            }
            synchronized (lock) { lock.notifyAll(); }
        }});
        synchronized (lock) {
            try { lock.wait(2000); } catch (InterruptedException ignored) {}
        }
        Log.i(TAG, "CLIP read " + box[0].length() + " chars");
        return box[0];
    }

    /** Focus the first editable node on the display, paste the clipboard into it, and return the
     *  resulting text. Used to exfiltrate a "Copy link" URL that an app won't expose any other way.
     *  ACTION_PASTE is a node action the system fulfils, so this needs no clipboard-read permission. */
    private String pasteAndRead(int displayId) {
        AccessibilityNodeInfo root = rootOnDisplay(displayId);
        AccessibilityNodeInfo field = findEditable(root);
        if (field == null) { Log.i(TAG, "PASTE no editable field on display=" + displayId); return null; }
        try {
            field.performAction(AccessibilityNodeInfo.ACTION_FOCUS);
            field.performAction(AccessibilityNodeInfo.ACTION_PASTE);
        } catch (Throwable t) { Log.e(TAG, "PASTE action", t); return null; }
        // Re-read the node fresh; the pasted text lands after the action resolves.
        try { Thread.sleep(400); } catch (InterruptedException ignored) {}
        AccessibilityNodeInfo again = findEditable(rootOnDisplay(displayId));
        CharSequence txt = again != null ? again.getText() : field.getText();
        String out = txt != null ? txt.toString() : "";
        Log.i(TAG, "PASTE display=" + displayId + " read " + out.length() + " chars");
        return out;
    }

    private AccessibilityNodeInfo findEditable(AccessibilityNodeInfo n) {
        if (n == null) return null;
        if (n.isEditable()) return n;
        for (int c = 0; c < n.getChildCount(); c++) {
            AccessibilityNodeInfo r = findEditable(n.getChild(c));
            if (r != null) return r;
        }
        return null;
    }

    /**
     * Push a result to the authenticated request's one-shot loopback receiver. The nonce is
     * repeated inside the response envelope, so a different local app cannot win a connect race
     * and substitute data merely by discovering the ephemeral port.
     */
    private void sendToLocalAgent(final ReplyTarget reply, final String data) {
        if (reply == null) return;
        new Thread(new Runnable() { public void run() {
            java.net.Socket s = null;
            try {
                s = new java.net.Socket();
                s.connect(new java.net.InetSocketAddress("127.0.0.1", reply.port), 1500);
                String envelope = REPLY_MAGIC + " " + reply.nonce + "\n"
                        + (data == null ? "" : data);
                s.getOutputStream().write(envelope.getBytes("UTF-8"));
                s.getOutputStream().flush();
            } catch (Throwable t) {
                Log.w(TAG, "authenticated loopback reply failed for op result");
            } finally {
                if (s != null) try { s.close(); } catch (Throwable ignored) {}
            }
        }}, "EvogentA11yReply").start();
    }

    private void walk(AccessibilityNodeInfo n, int depth, StringBuilder sb, int[] count, int limit) {
        if (n == null || count[0] >= limit) return;
        count[0]++;
        CharSequence text = n.getText();
        CharSequence desc = n.getContentDescription();
        boolean exposesState = n.isSelected() || n.isCheckable();
        if ((text != null && text.length() > 0) || (desc != null && desc.length() > 0)
                || exposesState) {
            for (int d = 0; d < depth; d++) sb.append("  ");
            sb.append(shortClass(n.getClassName()));
            if (text != null && text.length() > 0) sb.append(" text=\"").append(text).append('"');
            if (desc != null && desc.length() > 0) sb.append(" desc=\"").append(desc).append('"');
            if (n.isClickable()) sb.append(" [clickable]");
            if (n.isSelected()) sb.append(" [selected]");
            if (n.isCheckable()) sb.append(n.isChecked() ? " [checked]" : " [unchecked]");
            sb.append('\n');
        }
        for (int c = 0; c < n.getChildCount(); c++) walk(n.getChild(c), depth + 1, sb, count, limit);
    }

    private String dumpAllWindows() {
        StringBuilder sb = new StringBuilder();
        // getWindows() = interactive windows the service can see (default display only,
        // historically). getWindowsOnAllDisplays() (API 30+) is keyed by displayId.
        List<AccessibilityWindowInfo> ws = getWindows();
        sb.append("WINDOWS getWindows() count=").append(ws == null ? 0 : ws.size()).append('\n');
        if (ws != null) for (AccessibilityWindowInfo w : ws) {
            sb.append("  win id=").append(w.getId())
              .append(" display=").append(w.getDisplayId())
              .append(" type=").append(w.getType());
            AccessibilityNodeInfo r = w.getRoot();
            sb.append(" pkg=").append(r == null ? "null" : r.getPackageName()).append('\n');
        }
        try {
            android.util.SparseArray<List<AccessibilityWindowInfo>> all = getWindowsOnAllDisplays();
            sb.append("getWindowsOnAllDisplays() displays=").append(all.size()).append('\n');
            for (int k = 0; k < all.size(); k++) {
                int displayId = all.keyAt(k);
                List<AccessibilityWindowInfo> lst = all.valueAt(k);
                sb.append("  display ").append(displayId).append(" windows=")
                  .append(lst == null ? 0 : lst.size()).append('\n');
                if (lst != null) for (AccessibilityWindowInfo w : lst) {
                    AccessibilityNodeInfo r = w.getRoot();
                    sb.append("    win id=").append(w.getId())
                      .append(" pkg=").append(r == null ? "null" : r.getPackageName()).append('\n');
                }
            }
        } catch (Throwable t) {
            sb.append("getWindowsOnAllDisplays() threw ").append(t).append('\n');
        }
        Log.i(TAG, "WINDOWS BEGIN\n" + sb + "\nWINDOWS END");
        writeFile("windows.txt", sb.toString().getBytes());
        // The caller sends this over its request-bound loopback response so the on-device agent
        // can discover which hidden display id a just-launched app landed on, then read it with
        // op=nodes --ei display <id>.
        return sb.toString();
    }

    // ---- HANDS: gestures ---------------------------------------------------

    private void tap(int x, int y) {
        Path p = new Path(); p.moveTo(x, y);
        GestureDescription g = new GestureDescription.Builder()
                .addStroke(new GestureDescription.StrokeDescription(p, 0, 50)).build();
        boolean ok = dispatchGesture(g, null, null);
        Log.i(TAG, "TAP " + x + "," + y + " dispatched=" + ok);
    }

    private void swipe(int x1, int y1, int x2, int y2, int ms) {
        Path p = new Path(); p.moveTo(x1, y1); p.lineTo(x2, y2);
        GestureDescription g = new GestureDescription.Builder()
                .addStroke(new GestureDescription.StrokeDescription(p, 0, ms)).build();
        boolean ok = dispatchGesture(g, new GestureResultCallback() {
            @Override public void onCompleted(GestureDescription d) { Log.i(TAG, "SWIPE completed"); }
            @Override public void onCancelled(GestureDescription d) { Log.i(TAG, "SWIPE cancelled"); }
        }, main);
        Log.i(TAG, "SWIPE " + x1 + "," + y1 + "->" + x2 + "," + y2 + " dispatched=" + ok);
    }

    // ---- HANDS on ANY display: node actions route to the owning window -----

    /** Root of the top window on a specific display (default display -> active window). */
    private AccessibilityNodeInfo rootOnDisplay(int displayId) {
        if (displayId == Display.DEFAULT_DISPLAY) {
            AccessibilityNodeInfo r = getRootInActiveWindow();
            if (r != null) return r;
        }
        try {
            android.util.SparseArray<List<AccessibilityWindowInfo>> all = getWindowsOnAllDisplays();
            List<AccessibilityWindowInfo> lst = all.get(displayId);
            if (lst != null) {
                for (AccessibilityWindowInfo w : lst) {
                    if (w.getType() == AccessibilityWindowInfo.TYPE_APPLICATION) {
                        AccessibilityNodeInfo r = w.getRoot();
                        if (r != null) return r;
                    }
                }
                for (AccessibilityWindowInfo w : lst) {
                    AccessibilityNodeInfo r = w.getRoot();
                    if (r != null) return r;
                }
            }
        } catch (Throwable t) { Log.e(TAG, "rootOnDisplay " + displayId, t); }
        return null;
    }

    private void scrollOnDisplay(int displayId) {
        AccessibilityNodeInfo root = rootOnDisplay(displayId);
        if (root == null) { Log.i(TAG, "SCROLL display=" + displayId + " root=null"); return; }
        AccessibilityNodeInfo s = findScrollable(root);
        if (s == null) { Log.i(TAG, "SCROLL display=" + displayId + " no scrollable node"); return; }
        boolean ok = s.performAction(AccessibilityNodeInfo.ACTION_SCROLL_FORWARD);
        Log.i(TAG, "SCROLL display=" + displayId + " node=" + shortClass(s.getClassName())
                + " performed=" + ok);
    }

    private AccessibilityNodeInfo findScrollable(AccessibilityNodeInfo n) {
        if (n == null) return null;
        if (n.isScrollable()) return n;
        for (int c = 0; c < n.getChildCount(); c++) {
            AccessibilityNodeInfo r = findScrollable(n.getChild(c));
            if (r != null) return r;
        }
        return null;
    }

    private String clickTextOnDisplay(int displayId, String text) {
        boolean validText = text != null && !text.trim().isEmpty();
        if (!validText) {
            String result = EvogentAccessibilityActionPolicy.clickTextResult(
                    false, false, false, false);
            Log.i(TAG, "CLICKTEXT invalid text");
            return result;
        }
        // Search EVERY window on the display (feed, bottom sheet, share chooser are
        // separate windows), newest/topmost first, so a share dialog wins over the feed.
        AccessibilityNodeInfo hit = findByTextAllWindows(displayId, text);
        if (hit == null) {
            String result = EvogentAccessibilityActionPolicy.clickTextResult(
                    true, false, false, false);
            Log.i(TAG, "CLICKTEXT display=" + displayId + " '" + text + "' not found");
            return result;
        }
        AccessibilityNodeInfo target = hit;
        while (target != null && !target.isClickable()) target = target.getParent();
        boolean ok = target != null && target.performAction(AccessibilityNodeInfo.ACTION_CLICK);
        String result = EvogentAccessibilityActionPolicy.clickTextResult(
                true, true, target != null, ok);
        Log.i(TAG, "CLICKTEXT display=" + displayId + " '" + text + "' performed=" + ok
                + " on \"" + (hit.getText() != null ? hit.getText() : hit.getContentDescription()) + "\"");
        return result;
    }

    private AccessibilityNodeInfo findByTextAllWindows(int displayId, String text) {
        // Default display: try the active window first.
        if (displayId == Display.DEFAULT_DISPLAY) {
            AccessibilityNodeInfo r = getRootInActiveWindow();
            AccessibilityNodeInfo h = findByText(r, text);
            if (h != null) return h;
        }
        try {
            android.util.SparseArray<List<AccessibilityWindowInfo>> all = getWindowsOnAllDisplays();
            List<AccessibilityWindowInfo> lst = all.get(displayId);
            if (lst != null) {
                // Topmost windows are last in z-order; walk from the end so dialogs win.
                for (int i = lst.size() - 1; i >= 0; i--) {
                    AccessibilityNodeInfo r = lst.get(i).getRoot();
                    AccessibilityNodeInfo h = findByText(r, text);
                    if (h != null) return h;
                }
            }
        } catch (Throwable t) { Log.e(TAG, "findByTextAllWindows " + displayId, t); }
        return null;
    }

    private AccessibilityNodeInfo findByText(AccessibilityNodeInfo n, String text) {
        if (n == null) return null;
        CharSequence t = n.getText();
        CharSequence d = n.getContentDescription();
        if ((t != null && t.toString().contains(text)) || (d != null && d.toString().contains(text))) return n;
        for (int c = 0; c < n.getChildCount(); c++) {
            AccessibilityNodeInfo r = findByText(n.getChild(c), text);
            if (r != null) return r;
        }
        return null;
    }

    // ---- EYES: real pixels, no MediaProjection consent ---------------------

    private void shot(final int displayId, final String name) {
        final String fname = (name == null ? "shot-d" + displayId : name) + ".png";
        takeScreenshot(displayId, getMainExecutor(), new TakeScreenshotCallback() {
            @Override public void onSuccess(ScreenshotResult res) {
                try {
                    Bitmap hw = Bitmap.wrapHardwareBuffer(res.getHardwareBuffer(), res.getColorSpace());
                    Bitmap sw = hw.copy(Bitmap.Config.ARGB_8888, false);
                    res.getHardwareBuffer().close();
                    File out = new File(getExternalFilesDir(null), fname);
                    FileOutputStream fos = new FileOutputStream(out);
                    sw.compress(Bitmap.CompressFormat.PNG, 100, fos);
                    fos.close();
                    Log.i(TAG, "SHOT ok display=" + displayId + " -> " + out.getAbsolutePath());
                } catch (Throwable t) {
                    Log.e(TAG, "SHOT process failed display=" + displayId, t);
                }
            }
            @Override public void onFailure(int errorCode) {
                Log.e(TAG, "SHOT failed display=" + displayId + " err=" + errorCode);
            }
        });
    }

    /**
     * Capture just the content image of one item. `match` locates a container node by a
     * text/desc substring (e.g. the Instagram post container "<author> posted a ..."); within
     * that container we crop to the largest full-width descendant, which is the post photo/video
     * frame (the image node itself carries no desc, so it can't be matched by text — only by
     * geometry). Writes <name>.png of just that region. General: works for any app where the
     * content media is the biggest full-width element under a labelled container.
     */
    private void shotNode(final int displayId, final String match, final String name) {
        final String fname = (name == null ? "shotnode-d" + displayId : name) + ".png";
        AccessibilityNodeInfo matched = (match == null || match.isEmpty())
                ? rootOnDisplay(displayId) : findByTextAllWindows(displayId, match);
        if (matched == null) { Log.i(TAG, "SHOTNODE no match '" + match + "' display=" + displayId); return; }

        // Display bounds (for "is this the whole feed list, not one post?" check).
        AccessibilityNodeInfo dispRoot = rootOnDisplay(displayId);
        final android.graphics.Rect dispR = new android.graphics.Rect();
        if (dispRoot != null) dispRoot.getBoundsInScreen(dispR);
        final int dispH = dispR.height() > 0 ? dispR.height() : 3000;

        // The "<author> posted..." desc often sits on the header ROW, not the whole post. Climb to
        // the tallest ancestor that is still a single post (height <= 85% of the display) — that's
        // the post container that also contains the media, which is a sibling of the header.
        AccessibilityNodeInfo container = matched;
        final android.graphics.Rect mR = new android.graphics.Rect();
        matched.getBoundsInScreen(mR);
        android.graphics.Rect cR = new android.graphics.Rect(mR);
        AccessibilityNodeInfo p = matched.getParent();
        while (p != null) {
            android.graphics.Rect pr = new android.graphics.Rect();
            p.getBoundsInScreen(pr);
            if (pr.height() <= dispH * 0.85 && pr.height() >= cR.height()) {
                container = p; cR.set(pr);
            }
            p = p.getParent();
        }
        final android.graphics.Rect crop = new android.graphics.Rect(cR);
        final int containerW = crop.width();
        final long containerArea = (long) crop.width() * crop.height();

        // Within the post container, find the largest image-shaped full-width region (the photo).
        // If nothing image-like is exposed (video/carousel often have no a11y bounds), fall back
        // to the whole-post crop, which is still a clean, unambiguous card image.
        final android.graphics.Rect best = new android.graphics.Rect(crop);
        final long[] bestArea = { 0 };
        largestFullWidth(container, containerW, best, bestArea);
        if (bestArea[0] < containerArea * 0.25) best.set(crop); // no real media node -> whole post

        // Debug sidecar so the crop geometry is inspectable without logcat (rish can't read it).
        try {
            File dbg = new File(getExternalFilesDir(null), (name == null ? "shotnode" : name) + ".rect.txt");
            FileOutputStream d = new FileOutputStream(dbg);
            d.write(("match=" + mR + "\ncontainer=" + crop + "\nchosen=" + best
                    + "\nbestArea=" + bestArea[0] + " containerArea=" + containerArea
                    + " dispH=" + dispH + "\n").getBytes());
            d.close();
        } catch (Throwable ignored) {}
        takeScreenshot(displayId, getMainExecutor(), new TakeScreenshotCallback() {
            @Override public void onSuccess(ScreenshotResult res) {
                try {
                    Bitmap hw = Bitmap.wrapHardwareBuffer(res.getHardwareBuffer(), res.getColorSpace());
                    Bitmap sw = hw.copy(Bitmap.Config.ARGB_8888, false);
                    res.getHardwareBuffer().close();
                    int x = Math.max(0, best.left), y = Math.max(0, best.top);
                    int w = Math.min(best.width(), sw.getWidth() - x);
                    int h = Math.min(best.height(), sw.getHeight() - y);
                    if (w <= 0 || h <= 0) { Log.e(TAG, "SHOTNODE empty rect " + best); return; }
                    Bitmap cropped = Bitmap.createBitmap(sw, x, y, w, h);
                    File out = new File(getExternalFilesDir(null), fname);
                    FileOutputStream fos = new FileOutputStream(out);
                    cropped.compress(Bitmap.CompressFormat.PNG, 100, fos);
                    fos.close();
                    Log.i(TAG, "SHOTNODE ok display=" + displayId + " rect=" + best + " -> " + out.getAbsolutePath());
                } catch (Throwable t) {
                    Log.e(TAG, "SHOTNODE process failed display=" + displayId, t);
                }
            }
            @Override public void onFailure(int errorCode) {
                Log.e(TAG, "SHOTNODE failed display=" + displayId + " err=" + errorCode);
            }
        });
    }

    /** Recurse a subtree; record the bounds of the largest node that spans >= 75% of the
     *  container width AND is image-shaped (height <= 1.4x width, so tall text/caption wrappers
     *  don't win) — the media frame. */
    private void largestFullWidth(AccessibilityNodeInfo n, int containerW,
                                  android.graphics.Rect best, long[] bestArea) {
        if (n == null) return;
        android.graphics.Rect r = new android.graphics.Rect();
        n.getBoundsInScreen(r);
        long area = (long) r.width() * r.height();
        boolean fullWidth = r.width() >= containerW * 0.75;
        // Image-shaped: tall enough to be a photo (>= 0.5x width) but not a tall text column
        // (<= 1.4x width). Thin dividers/action rows and caption blocks are rejected.
        boolean imageShaped = r.height() >= r.width() * 0.5 && r.height() <= r.width() * 1.4;
        if (fullWidth && imageShaped && area > bestArea[0]) {
            bestArea[0] = area;
            best.set(r);
        }
        for (int c = 0; c < n.getChildCount(); c++) largestFullWidth(n.getChild(c), containerW, best, bestArea);
    }

    // ---- util --------------------------------------------------------------

    private void writeFile(String name, byte[] bytes) {
        try {
            File out = new File(getExternalFilesDir(null), name);
            FileOutputStream fos = new FileOutputStream(out);
            fos.write(bytes); fos.close();
            Log.i(TAG, "wrote " + out.getAbsolutePath());
        } catch (Throwable t) { Log.e(TAG, "writeFile " + name, t); }
    }

    private static String shortClass(CharSequence cn) {
        if (cn == null) return "?";
        String s = cn.toString();
        int dot = s.lastIndexOf('.');
        return dot >= 0 ? s.substring(dot + 1) : s;
    }
}

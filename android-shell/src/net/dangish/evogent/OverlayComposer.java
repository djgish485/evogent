package net.dangish.evogent;

import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Outline;
import android.graphics.PixelFormat;
import android.graphics.drawable.GradientDrawable;
import android.hardware.display.DisplayManager;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.Display;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewOutlineProvider;
import android.view.WindowManager;
import android.webkit.JsPromptResult;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * The anywhere composer: a purple floating bubble (TYPE_APPLICATION_OVERLAY, the
 * SYSTEM_ALERT_WINDOW "chat head" window type — the one type that reliably draws over OTHER
 * apps on Android 16 and accepts keyboard focus) shown over other apps.
 *
 * Tapping the bubble captures what the user is currently looking at (foreground package +
 * visible node text of display 0, read through the accessibility service BEFORE our sheet
 * exists) and opens the REAL Evogent composer: a bottom-sheet WebView loading the app at
 * /?overlay=1 — the exact same ConversationDetail + Add Message composer the user knows from
 * the home screen, pinned to the main session. The page pulls the captured screen context
 * over the exact-origin EvogentOverlay prompt facade and attaches it (contextKind "screen",
 * wrapped as UNTRUSTED data server-side) to the first send; replies stream in through the app's own
 * SSE/WebSocket plumbing, so the overlay and the in-app thread are one continuous session.
 *
 * The bubble hides while Evogent itself is foreground (the pinned composer already lives
 * there) and can be toggled via the token-gated A11Y broadcast (op=overlay --ei on 0|1).
 */
class OverlayComposer {
    private static final String TAG = "EvogentOverlay";
    private static final String BASE_URL = EvogentSecurityPolicy.LOOPBACK_ORIGIN;
    private static final String OVERLAY_URL = BASE_URL + "/?overlay=1";
    private static final String OVERLAY_PROMPT_MARKER = "__EVOGENT_OVERLAY_V2__";
    private static final String OVERLAY_FACADE_SCRIPT =
            "(function(){'use strict';"
            + "if(window.top!==window||window.EvogentOverlay)return;"
            + "var nativePrompt=window.prompt.bind(window);"
            + "function call(method,args){return nativePrompt('" + OVERLAY_PROMPT_MARKER
            + "',JSON.stringify({method:method,args:args||[]}));}"
            + "Object.defineProperty(window,'EvogentOverlay',{"
            + "value:Object.freeze({"
            + "getScreenContext:function(){return call('getScreenContext',[]);},"
            + "setHeight:function(px){return call('setHeight',[Number(px)]);},"
            + "close:function(){return call('close',[]);},"
            + "openApp:function(){return call('openApp',[]);}"
            + "}),writable:false,configurable:false});"
            + "})();";
    private static final int MAX_CONTEXT_CHARS = 4000;
    private static final long SERVER_PROOF_MAX_AGE_MS = 5 * 60 * 1000L;
    private static final long PERIODIC_PROOF_REFRESH_MS = 4 * 60 * 1000L;
    private static final long AUTH_RETRY_MS = 2000L;

    private final Context service; // the OverlayService (foreground) that hosts the overlay
    private final Context windowContext; // held so its overlay windows aren't GC'd away
    private final WindowManager wm;
    private final Handler main = new Handler(Looper.getMainLooper());

    private View bubble;
    private WindowManager.LayoutParams bubbleLp;
    private View homeButton;
    private View panel;
    private WebView panelWebView;
    private boolean panelRequested;
    private boolean panelDocumentTrusted;
    private final EvogentDocumentAuthority panelDocumentAuthority =
            new EvogentDocumentAuthority();
    private long panelAttempt;
    private long panelDocumentAuthGeneration;
    private long panelAuthorizedLoadGeneration;
    private String panelDocumentNonce;
    private String panelAuthorizedDocumentNonce;
    private long panelDocumentProofId;
    private long panelRefreshId;
    private EvogentLoopbackAuth.WebSession panelAuthSession;
    private boolean destroyed;
    private boolean enabled = true;
    private boolean foregroundIsEvogent = false;
    private boolean foregroundIsLauncher = false;
    // Recognize OEM launchers so overlay lifecycle follows HOME semantics consistently.
    private final java.util.Set<String> launcherPackages = new java.util.HashSet<String>();

    OverlayComposer(Context service) {
        this.service = service;
        // CRITICAL: an AccessibilityService's own getSystemService(WINDOW_SERVICE) returns a
        // WindowManager scoped to the ACCESSIBILITY overlay layer — addView() there succeeds but
        // the window never renders over foreground apps (this is why the bubble was invisible
        // regardless of window type). createWindowContext(display, TYPE_APPLICATION_OVERLAY) gives a
        // real application-overlay WindowManager (the chat-head layer), which DOES draw over other
        // apps and accepts input. Requires SYSTEM_ALERT_WINDOW (granted). Must pass the Display
        // explicitly — the service context isn't display-associated, and the 2-arg overload throws.
        WindowManager w;
        Context wc;
        try {
            DisplayManager dm = (DisplayManager) service.getSystemService(Context.DISPLAY_SERVICE);
            Display display = dm.getDisplay(Display.DEFAULT_DISPLAY);
            wc = service.createWindowContext(display,
                    WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY, null);
            w = (WindowManager) wc.getSystemService(Context.WINDOW_SERVICE);
            Log.i(TAG, "overlay window context ready; wm=" + w);
        } catch (Throwable t) {
            // Never let an overlay init failure crash the accessibility service (it powers
            // everything). Fall back to the plain service WM; the bubble just won't show.
            Log.e(TAG, "overlay window context init failed; overlay disabled", t);
            wc = service;
            w = (WindowManager) service.getSystemService(Context.WINDOW_SERVICE);
        }
        this.windowContext = wc; // MUST keep a reference; the WM's windows die with the context
        this.wm = w;

        try {
            Intent home = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME);
            for (android.content.pm.ResolveInfo ri
                    : service.getPackageManager().queryIntentActivities(home, 0)) {
                if (ri.activityInfo != null
                        && !service.getPackageName().equals(ri.activityInfo.packageName)) {
                    launcherPackages.add(ri.activityInfo.packageName);
                }
            }
            Log.i(TAG, "launcher packages: " + launcherPackages);
        } catch (Throwable t) {
            Log.e(TAG, "launcher package resolution failed", t);
        }
    }

    // ---- bubble ------------------------------------------------------------

    void setEnabled(boolean on) {
        enabled = on;
        main.post(new Runnable() { public void run() {
            if (!enabled) closePanelNow();
            sync();
        } });
    }

    void onForegroundPackage(CharSequence pkg) {
        // Always re-evaluate visibility, not only when Evogent-ness flips. If the service
        // (re)connects while a non-Evogent app is already foreground — which happens after a
        // force-stop during testing — foregroundIsEvogent starts false and the old
        // change-guard swallowed every same-state event, so the bubble was never added and
        // stayed absent over X and other apps. sync() is idempotent and cheap.
        foregroundIsEvogent = pkg != null && service.getPackageName().contentEquals(pkg);
        foregroundIsLauncher = pkg != null && launcherPackages.contains(pkg.toString());
        final boolean enteredEvogent = foregroundIsEvogent;
        main.post(new Runnable() { public void run() {
            // Capture the transition itself: a rapid follow-up package event must not erase the
            // fact that display 0 entered Evogent while an overlay request was still in flight.
            if (EvogentOverlayVisibilityPolicy.shouldClosePanel(
                    enteredEvogent,
                    panelRequested,
                    panel != null)) {
                closePanelNow();
            }
            sync();
        } });
    }

    private void sync() {
        // The bubble stays up WHILE the panel is open — it's the open/close toggle now (the
        // in-panel × was removed). Only the foreground app / enabled flag gate its visibility.
        // Outside Evogent: the spark compose FAB shows everywhere (incl. the launcher —
        // bottom-right = overlay the add-message form); the "Evogent" return pill shows ONLY
        // on the stock launcher (bottom-left = back to the full feed; from any other app the
        // HOME gesture already returns to Evogent).
        if (EvogentOverlayVisibilityPolicy.shouldClosePanel(
                foregroundIsEvogent,
                panelRequested,
                panel != null)) {
            closePanelNow();
        }
        boolean show = enabled && !foregroundIsEvogent;
        boolean showReturn = show && foregroundIsLauncher;
        if (show && bubble == null) addBubble();
        else if (!show && bubble != null) { removeView(bubble); bubble = null; bubbleLp = null; }
        if (showReturn && homeButton == null) addHomeButton();
        else if (!showReturn && homeButton != null) { removeView(homeButton); homeButton = null; }
        // The foreground app changed: once its UI settles, slide the FAB to a spot where it
        // doesn't cover anything tappable in that app (a11y-read interactive bounds). Start the
        // self-refresh loop so the FAB keeps dodging as the app's UI changes UNDER it — most
        // importantly the KEYBOARD showing/hiding, which does not reliably deliver an a11y event
        // we can hook. Without polling, the FAB can remain over the Enter key after the IME
        // appears. The loop self-cancels when the bubble is gone.
        if (bubble != null) {
            main.postDelayed(new Runnable() { public void run() { repositionBubble(); } }, 650);
            scheduleRepositionLoop();
        }
    }

    private boolean repositionLoopArmed = false;
    private void scheduleRepositionLoop() {
        if (repositionLoopArmed) return;
        repositionLoopArmed = true;
        main.postDelayed(new Runnable() {
            @Override public void run() {
                if (bubble == null || foregroundIsEvogent) { repositionLoopArmed = false; return; }
                repositionBubble();
                main.postDelayed(this, 1200);   // cheap: one a11y bounds read/sec while over an app
            }
        }, 1200);
    }

    /** Move the FAB to the lowest bottom-right slot that covers no interactive element. */
    private void repositionBubble() {
        if (bubble == null || bubbleLp == null || foregroundIsEvogent) return;
        int y = pickFabWindowY();
        if (bubbleLp.y != y) {
            bubbleLp.y = y;
            try { wm.updateViewLayout(bubble, bubbleLp); } catch (Throwable ignored) {}
        }
    }

    private int pickFabWindowY() {
        try {
            EvogentAccessibilityService svc = EvogentAccessibilityService.instance;
            if (svc == null) return dp(16);
            java.util.List<android.graphics.Rect> blocked = svc.interactiveBoundsOnDefaultDisplay();
            android.util.DisplayMetrics dm = service.getResources().getDisplayMetrics();
            int size = dp(44), pad = dp(12), slack = dp(4);
            int right = dm.widthPixels - dp(2) - pad;
            int left = right - size;
            // Hard floor: the FAB must clear the keyboard. When an IME is up, EVERY low slot may
            // be blocked (the app fills the space above the keyboard with suggestions too), and
            // the old fallback then dropped the FAB to the bottom, onto the Enter key.
            // Compute the keyboard's height and never return a slot inside it.
            int imeHeight = svc.imeHeightOnDefaultDisplay();
            int floorDp = imeHeight > 0 ? px2dp(imeHeight) + 20 : 16;
            // Candidate slots start at the keyboard floor and climb; first fully-free slot wins.
            for (int cy = floorDp; cy <= floorDp + 480; cy += 80) {
                int bottom = dm.heightPixels - dp(cy) - pad;
                int top = bottom - size;
                android.graphics.Rect fab = new android.graphics.Rect(
                        left - slack, top - slack, right + slack, bottom + slack);
                boolean hit = false;
                for (android.graphics.Rect b : blocked) {
                    if (android.graphics.Rect.intersects(fab, b)) { hit = true; break; }
                }
                if (!hit) return dp(cy);
            }
            // Nothing fully free (busy screen): sit just above the keyboard. Overlapping a
            // suggestion row is far better than covering the Enter key.
            return dp(floorDp);
        } catch (Throwable ignored) {}
        return dp(16);
    }

    private int px2dp(int px) {
        return (int) (px / service.getResources().getDisplayMetrics().density);
    }

    void destroy() {
        main.post(new Runnable() { public void run() {
            destroyed = true;
            if (bubble != null) { removeView(bubble); bubble = null; }
            if (homeButton != null) { removeView(homeButton); homeButton = null; }
            closePanelNow();
        }});
    }

    /**
     * Wrap a round button in a padded transparent container so its elevation shadow has room
     * to render — overlay windows clip drawing at their own bounds, so the shadow must fit
     * INSIDE the window. Hardware acceleration is forced on the window for shadow rendering.
     */
    private FrameLayout shadowWrap(View button, int buttonSize, int pad) {
        FrameLayout wrap = new FrameLayout(service);
        FrameLayout.LayoutParams inner = new FrameLayout.LayoutParams(buttonSize, buttonSize);
        inner.setMargins(pad, pad, pad, pad);
        wrap.addView(button, inner);
        wrap.setClipChildren(false);
        wrap.setClipToPadding(false);
        return wrap;
    }

    private void addBubble() {
        // Compose FAB: fixed Material position (bottom-right, above the gesture bar), no
        // dragging. The spark — the AI half of the Evogent mark — means "ask the AI from
        // anywhere". Tap toggles the anywhere-composer panel.
        android.widget.ImageView b = new android.widget.ImageView(service);
        b.setImageResource(R.drawable.ic_spark);
        b.setScaleType(android.widget.ImageView.ScaleType.CENTER);
        GradientDrawable bg = new GradientDrawable();
        bg.setShape(GradientDrawable.OVAL);
        bg.setColor(Color.parseColor("#7C3AED"));
        b.setBackground(bg);
        b.setElevation(dp(6));
        b.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) {
                if (panelRequested || panel != null) closePanel(); else openPanel();
            }
        });

        int size = dp(44);  // unified fixed-button size across the whole family
        int pad = dp(12);
        FrameLayout wrap = shadowWrap(b, size, pad);
        final WindowManager.LayoutParams lp = overlayParams(size + 2 * pad, size + 2 * pad, true);
        lp.flags |= WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED;
        lp.gravity = Gravity.BOTTOM | Gravity.END;
        lp.x = dp(2);              // + pad = ~14dp visual margin from the right edge
        lp.y = pickFabWindowY();   // lowest slot that covers nothing tappable underneath

        try {
            wm.addView(wrap, lp);
            bubble = wrap;
            bubbleLp = lp;
            final View fb = wrap;
            // Log whether the view actually attached ~300ms later — addView can return without
            // throwing yet never attach a real surface.
            main.postDelayed(new Runnable() { public void run() {
                Log.i(TAG, "OVERLAY_ADDED wm=" + wm.getClass().getName()
                        + " attached=" + fb.isAttachedToWindow()
                        + " shown=" + (fb.getWindowToken() != null)
                        + " vis=" + fb.getVisibility());
            }}, 350);
        } catch (Throwable t) {
            Log.e(TAG, "addBubble", t);
        }
    }

    /**
     * "▣ Evogent" pill shown ONLY over the stock launcher, bottom-left above its search bar:
     * the mirror of the in-app Android-home switcher, so one thumb motion toggles between
     * Evogent and the Android home screen in both directions. Plain activity relaunch —
     * singleTask resumes Evogent exactly where it was (the HOME gesture, by contrast,
     * resets to the feed root).
     */
    private void addHomeButton() {
        android.widget.ImageView b = new android.widget.ImageView(service);
        b.setImageResource(R.drawable.ic_evogent);
        b.setScaleType(android.widget.ImageView.ScaleType.CENTER);
        b.setContentDescription("Open Evogent");
        GradientDrawable bg = new GradientDrawable();
        bg.setShape(GradientDrawable.OVAL);
        bg.setColor(Color.parseColor("#7C3AED"));
        b.setBackground(bg);
        b.setElevation(dp(6));
        b.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) {
                try {
                    Intent i = new Intent(service, MainActivity.class);
                    i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    service.startActivity(i); // SAW-holding apps are exempt from BAL limits
                } catch (Throwable t) {
                    Log.e(TAG, "return-to-evogent launch failed", t);
                }
            }
        });

        int size = dp(44);  // unified fixed-button size across the whole family
        int pad = dp(12);
        FrameLayout wrap = shadowWrap(b, size, pad);
        WindowManager.LayoutParams lp = overlayParams(size + 2 * pad, size + 2 * pad, true);
        lp.flags |= WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED;
        lp.gravity = Gravity.BOTTOM | Gravity.START;
        lp.x = dp(2);   // mirrors the FAB's right-edge inset
        lp.y = dp(22);  // docked on the launcher's search-bar row, replacing its left corner

        try {
            wm.addView(wrap, lp);
            homeButton = wrap;
        } catch (Throwable t) {
            Log.e(TAG, "addHomeButton", t);
        }
    }

    /** Force-add the bubble regardless of foreground state for a token-authenticated probe.
     *  Results are log-only; unsolicited overlay status must never race an operation reply. */
    void probe() {
        main.post(new Runnable() { public void run() {
            if (bubble != null) { removeView(bubble); bubble = null; }
            addBubble();
        }});
    }

    // ---- panel: the real Evogent composer in a bottom-sheet WebView ---------

    private void openPanel() {
        if (destroyed || !enabled || panelRequested || panel != null) return;
        panelRequested = true;
        beginPanelAuthentication();
    }

    /**
     * Prove the loopback server first, then capture the screen. This ordering prevents a fake
     * listener from eliciting even the short-lived foreground context through a forged composer.
     */
    private void beginPanelAuthentication() {
        if (destroyed || !enabled || !panelRequested) return;
        final long attempt = ++panelAttempt;
        revokePanelTrust();
        EvogentLoopbackAuth.authenticateWeb(service, new EvogentLoopbackAuth.Callback() {
            @Override public void onResult(
                    EvogentLoopbackAuth.WebSession session,
                    Exception error) {
                if (destroyed || !panelRequested || attempt != panelAttempt) return;
                if (session == null || error != null) {
                    Log.i(TAG, "loopback authentication unavailable — retrying");
                    schedulePanelAuthenticationRetry(attempt);
                    return;
                }
                // Capture only after a current server proof and cookie installation. The panel
                // does not exist yet, so the accessibility tree still belongs to the real app.
                EvogentAccessibilityService accessibility =
                        EvogentAccessibilityService.instance;
                String[] context = accessibility != null
                        ? accessibility.captureForegroundContext(MAX_CONTEXT_CHARS)
                        : new String[]{ null, "" };
                if (destroyed || !panelRequested || attempt != panelAttempt) return;
                buildPanel(context[0], context[1], session, attempt);
            }
        });
    }

    private void schedulePanelAuthenticationRetry(final long failedAttempt) {
        main.postDelayed(new Runnable() {
            @Override public void run() {
                if (destroyed || !panelRequested || failedAttempt != panelAttempt) return;
                beginPanelAuthentication();
            }
        }, AUTH_RETRY_MS);
    }

    private void buildPanel(
            String screenApp,
            String screenText,
            final EvogentLoopbackAuth.WebSession authenticatedSession,
            final long attempt) {
        if (destroyed
                || !panelRequested
                || attempt != panelAttempt
                || authenticatedSession == null
                || !authenticatedSession.isFresh(SERVER_PROOF_MAX_AGE_MS)) {
            return;
        }
        WebView web;
        try {
            web = new WebView(windowContext);
        } catch (Throwable t) {
            Log.e(TAG, "WebView create failed", t);
            schedulePanelAuthenticationRetry(attempt);
            return;
        }
        web.setBackgroundColor(Color.parseColor("#0A0A0C"));
        web.getSettings().setJavaScriptEnabled(true);
        web.getSettings().setDomStorageEnabled(true);
        web.getSettings().setAllowFileAccess(false);
        web.getSettings().setAllowContentAccess(false);
        web.getSettings().setMixedContentMode(
                android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        EvogentLoopbackAuth.hardenWebViewCookies(web);
        final OverlayActions actions = new OverlayActions(screenApp, screenText);
        final long authenticationGeneration = authenticatedSession.generation;
        // The facade is plain JavaScript, limited to the exact loopback origin at document start.
        // Native calls use onJsPrompt so Java receives and verifies the calling frame URL.
        final boolean documentStartInstalled =
                NativeWebBridge.installAtDocumentStart(web, OVERLAY_FACADE_SCRIPT);
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
                // User/agent HTML lives in sandboxed frames. Never let a subframe navigation
                // become an app launch with the overlay service's authority.
                if (req == null || req.getUrl() == null || !req.isForMainFrame()) return false;
                String url = req.getUrl().toString();
                if (EvogentSecurityPolicy.isTrustedWebUrl(url)) {
                    if (panelAuthorizedLoadGeneration == authenticationGeneration) return false;
                    restartPanelAuthentication(attempt);
                    return true;
                }
                if (!isPanelDocumentAuthenticated(v)
                        || !req.hasGesture()
                        || !authorizePanelNativeAction(v, attempt)) {
                    Log.w(TAG, "rejected overlay navigation without a user gesture");
                    return true;
                }
                try {
                    if (EvogentSecurityPolicy.isSafeExternalWebUrl(url)) {
                        Intent i = new Intent(Intent.ACTION_VIEW, req.getUrl());
                        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                        service.startActivity(i);
                    } else {
                        Log.w(TAG, "rejected unsafe overlay navigation");
                    }
                } catch (Throwable t) { Log.e(TAG, "external link", t); }
                return true;
            }
            @Override public void onPageStarted(
                    WebView v,
                    String url,
                    android.graphics.Bitmap favicon) {
                boolean authenticated = panelRequested
                        && attempt == panelAttempt
                        && EvogentSecurityPolicy.isTrustedWebUrl(url)
                        && panelAuthSession != null
                        && panelAuthorizedLoadGeneration == panelAuthSession.generation
                        && panelAuthorizedDocumentNonce != null
                        && panelDocumentAuthority.isBound(
                                panelAuthorizedLoadGeneration,
                                panelAuthSession.serverInstanceId)
                        && panelAuthSession.generation == authenticationGeneration
                        && panelAuthSession.isFresh(SERVER_PROOF_MAX_AGE_MS);
                panelDocumentAuthGeneration = authenticated
                        ? panelAuthorizedLoadGeneration
                        : 0;
                panelDocumentNonce = authenticated
                        ? panelAuthorizedDocumentNonce
                        : null;
                panelAuthorizedLoadGeneration = 0;
                panelAuthorizedDocumentNonce = null;
                panelDocumentTrusted = false;
                if (!authenticated) panelDocumentAuthority.revoke();
            }
            @Override public void onPageFinished(WebView v, String url) {
                verifyLoadedPanelDocument(
                        v,
                        url,
                        attempt,
                        documentStartInstalled);
            }
            @Override public void onReceivedError(
                    WebView v,
                    WebResourceRequest req,
                    WebResourceError error) {
                if (req != null
                        && req.isForMainFrame()
                        && req.getUrl() != null
                        && EvogentSecurityPolicy.isTrustedWebUrl(req.getUrl().toString())) {
                    restartPanelAuthentication(attempt);
                }
            }
            @Override public void onReceivedHttpError(
                    WebView v,
                    WebResourceRequest req,
                    WebResourceResponse response) {
                boolean trustedMainFrame = req != null
                        && req.isForMainFrame()
                        && req.getUrl() != null
                        && EvogentSecurityPolicy.isTrustedWebUrl(req.getUrl().toString());
                boolean phoneSessionGate = response != null
                        && EvogentLoopbackAuth.isPhoneSessionGateResponse(response);
                int statusCode = response != null ? response.getStatusCode() : 0;
                if (EvogentOverlayVisibilityPolicy.shouldRestartAfterHttpResponse(
                        trustedMainFrame,
                        phoneSessionGate,
                        statusCode)) {
                    restartPanelAuthentication(attempt);
                }
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onJsPrompt(
                    WebView view,
                    String url,
                    String message,
                    String defaultValue,
                    JsPromptResult result) {
                if (!OVERLAY_PROMPT_MARKER.equals(message)) {
                    return super.onJsPrompt(view, url, message, defaultValue, result);
                }
                handleOverlayPrompt(
                        view,
                        url,
                        defaultValue,
                        result,
                        actions);
                return true;
            }
        });
        // Back key closes the sheet (the WebView holds focus while the sheet is up).
        web.setOnKeyListener(new View.OnKeyListener() {
            @Override public boolean onKey(View v, int keyCode, KeyEvent event) {
                if (keyCode == KeyEvent.KEYCODE_BACK && event.getAction() == KeyEvent.ACTION_UP) {
                    closePanel();
                    return true;
                }
                return false;
            }
        });
        FrameLayout wrap = new FrameLayout(windowContext);
        wrap.addView(web, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        // Round only the top corners: extend the outline rect past the bottom edge.
        final int radius = dp(24);
        wrap.setOutlineProvider(new ViewOutlineProvider() {
            @Override public void getOutline(View v, Outline outline) {
                outline.setRoundRect(0, 0, v.getWidth(), v.getHeight() + radius, radius);
            }
        });
        wrap.setClipToOutline(true);
        // A tap on the app above the sheet closes it (needs FLAG_WATCH_OUTSIDE_TOUCH).
        wrap.setOnTouchListener(new View.OnTouchListener() {
            @Override public boolean onTouch(View v, MotionEvent e) {
                if (e.getActionMasked() == MotionEvent.ACTION_OUTSIDE) {
                    closePanel();
                    return true;
                }
                return false;
            }
        });

        // Open COMPACT — just tall enough for the composer. The page reports its real desired
        // height over the setHeight facade (compact when blank, taller once a thread shows), so
        // this is only the pre-measurement starting size to avoid a big empty flash on open.
        WindowManager.LayoutParams lp = overlayParams(
                WindowManager.LayoutParams.MATCH_PARENT, dp(150), false);
        lp.gravity = Gravity.BOTTOM;
        lp.flags |= WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH;
        lp.softInputMode = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE;

        try {
            wm.addView(wrap, lp);
            panel = wrap;
            panelWebView = web;
            panelAuthSession = authenticatedSession;
            panelAuthorizedLoadGeneration = authenticationGeneration;
            panelAuthorizedDocumentNonce = EvogentLoopbackAuth.newDocumentNonce();
            panelDocumentAuthority.begin(
                    authenticationGeneration,
                    authenticatedSession.serverInstanceId,
                    panelAuthorizedDocumentNonce);
            web.loadUrl(OVERLAY_URL);
            // Re-stack the bubble ON TOP of the panel so a tap on it always toggles the panel
            // closed — even once the panel expands (with messages) over the bubble's spot. Same
            // overlay layer, so later-added = higher z-order.
            if (bubble != null) {
                View b = bubble;
                WindowManager.LayoutParams blp = (WindowManager.LayoutParams) b.getLayoutParams();
                removeView(b);
                try { wm.addView(b, blp); } catch (Throwable ignored) {}
            }
        } catch (Throwable t) {
            Log.e(TAG, "openPanel", t);
            try { web.destroy(); } catch (Throwable ignored) {}
            revokePanelTrust();
            schedulePanelAuthenticationRetry(attempt);
        }
    }

    private void closePanel() {
        main.post(new Runnable() { public void run() {
            closePanelNow();
            sync();
        }});
    }

    /** Main-thread only. */
    private void closePanelNow() {
        panelRequested = false;
        ++panelAttempt;
        teardownPanelView();
        revokePanelTrust();
    }

    /** Main-thread only; used by the authenticated retry loop without cancelling user intent. */
    private void teardownPanelView() {
        if (panel != null) { removeView(panel); panel = null; }
        if (panelWebView != null) {
            try { panelWebView.stopLoading(); } catch (Throwable ignored) {}
            try { panelWebView.destroy(); } catch (Throwable ignored) {}
            panelWebView = null;
        }
    }

    private void restartPanelAuthentication(final long failedAttempt) {
        main.post(new Runnable() {
            @Override public void run() {
                if (destroyed || !panelRequested || failedAttempt != panelAttempt) return;
                teardownPanelView();
                revokePanelTrust();
                final long retryMarker = ++panelAttempt;
                main.postDelayed(new Runnable() {
                    @Override public void run() {
                        if (destroyed
                                || !panelRequested
                                || retryMarker != panelAttempt) {
                            return;
                        }
                        beginPanelAuthentication();
                    }
                }, AUTH_RETRY_MS);
            }
        });
    }

    private void revokePanelTrust() {
        ++panelRefreshId;
        ++panelDocumentProofId;
        panelDocumentAuthority.revoke();
        panelDocumentTrusted = false;
        panelDocumentAuthGeneration = 0;
        panelAuthorizedLoadGeneration = 0;
        panelDocumentNonce = null;
        panelAuthorizedDocumentNonce = null;
        panelAuthSession = null;
    }

    private boolean isPanelDocumentAuthenticated(WebView view) {
        return panelRequested
                && view != null
                && view == panelWebView
                && panelAuthSession != null
                && panelDocumentAuthGeneration == panelAuthSession.generation
                && panelDocumentNonce != null
                && panelDocumentAuthority.isBound(
                        panelAuthSession.generation,
                        panelAuthSession.serverInstanceId)
                && EvogentSecurityPolicy.isTrustedWebUrl(view.getUrl());
    }

    private boolean isPanelDocumentTrusted(WebView view) {
        return isPanelDocumentAuthenticated(view)
                && panelDocumentAuthority.isTrusted(
                        panelAuthSession.generation,
                        panelAuthSession.serverInstanceId);
    }

    private void verifyLoadedPanelDocument(
            final WebView loadedView,
            final String loadedUrl,
            final long expectedAttempt,
            final boolean documentStartInstalled) {
        if (destroyed
                || !panelRequested
                || expectedAttempt != panelAttempt
                || loadedView == null
                || loadedView != panelWebView
                || !EvogentSecurityPolicy.isTrustedWebUrl(loadedUrl)
                || panelAuthSession == null
                || panelDocumentNonce == null
                || !panelDocumentAuthority.isBound(
                        panelDocumentAuthGeneration,
                        panelAuthSession.serverInstanceId)) {
            restartPanelAuthentication(expectedAttempt);
            return;
        }
        final long proofId = ++panelDocumentProofId;
        final long expectedGeneration = panelDocumentAuthGeneration;
        final String expectedInstance = panelAuthSession.serverInstanceId;
        final String expectedNonce = panelDocumentNonce;
        EvogentLoopbackAuth.verifyServerAsync(
                service,
                expectedInstance,
                expectedNonce,
                new EvogentLoopbackAuth.ProofCallback() {
                    @Override public void onResult(boolean verified) {
                        if (destroyed
                                || !panelRequested
                                || expectedAttempt != panelAttempt
                                || proofId != panelDocumentProofId
                                || panelWebView != loadedView
                                || panelAuthSession == null
                                || panelAuthSession.generation != expectedGeneration
                                || !expectedInstance.equals(
                                        panelAuthSession.serverInstanceId)
                                || !expectedNonce.equals(panelDocumentNonce)
                                || !loadedUrl.equals(loadedView.getUrl())) {
                            return;
                        }
                        panelDocumentTrusted =
                                panelDocumentAuthority.confirmAfterLoad(
                                        expectedGeneration,
                                        expectedInstance,
                                        expectedNonce,
                                        verified);
                        if (!panelDocumentTrusted) {
                            restartPanelAuthentication(expectedAttempt);
                            return;
                        }
                        if (!documentStartInstalled) {
                            loadedView.evaluateJavascript(
                                    OVERLAY_FACADE_SCRIPT
                                    + "if(window.EvogentOverlay){"
                                    + "window.EvogentOverlay.setHeight("
                                    + "Math.max(document.documentElement.scrollHeight,110));}",
                                    null);
                        }
                        schedulePanelProofRefresh(expectedAttempt);
                    }
                });
    }

    private boolean authorizePanelNativeAction(WebView view, final long expectedAttempt) {
        if (!isPanelDocumentAuthenticated(view) || panelAuthSession == null) return false;
        final long generation = panelAuthSession.generation;
        final String expectedInstance = panelAuthSession.serverInstanceId;
        boolean verified = EvogentLoopbackAuth.verifyServerBlocking(
                service,
                expectedInstance,
                1800);
        boolean authorized = panelDocumentAuthority.authorizeBridge(
                generation,
                expectedInstance,
                verified);
        panelDocumentTrusted = authorized;
        if (!authorized) restartPanelAuthentication(expectedAttempt);
        return authorized;
    }

    private void schedulePanelProofRefresh(final long expectedAttempt) {
        final long refreshId = ++panelRefreshId;
        main.postDelayed(new Runnable() {
            @Override public void run() {
                if (destroyed
                        || !panelRequested
                        || expectedAttempt != panelAttempt
                        || refreshId != panelRefreshId
                        || !isPanelDocumentAuthenticated(panelWebView)) {
                    return;
                }
                final WebView expectedWebView = panelWebView;
                final EvogentLoopbackAuth.WebSession previousSession = panelAuthSession;
                EvogentLoopbackAuth.authenticateWeb(
                        service,
                        new EvogentLoopbackAuth.Callback() {
                            @Override public void onResult(
                                    EvogentLoopbackAuth.WebSession session,
                                    Exception error) {
                                if (destroyed
                                        || !panelRequested
                                        || expectedAttempt != panelAttempt
                                        || refreshId != panelRefreshId
                                        || panelWebView != expectedWebView) {
                                    return;
                                }
                                if (session == null
                                        || error != null
                                        || previousSession == null
                                        || !previousSession.serverInstanceId.equals(
                                                session == null
                                                        ? null
                                                        : session.serverInstanceId)
                                        || !isPanelDocumentAuthenticated(expectedWebView)
                                        || !panelDocumentAuthority.rebindSession(
                                                previousSession.generation,
                                                session == null ? 0 : session.generation,
                                                previousSession.serverInstanceId)) {
                                    restartPanelAuthentication(expectedAttempt);
                                    return;
                                }
                                panelAuthSession = session;
                                panelDocumentAuthGeneration = session.generation;
                                panelDocumentTrusted =
                                        panelDocumentAuthority.isTrusted(
                                                session.generation,
                                                session.serverInstanceId);
                                schedulePanelProofRefresh(expectedAttempt);
                            }
                        });
            }
        }, PERIODIC_PROOF_REFRESH_MS);
    }

    /**
     * Dispatch the overlay's synchronous prompt protocol after verifying both the calling frame
     * URL and the current top-level document. Unknown, malformed, and oversized calls fail closed.
     */
    private void handleOverlayPrompt(
            WebView view,
            String callerUrl,
            String payload,
            JsPromptResult result,
            OverlayActions actions) {
        if (!EvogentSecurityPolicy.isTrustedWebUrl(callerUrl)
                || !isPanelDocumentAuthenticated(view)
                || payload == null
                || payload.length() > EvogentSecurityPolicy.MAX_NATIVE_PROMPT_CHARS) {
            Log.w(TAG, "rejected untrusted or oversized overlay prompt");
            result.cancel();
            return;
        }
        try {
            JSONObject request = new JSONObject(payload);
            String method = request.optString("method", "");
            JSONArray args = request.optJSONArray("args");
            if (args == null) throw new IllegalArgumentException("missing args");
            boolean validOperation =
                    ("getScreenContext".equals(method) && args.length() == 0)
                    || ("setHeight".equals(method) && args.length() == 1)
                    || ("close".equals(method) && args.length() == 0)
                    || ("openApp".equals(method) && args.length() == 0);
            if (!validOperation || !authorizePanelNativeAction(view, panelAttempt)) {
                throw new IllegalArgumentException("unauthorized overlay operation");
            }

            if ("getScreenContext".equals(method) && args.length() == 0) {
                result.confirm(actions.getScreenContext());
                return;
            }
            if ("setHeight".equals(method) && args.length() == 1) {
                double rawHeight = args.optDouble(0, Double.NaN);
                if (Double.isNaN(rawHeight)
                        || Double.isInfinite(rawHeight)
                        || rawHeight <= 0
                        || rawHeight > 100000) {
                    throw new IllegalArgumentException("invalid height");
                }
                actions.setHeight((int) Math.round(rawHeight));
            } else if ("close".equals(method) && args.length() == 0) {
                actions.close();
            } else if ("openApp".equals(method) && args.length() == 0) {
                actions.openApp();
            } else {
                throw new IllegalArgumentException("unknown overlay operation");
            }
            result.confirm("");
        } catch (Throwable t) {
            Log.w(TAG, "rejected malformed overlay prompt");
            result.cancel();
        }
    }

    /** Native actions reachable only through the origin-checked prompt dispatcher above. */
    private final class OverlayActions {
        private final String contextJson;

        OverlayActions(String app, String text) {
            String json;
            try {
                JSONObject o = new JSONObject();
                o.put("app", app == null ? JSONObject.NULL : app);
                o.put("text", text == null ? "" : text);
                json = o.toString();
            } catch (Throwable t) { json = "{\"app\":null,\"text\":\"\"}"; }
            this.contextJson = json;
        }

        String getScreenContext() {
            return contextJson;
        }

        // The page reports how tall the bottom sheet should be (CSS px). Compact = just the
        // composer when nothing has been sent; taller once a thread is shown. We scale by the
        // display density and clamp so it never collapses or eats the whole screen.
        void setHeight(final int cssPx) {
            main.post(new Runnable() { public void run() {
                if (panel == null) return;
                float density = service.getResources().getDisplayMetrics().density;
                int screenH = service.getResources().getDisplayMetrics().heightPixels;
                int target = Math.round(cssPx * density);
                int clamped = Math.max(dp(110), Math.min(target, Math.round(screenH * 0.72f)));
                WindowManager.LayoutParams lp = (WindowManager.LayoutParams) panel.getLayoutParams();
                if (lp != null && lp.height != clamped) {
                    lp.height = clamped;
                    try { wm.updateViewLayout(panel, lp); } catch (Throwable ignored) {}
                }
            }});
        }

        void close() {
            closePanel();
        }

        void openApp() {
            main.post(new Runnable() { public void run() {
                try {
                    Intent i = new Intent(service, MainActivity.class);
                    i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    service.startActivity(i);
                } catch (Throwable t) { Log.e(TAG, "openApp", t); }
                closePanelNow();
                sync();
            }});
        }
    }

    // ---- window plumbing -----------------------------------------------------

    private void removeView(View v) {
        try { wm.removeView(v); } catch (Throwable ignored) {}
    }

    private WindowManager.LayoutParams overlayParams(int w, int h, boolean notFocusable) {
        // TYPE_APPLICATION_OVERLAY (the SYSTEM_ALERT_WINDOW / "chat head" type) is the only
        // window type that actually renders over OTHER apps on Android 16 AND accepts keyboard
        // focus so the composer's text field works. TYPE_ACCESSIBILITY_OVERLAY silently no-ops
        // over foreground apps on A16 (addView returns ok, nothing draws) and can't take input.
        // Requires the "Display over other apps" permission (SYSTEM_ALERT_WINDOW), granted once.
        WindowManager.LayoutParams lp = new WindowManager.LayoutParams(
                w, h,
                WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
                WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
                        | (notFocusable ? WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE : 0),
                PixelFormat.TRANSLUCENT);
        return lp;
    }

    private int dp(int v) {
        return Math.round(v * service.getResources().getDisplayMetrics().density);
    }
}

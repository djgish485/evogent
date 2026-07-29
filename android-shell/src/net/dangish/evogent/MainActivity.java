package net.dangish.evogent;

import android.Manifest;
import android.app.Activity;
import android.app.NotificationManager;
import android.content.BroadcastReceiver;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.Message;
import android.os.SystemClock;
import android.util.Log;
import android.view.Gravity;
import android.view.View;
import android.webkit.JsPromptResult;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Evogent home screen: renders the real Evogent web UI from the phone's loopback server.
 * Launcher behaviors are added around the WebView:
 *  - YouTube links (a video card's play / "Read original") open in the YouTube
 *    app via an ACTION_VIEW intent, falling back to the browser if the app
 *    can't handle it.
 *  - Native HOME recovery keeps Retry and the apps/stock-home escape usable when the private
 *    phone runtime is starting or unavailable.
 */
public class MainActivity extends Activity {
    private static final String FEED_URL = EvogentSecurityPolicy.LOOPBACK_ORIGIN;
    static final String ACTION_OPEN_EVOGENT_HOME =
            "net.dangish.evogent.action.OPEN_EVOGENT_HOME";
    static final String OPEN_NOTIFICATIONS_EXTRA = "evogent_open_notifications";
    private static final String HOME_CHOICE_PREFERENCES = "evogent_home_choice";
    private static final String HOME_CHOICE_KEY = "last_explicit_surface";
    private static final String NOTIFICATION_PERMISSION_PREFERENCES =
            "evogent_notification_permission";
    private static final String NOTIFICATION_PERMISSION_ASKED_KEY =
            "post_notifications_asked";
    private static final int NOTIFICATION_PERMISSION_REQUEST_CODE = 0x4556;
    private static final String LEGACY_OVERLAY_CHANNEL = "evogent_overlay";
    private static final int LEGACY_OVERLAY_NOTIFICATION_ID = 42;
    private static final String PAGE_BACK_SCRIPT =
            "(function(){'use strict';try{"
            + "if(typeof window.evogentHandleBack!=='function')return 'missing';"
            + "return window.evogentHandleBack()===true?'handled':'unhandled';"
            + "}catch(e){return 'error';}})();";
    private static final String SHELL_PROMPT_MARKER = "__EVOGENT_SHELL_V2__";
    private static final String ASSISTANT_PROMPT_MARKER = "__EVOGENT_ASSISTANT_V1__";
    private static final String SHELL_FACADE_SCRIPT =
            "(function(){'use strict';"
            + "if(window.top!==window||window.EvogentShell)return;"
            + "var nativePrompt=window.prompt.bind(window);"
            + "function call(method,args){return nativePrompt('" + SHELL_PROMPT_MARKER
            + "',JSON.stringify({method:method,args:args||[]}));}"
            + "Object.defineProperty(window,'EvogentShell',{"
            + "value:Object.freeze({"
            + "openExternal:function(url){return call('openExternal',[String(url)]);},"
            + "openAndroidHome:function(){return call('openAndroidHome',[]);},"
            + "dismissPhoneNotification:function(eventId){"
            + "return call('dismissPhoneNotification',[String(eventId)]);}"
            + "}),writable:false,configurable:false});"
            + "})();";
    private static final String ASSISTANT_COMPOSER_FACADE_SCRIPT =
            "(function(){'use strict';"
            + "if(window.top!==window||window.EvogentOverlay)return;"
            + "var nativePrompt=window.prompt.bind(window);"
            + "function call(method,args){return nativePrompt('" + ASSISTANT_PROMPT_MARKER
            + "',JSON.stringify({method:method,args:args||[]}));}"
            + "Object.defineProperty(window,'EvogentOverlay',{"
            + "value:Object.freeze({"
            + "getScreenContext:function(){return call('getScreenContext',[]);},"
            + "setHeight:function(px){return call('setHeight',[Number(px)]);},"
            + "close:function(){return call('close',[]);},"
            + "openApp:function(){return call('openApp',[]);}"
            + "}),writable:false,configurable:false});"
            + "})();";
    private static final String YT_PACKAGE = "com.google.android.youtube";
    private static final String IG_PACKAGE = "com.instagram.android";
    private static final String X_PACKAGE = "com.twitter.android";
    private static final String GM_PACKAGE = "com.google.android.gm";
    private static final String PIXEL_LAUNCHER_PACKAGE =
            "com.google.android.apps.nexuslauncher";
    private static final long SERVER_PROOF_MAX_AGE_MS = 5 * 60 * 1000L;
    private static final long FOREGROUND_REFRESH_AFTER_MS = 30 * 1000L;
    private static final long PERIODIC_REFRESH_MS = 4 * 60 * 1000L;
    private static final long AUTH_RETRY_MS = 2000L;
    private static final long RUNTIME_REVIVE_DEBOUNCE_MS = 2000L;
    // A HOME gesture must never strand the user behind a slow/hung private loopback process.
    private static final long SYSTEM_HOME_READY_TIMEOUT_MS = 2500L;
    private static final Pattern YT_ID = Pattern.compile(
            "(?:v=|/shorts/|youtu\\.be/|/embed/)([A-Za-z0-9_-]{11})");
    private WebView webView;
    private View recoverySurface;
    private TextView recoveryTitle;
    private TextView recoveryMessage;
    private ProgressBar recoveryProgress;
    private Button recoveryRetry;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final EvogentHomeNavigationPolicy homeNavigation =
            new EvogentHomeNavigationPolicy();
    private final EvogentHomeAvailabilityGate homeAvailability =
            new EvogentHomeAvailabilityGate();
    private boolean shellDocumentStartInstalled = false;
    private volatile boolean trustedFeedDocument = false;
    private EvogentLoopbackAuth.WebSession activeWebSession;
    private final EvogentDocumentAuthority documentAuthority =
            new EvogentDocumentAuthority();
    private long documentAuthGeneration;
    private long authorizedLoadGeneration;
    private String documentNonce;
    private String authorizedDocumentNonce;
    private long documentProofRequestId;
    private long authRequestId;
    private long backRequestId;
    private boolean authInFlight;
    private boolean backInFlight;
    private boolean pendingBackPress;
    private long lastRuntimeReviveRequestMs;
    private long systemHomeAvailabilityRequest;
    private SharedPreferences homeChoicePreferences;
    private boolean destroyed;
    private boolean pendingNotificationView;
    private final Runnable systemHomeReadyTimeout = new Runnable() {
        @Override public void run() {
            fallBackFromUnavailableSystemHome(
                    systemHomeAvailabilityRequest,
                    "authenticated surface readiness timed out");
        }
    };
    private final Runnable periodicProofRefresh = new Runnable() {
        @Override public void run() {
            if (destroyed || !resumed) return;
            if (isCurrentFeedDocumentAuthenticated()
                    && !hasFreshServerProof(PERIODIC_REFRESH_MS)
                    && !authInFlight) {
                refreshCurrentDocumentAuthentication(null);
            }
            main.postDelayed(this, PERIODIC_REFRESH_MS);
        }
    };

    /**
     * Keep the authenticated WebView alive across temporary foreground/background
     * transitions so returning from a native source preserves page and scroll state.
     * HOME's explicit reset path remains separate.
     */
    private boolean resumed = false;

    /** Root document for this hardened WebView host. The assistant overrides only this URL. */
    protected String rootDocumentUrl() {
        return FEED_URL;
    }

    /** True only for the role-holding launcher Activity, never the assistant-layer Activity. */
    protected boolean isHomeSurface() {
        return true;
    }

    /** The assistant subclass opts into the narrow EvogentOverlay composer bridge. */
    protected boolean supportsAssistantComposerBridge() {
        return false;
    }

    protected EvogentAssistantContextStore.ContextData consumeAssistantContext() {
        return new EvogentAssistantContextStore.ContextData(null, "");
    }

    protected void closeAssistantComposer() {
        // Main HOME never exposes the assistant composer bridge.
    }

    protected int recoveryEscapeLabelResource() {
        return R.string.home_recovery_apps;
    }

    protected void handleRecoveryEscape() {
        openAndroidHomeOrApps();
    }

    private String nativeFacadeScript() {
        return supportsAssistantComposerBridge()
                ? ASSISTANT_COMPOSER_FACADE_SCRIPT
                : SHELL_FACADE_SCRIPT;
    }

    /**
     * Classify launcher intents before touching WebView state.
     *
     * MAIN+LAUNCHER and the explicit return action choose Evogent. MAIN+HOME consults, but never
     * mutates, the remembered choice. Null, unknown-action, and ambiguous-category intents simply
     * stay in Evogent. If the stock launcher cannot be resolved/launched, the stale Android choice
     * is cleared before continuing here so a broken component can never create a HOME loop.
     */
    private boolean routeHomeIntent(Intent intent) {
        if (intent == null) return false;
        boolean isMain = Intent.ACTION_MAIN.equals(intent.getAction());
        boolean hasLauncher = intent.hasCategory(Intent.CATEGORY_LAUNCHER);
        boolean hasHome = intent.hasCategory(Intent.CATEGORY_HOME);
        boolean explicitReturn = ACTION_OPEN_EVOGENT_HOME.equals(intent.getAction());
        if (EvogentHomeChoicePolicy.explicitlyChoosesEvogent(
                isMain, hasLauncher, hasHome, explicitReturn)) {
            if (!rememberHomeChoice(EvogentHomeChoicePolicy.Choice.EVOGENT)) {
                Log.w("EvogentMain", "could not durably remember Evogent HOME");
            }
            return false;
        }
        if (!EvogentHomeChoicePolicy.shouldRouteSystemHomeToAndroid(
                isMain, hasHome, hasLauncher, rememberedHomeChoice())) {
            return false;
        }
        if (launchRememberedAndroidHome()) return true;
        Log.w("EvogentMain", "remembered Android HOME unavailable; staying in Evogent");
        return false;
    }

    private boolean isExplicitEvogentIntent(Intent intent) {
        if (intent == null) return false;
        return EvogentHomeChoicePolicy.explicitlyChoosesEvogent(
                Intent.ACTION_MAIN.equals(intent.getAction()),
                intent.hasCategory(Intent.CATEGORY_LAUNCHER),
                intent.hasCategory(Intent.CATEGORY_HOME),
                ACTION_OPEN_EVOGENT_HOME.equals(intent.getAction()));
    }

    private EvogentHomeChoicePolicy.Choice rememberedHomeChoice() {
        return EvogentHomeChoicePolicy.decode(homeChoicePreferences()
                .getString(HOME_CHOICE_KEY, EvogentHomeChoicePolicy.VALUE_EVOGENT));
    }

    private boolean rememberHomeChoice(EvogentHomeChoicePolicy.Choice choice) {
        return homeChoicePreferences().edit()
                .putString(HOME_CHOICE_KEY, EvogentHomeChoicePolicy.encode(choice))
                .commit();
    }

    private SharedPreferences homeChoicePreferences() {
        if (homeChoicePreferences == null) {
            homeChoicePreferences = getSharedPreferences(
                    HOME_CHOICE_PREFERENCES, Context.MODE_PRIVATE);
        }
        return homeChoicePreferences;
    }

    @Override
    protected void onResume() {
        super.onResume();
        maybeRequestNotificationPermissionOnce();
        resumed = true;
        main.removeCallbacks(periodicProofRefresh);
        main.postDelayed(periodicProofRefresh, PERIODIC_REFRESH_MS);
        if (isCurrentFeedDocumentAuthenticated()
                && !hasFreshServerProof(FOREGROUND_REFRESH_AFTER_MS)
                && !authInFlight) {
            refreshCurrentDocumentAuthentication(null);
        }
    }

    /**
     * Android 13+ requires a second grant before Evogent can publish its replacement digest.
     * Ask only after notification-listener access proves the user enabled this integration,
     * only on the HOME surface, and at most once. A denial is respected; without the permission
     * the listener's fail-safe keeps every Android original.
     */
    private void maybeRequestNotificationPermissionOnce() {
        if (!isHomeSurface()
                || webView == null
                || Build.VERSION.SDK_INT < 33
                || checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                        == PackageManager.PERMISSION_GRANTED) {
            return;
        }
        NotificationManager notifications =
                (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (notifications == null
                || !notifications.isNotificationListenerAccessGranted(
                        new ComponentName(
                                this,
                                EvogentNotificationListenerService.class))) return;
        SharedPreferences preferences = getSharedPreferences(
                NOTIFICATION_PERMISSION_PREFERENCES,
                Context.MODE_PRIVATE);
        if (preferences.getBoolean(NOTIFICATION_PERMISSION_ASKED_KEY, false)) return;
        if (!preferences.edit()
                .putBoolean(NOTIFICATION_PERMISSION_ASKED_KEY, true)
                .commit()) {
            return;
        }
        requestPermissions(
                new String[] { Manifest.permission.POST_NOTIFICATIONS },
                NOTIFICATION_PERMISSION_REQUEST_CODE);
    }

    @Override
    protected void onPause() {
        resumed = false;
        main.removeCallbacks(periodicProofRefresh);
        super.onPause();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        captureNotificationViewIntent(intent);
        boolean explicitEvogent = isHomeSurface() && isExplicitEvogentIntent(intent);
        if (isHomeSurface() && routeHomeIntent(intent)) {
            cancelSystemHomeAvailabilityWait();
            return;
        }
        boolean systemHome = isHomeSurface() && isSystemHomeIntent(intent);
        if (systemHome) {
            armSystemHomeAvailabilityWait();
        } else {
            // In particular, an explicit Evogent icon/action launch must not be redirected by a
            // stale timeout from an earlier system-HOME invocation.
            cancelSystemHomeAvailabilityWait();
        }
        if (explicitEvogent) {
            refreshExplicitEvogentLaunch();
            return;
        }
        dispatchPendingNotificationView();
        if (intent == null || !Intent.ACTION_MAIN.equals(intent.getAction())
                || !intent.hasCategory(Intent.CATEGORY_HOME) || webView == null) {
            return;
        }
        if (!isCurrentFeedDocumentAuthenticated()
                || (systemHome && !isCurrentFeedDocumentTrusted())) {
            // A merely bound/in-flight document is not a usable HOME surface. Keep the fresh
            // availability request armed until the replacement load passes its post-load proof.
            loadFeedRoot();
            return;
        }
        final boolean fullReset = resumed;
        if (systemHome) {
            final long availabilityRequest = systemHomeAvailabilityRequest;
            refreshCurrentDocumentAuthentication(new Runnable() {
                @Override public void run() {
                    // A timeout, a repeated HOME, or an explicit icon launch may have superseded
                    // this proof. Never dispatch JS for a stale availability request.
                    if (markSystemHomeUsable(availabilityRequest)) {
                        homeNavigation.markAuthenticatedDocumentReady();
                        renderRecoverySurface();
                        dispatchHomeGesture(fullReset);
                    }
                }
            });
            return;
        }
        if (!hasFreshServerProof(FOREGROUND_REFRESH_AFTER_MS)) {
            refreshCurrentDocumentAuthentication(new Runnable() {
                @Override public void run() {
                    dispatchHomeGesture(fullReset);
                }
            });
            return;
        }
        dispatchHomeGesture(fullReset);
    }

    /**
     * A singleTask launcher icon can return to an already-loaded WebView. Cover that cached
     * document and require a fresh process proof even when its previous proof is still inside the
     * ordinary foreground-age window. Otherwise a server that died while Pixel HOME was visible
     * could leave an explicit Evogent launch on stale web UI instead of native recovery.
     */
    private void refreshExplicitEvogentLaunch() {
        if (destroyed || webView == null) return;
        if (!isCurrentFeedDocumentTrusted()) {
            loadFeedRoot();
            return;
        }
        showRecoveryStarting();
        refreshCurrentDocumentAuthentication(new Runnable() {
            @Override public void run() {
                if (destroyed || webView == null || !isCurrentFeedDocumentTrusted()) return;
                homeNavigation.markAuthenticatedDocumentReady();
                renderRecoverySurface();
                dispatchPendingNotificationView();
            }
        });
    }

    private boolean isSystemHomeIntent(Intent intent) {
        if (intent == null) return false;
        return EvogentHomeChoicePolicy.isSystemHomeInvocation(
                Intent.ACTION_MAIN.equals(intent.getAction()),
                intent.hasCategory(Intent.CATEGORY_HOME),
                intent.hasCategory(Intent.CATEGORY_LAUNCHER));
    }

    private void armSystemHomeAvailabilityWait() {
        main.removeCallbacks(systemHomeReadyTimeout);
        // A cached proof can outlive a just-crashed loopback process. Every system-HOME return to
        // remembered Evogent therefore gets one fresh, bounded local proof before page dispatch.
        systemHomeAvailabilityRequest = homeAvailability.arm();
        main.postDelayed(systemHomeReadyTimeout, SYSTEM_HOME_READY_TIMEOUT_MS);
    }

    private boolean markSystemHomeUsable(long request) {
        if (!homeAvailability.markUsable(request)) return false;
        systemHomeAvailabilityRequest = 0L;
        main.removeCallbacks(systemHomeReadyTimeout);
        return true;
    }

    private boolean markCurrentSystemHomeUsable() {
        return markSystemHomeUsable(systemHomeAvailabilityRequest);
    }

    private void cancelSystemHomeAvailabilityWait() {
        homeAvailability.cancel();
        systemHomeAvailabilityRequest = 0L;
        main.removeCallbacks(systemHomeReadyTimeout);
    }

    /**
     * Definite authentication failure falls back immediately; the bounded timer handles a hung
     * authentication or a document that never reaches process-bound READY. Explicit icon launches
     * never arm the request and therefore remain on the native Retry / Android Home recovery UI.
     */
    private boolean fallBackFromUnavailableSystemHome(long request, String reason) {
        if (!isHomeSurface()
                || destroyed
                || homeAvailability.onUnavailable(request)
                        != EvogentHomeAvailabilityGate.Decision.FALL_BACK_TO_ANDROID) {
            return false;
        }
        systemHomeAvailabilityRequest = 0L;
        main.removeCallbacks(systemHomeReadyTimeout);
        requestRuntimeReviveIfDue();
        if (!launchAndroidHomeWithoutChangingChoice()) {
            Log.w("EvogentMain", "Android HOME fallback unavailable; native recovery remains");
            return false;
        }
        Log.i("EvogentMain", "system HOME fell back to Android: " + reason);
        finish();
        return true;
    }

    private void dispatchHomeGesture(final boolean fullReset) {
        if (!isCurrentFeedDocumentTrusted()) {
            loadFeedRoot();
            return;
        }
        webView.evaluateJavascript(
                "(function(){ if (window.evogentGoHome) { window.evogentGoHome(" + fullReset + "); return 'ok'; } return 'missing'; })()",
                new android.webkit.ValueCallback<String>() {
                    @Override public void onReceiveValue(String value) {
                        if (!"\"ok\"".equals(value)) {
                            Log.i("EvogentMain", "goHome hook missing (" + value + ") — reloading feed");
                            loadFeedRoot();
                        }
                    }
                });
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        captureNotificationViewIntent(getIntent());
        // An update from the legacy APK may leave its repeating browse PendingIntent behind.
        BrowseAlarmReceiver.cancelLegacySchedule(this);
        retireLegacyOverlayArtifacts();
        boolean systemHomeInvocation = isHomeSurface() && isSystemHomeIntent(getIntent());
        if (isHomeSurface() && routeHomeIntent(getIntent())) {
            // This was a cold system-HOME invocation while Android HOME was remembered. There
            // is no Evogent document state to preserve, so do not create an invisible WebView
            // task behind the stock launcher.
            cancelSystemHomeAvailabilityWait();
            finish();
            return;
        }

        webView = new WebView(this);
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setSupportMultipleWindows(true);
        s.setJavaScriptCanOpenWindowsAutomatically(true);
        EvogentLoopbackAuth.hardenWebViewCookies(webView);
        // The feed shell ("/") is served with an aggressive Cache-Control (s-maxage), so a
        // WebView that cached an old build keeps serving it and location.reload() (the
        // "App updated — tap to reload" banner) can't pull the new bundle. Content-hashed
        // _next chunks are safe to cache forever; the stale shell is the problem. Clear the
        // HTTP cache once per launch so every cold start (incl. the post-update relaunch)
        // loads the current server bundle.
        webView.clearCache(true);

        // Install a plain-JavaScript facade before any feed script runs. Unlike
        // addJavascriptInterface, this exposes no Java object to subframes. The exact-origin
        // document-start rule and per-call onJsPrompt frame URL check are both required.
        shellDocumentStartInstalled =
                NativeWebBridge.installAtDocumentStart(webView, nativeFacadeScript());

        // Direct navigations to an external site (a plain link) route out.
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
                // A scripted/user-content iframe must never turn its own navigation into a
                // privileged native-app launch. Only the top frame is routed out.
                if (req == null || req.getUrl() == null || !req.isForMainFrame()) return false;
                String target = req.getUrl().toString();
                if (EvogentSecurityPolicy.isTrustedWebUrl(target)) {
                    if (authorizedLoadGeneration != 0
                            && activeWebSession != null
                            && authorizedLoadGeneration == activeWebSession.generation) {
                        return false;
                    }
                    authenticateAndLoad(target, 0);
                    return true;
                }
                if (!isCurrentFeedDocumentAuthenticated()
                        || !req.hasGesture()
                        || !authorizeCurrentDocumentForNativeAction()) {
                    Log.w("EvogentMain", "rejected external navigation without a user gesture");
                    return true;
                }
                return routeIfExternal(target);
            }
            @Override
            public void onPageStarted(WebView v, String url, android.graphics.Bitmap favicon) {
                boolean authenticated = EvogentSecurityPolicy.isTrustedWebUrl(url)
                        && activeWebSession != null
                        && authorizedLoadGeneration == activeWebSession.generation
                        && authorizedDocumentNonce != null
                        && documentAuthority.isBound(
                                authorizedLoadGeneration,
                                activeWebSession.serverInstanceId)
                        && activeWebSession.isFresh(SERVER_PROOF_MAX_AGE_MS);
                documentAuthGeneration = authenticated ? authorizedLoadGeneration : 0;
                documentNonce = authenticated ? authorizedDocumentNonce : null;
                authorizedLoadGeneration = 0;
                authorizedDocumentNonce = null;
                trustedFeedDocument = false;
                if (!authenticated) documentAuthority.revoke();
            }
            @Override
            public void onPageFinished(WebView v, String url) {
                verifyLoadedDocument(v, url);
            }
            @Override
            public void onReceivedError(WebView v, WebResourceRequest req, WebResourceError err) {
                // The local feed server may not be up when the WebView first loads it — most
                // visibly right after a reboot, where the WebView (home screen) starts before the
                // on-device server finishes booting, so the main-frame load fails with
                // ERR_CONNECTION_REFUSED. The default "webpage not available" page never retries,
                // leaving the user staring at a dead feed until they manually relaunch. Auto-retry
                // the feed load every 2s; each failed retry re-enters here, so this self-limits and
                // stops the moment the server answers.
                if (req != null && req.isForMainFrame()
                        && req.getUrl() != null
                        && EvogentSecurityPolicy.isTrustedWebUrl(req.getUrl().toString())) {
                    int errorCode = err == null ? -1 : err.getErrorCode();
                    Log.i("EvogentMain", "feed load failed (" + errorCode
                            + ") — retrying in 2s");
                    handleAuthenticatedMainFrameFailure(req.getUrl().toString());
                }
            }
            @Override
            public void onReceivedHttpError(
                    WebView v,
                    WebResourceRequest req,
                    WebResourceResponse response) {
                if (req != null
                        && req.isForMainFrame()
                        && req.getUrl() != null
                        && EvogentSecurityPolicy.isTrustedWebUrl(req.getUrl().toString())) {
                    int statusCode = response == null ? -1 : response.getStatusCode();
                    if (EvogentLoopbackAuth.isPhoneSessionGateResponse(response)
                            || EvogentHomeNavigationPolicy.rejectsMainFrameHttpStatus(statusCode)) {
                        Log.i("EvogentMain", "feed HTTP " + statusCode
                                + " — keeping native recovery available");
                        handleAuthenticatedMainFrameFailure(req.getUrl().toString());
                    }
                }
            }
        });

        // window.open(...) and target="_blank" links (the card's play button and
        // "Read original") arrive here; grab their URL and route it out.
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onCreateWindow(WebView view, boolean isDialog,
                                          boolean isUserGesture, Message resultMsg) {
                if (!isCurrentFeedDocumentAuthenticated()
                        || !authorizeCurrentDocumentForNativeAction()
                        || !isUserGesture || resultMsg == null
                        || !(resultMsg.obj instanceof WebView.WebViewTransport)) {
                    Log.w("EvogentMain", "rejected popup without a user gesture");
                    return false;
                }
                final WebView catcher = new WebView(view.getContext());
                EvogentLoopbackAuth.hardenWebViewCookies(catcher);
                catcher.setWebViewClient(new WebViewClient() {
                    private boolean handled;

                    private void captureDestination(WebView v, String target) {
                        if (handled || "about:blank".equals(target)) return;
                        handled = true;
                        v.stopLoading();
                        v.post(new Runnable() {
                            @Override public void run() {
                                try { v.destroy(); } catch (Throwable ignored) {}
                            }
                        });
                        if (EvogentSecurityPolicy.isSafeExternalWebUrl(target)
                                && !EvogentSecurityPolicy.isTrustedWebUrl(target)) {
                            openExternal(target);
                        } else {
                            Log.w("EvogentMain", "rejected unsafe popup destination");
                        }
                    }

                    @Override
                    public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
                        String target = req != null && req.getUrl() != null
                                ? req.getUrl().toString() : null;
                        captureDestination(v, target);
                        return true;
                    }

                    @Override
                    public void onPageStarted(
                            WebView v,
                            String url,
                            android.graphics.Bitmap favicon) {
                        // Some WebView builds deliver the first popup URL as a page callback
                        // without shouldOverrideUrlLoading. Capture it and tear the catcher down.
                        captureDestination(v, url);
                    }
                });
                ((WebView.WebViewTransport) resultMsg.obj).setWebView(catcher);
                resultMsg.sendToTarget();
                return true;
            }

            @Override
            public boolean onJsPrompt(
                    WebView view,
                    String url,
                    String message,
                    String defaultValue,
                    JsPromptResult result) {
                if (!SHELL_PROMPT_MARKER.equals(message)
                        && !ASSISTANT_PROMPT_MARKER.equals(message)) {
                    return super.onJsPrompt(view, url, message, defaultValue, result);
                }
                handleShellPrompt(message, url, defaultValue, result);
                return true;
            }
        });

        FrameLayout root = new FrameLayout(this);
        root.addView(webView, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        recoverySurface = createRecoverySurface();
        root.addView(recoverySurface, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        setContentView(root);
        renderRecoverySurface();

        // The web shell renders the intentional Android-home switch in its own control row.
        // No persistent or app-wide floating control is created by this Activity.
        if (systemHomeInvocation) {
            armSystemHomeAvailabilityWait();
        } else {
            cancelSystemHomeAvailabilityWait();
        }
        loadFeedRoot();

        // Shizuku bridge for the privileged ops (create hidden display + launch app).
        // Triggered by a token-gated broadcast from the on-device Termux phone helper.
        shizuku = new ShizukuController(this);
        registerReceiver(shizukuReceiver, new IntentFilter("net.dangish.evogent.SHIZUKU"),
                Context.RECEIVER_EXPORTED);
    }

    /** Remove the old bubble service's orphaned ongoing notification/channel after upgrade. */
    private void retireLegacyOverlayArtifacts() {
        try {
            NotificationManager notifications =
                    (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (notifications == null) return;
            notifications.cancel(LEGACY_OVERLAY_NOTIFICATION_ID);
            if (Build.VERSION.SDK_INT >= 26) {
                notifications.deleteNotificationChannel(LEGACY_OVERLAY_CHANNEL);
            }
        } catch (Throwable error) {
            Log.w("EvogentMain", "legacy overlay notification cleanup failed");
        }
    }

    /**
     * Build the launcher's recovery UI entirely in native Android views. It stays opaque and
     * above an INVISIBLE WebView until the loaded document has passed the process-bound proof,
     * so an unavailable or hostile loopback listener cannot counterfeit Retry or the app escape.
     */
    private View createRecoverySurface() {
        FrameLayout surface = new FrameLayout(this);
        surface.setBackgroundColor(Color.rgb(5, 5, 5));
        surface.setClickable(true);
        surface.setFocusable(true);
        surface.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_YES);

        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setGravity(Gravity.CENTER_HORIZONTAL);
        int horizontalPadding = dp(28);
        panel.setPadding(horizontalPadding, dp(28), horizontalPadding, dp(28));

        TextView brand = new TextView(this);
        brand.setText(getString(R.string.app_name));
        brand.setTextColor(Color.rgb(161, 161, 170));
        brand.setTextSize(12);
        brand.setLetterSpacing(0.18f);
        brand.setGravity(Gravity.CENTER);
        panel.addView(brand, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT));

        recoveryProgress = new ProgressBar(this);
        recoveryProgress.setIndeterminate(true);
        recoveryProgress.setIndeterminateTintList(
                ColorStateList.valueOf(Color.rgb(125, 211, 252)));
        LinearLayout.LayoutParams progressParams =
                new LinearLayout.LayoutParams(dp(34), dp(34));
        progressParams.topMargin = dp(26);
        panel.addView(recoveryProgress, progressParams);

        recoveryTitle = new TextView(this);
        recoveryTitle.setTextColor(Color.WHITE);
        recoveryTitle.setTextSize(24);
        recoveryTitle.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams titleParams = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT);
        titleParams.topMargin = dp(18);
        panel.addView(recoveryTitle, titleParams);

        recoveryMessage = new TextView(this);
        recoveryMessage.setTextColor(Color.rgb(161, 161, 170));
        recoveryMessage.setTextSize(15);
        recoveryMessage.setGravity(Gravity.CENTER);
        recoveryMessage.setLineSpacing(0, 1.12f);
        LinearLayout.LayoutParams messageParams = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT);
        messageParams.topMargin = dp(10);
        panel.addView(recoveryMessage, messageParams);

        LinearLayout actions = new LinearLayout(this);
        actions.setOrientation(LinearLayout.HORIZONTAL);
        actions.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams actionsParams = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT);
        actionsParams.topMargin = dp(28);
        panel.addView(actions, actionsParams);

        recoveryRetry = new Button(this);
        recoveryRetry.setText(R.string.home_recovery_retry);
        recoveryRetry.setAllCaps(false);
        recoveryRetry.setTextColor(Color.rgb(8, 47, 73));
        recoveryRetry.setBackgroundTintList(
                ColorStateList.valueOf(Color.rgb(125, 211, 252)));
        recoveryRetry.setMinHeight(dp(48));
        recoveryRetry.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View ignored) {
                retryFeedFromRecovery();
            }
        });
        LinearLayout.LayoutParams retryParams =
                new LinearLayout.LayoutParams(0, dp(50), 1f);
        actions.addView(recoveryRetry, retryParams);

        Button apps = new Button(this);
        apps.setText(recoveryEscapeLabelResource());
        apps.setAllCaps(false);
        apps.setTextColor(Color.rgb(244, 244, 245));
        apps.setBackgroundTintList(
                ColorStateList.valueOf(Color.rgb(39, 39, 42)));
        apps.setMinHeight(dp(48));
        apps.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View ignored) {
                handleRecoveryEscape();
            }
        });
        LinearLayout.LayoutParams appsParams =
                new LinearLayout.LayoutParams(0, dp(50), 1f);
        appsParams.leftMargin = dp(10);
        actions.addView(apps, appsParams);

        FrameLayout.LayoutParams panelParams = new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.WRAP_CONTENT,
                Gravity.CENTER);
        panelParams.leftMargin = dp(16);
        panelParams.rightMargin = dp(16);
        surface.addView(panel, panelParams);
        return surface;
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private void showRecoveryStarting() {
        homeNavigation.showStarting();
        renderRecoverySurface();
    }

    private void showRecoveryError() {
        homeNavigation.showError();
        renderRecoverySurface();
    }

    private void renderRecoverySurface() {
        if (recoverySurface == null || webView == null) return;
        if (!homeNavigation.shouldShowRecoverySurface()) {
            recoverySurface.setVisibility(View.GONE);
            webView.setVisibility(View.VISIBLE);
            webView.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_AUTO);
            return;
        }

        webView.setVisibility(View.INVISIBLE);
        webView.setImportantForAccessibility(
                View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
        recoverySurface.setVisibility(View.VISIBLE);
        recoverySurface.bringToFront();

        boolean error = homeNavigation.recoveryState()
                == EvogentHomeNavigationPolicy.RecoveryState.ERROR;
        recoveryTitle.setText(error
                ? R.string.home_recovery_error_title
                : R.string.home_recovery_starting_title);
        recoveryMessage.setText(error
                ? R.string.home_recovery_error_message
                : R.string.home_recovery_starting_message);
        recoveryProgress.setVisibility(error ? View.INVISIBLE : View.VISIBLE);
        recoveryRetry.setEnabled(error);
        recoveryRetry.setAlpha(error ? 1f : 0.5f);
    }

    private void retryFeedFromRecovery() {
        if (destroyed || webView == null) return;
        requestRuntimeReviveIfDue();
        ++authRequestId;
        authInFlight = false;
        ++backRequestId;
        backInFlight = false;
        revokeDocumentTrust();
        showRecoveryStarting();
        webView.stopLoading();
        authenticateAndLoad(rootDocumentUrl(), 0);
    }

    private void requestRuntimeReviveIfDue() {
        long now = SystemClock.elapsedRealtime();
        if (lastRuntimeReviveRequestMs == 0
                || now - lastRuntimeReviveRequestMs >= RUNTIME_REVIVE_DEBOUNCE_MS) {
            lastRuntimeReviveRequestMs = now;
            BootReceiver.dispatchRecoveryOrBoot(this);
        }
    }

    private ShizukuController shizuku;

    private String controlToken() {
        try {
            return EvogentControlToken.loadOrCreate(this);
        } catch (Throwable ignored) {}
        return null;
    }

    private final BroadcastReceiver shizukuReceiver = new BroadcastReceiver() {
        @Override public void onReceive(Context c, Intent i) {
            String op = i.getStringExtra("op");
            // Same per-install secret as the accessibility control channel: launching apps onto
            // hidden displays is privileged, so gate it too.
            String tok = controlToken();
            if (!EvogentSecurityPolicy.tokenMatches(tok, i.getStringExtra("token"))) {
                Log.w("EvoShizuku", "rejected SHIZUKU op=" + op + " — bad/absent control token");
                return;
            }
            Log.i("EvoShizuku", "SHIZUKU op=" + op + " alive=" + shizuku.shizukuAlive());
            // op=launch (or legacy op=browse): create a hidden trusted display and launch an
            // arbitrary app onto it. pkg/activity default to YouTube for back-compat. The
            // resulting display id is logged AND written to files/hidden-display.txt so a chat
            // on-device agent can pick it up and drive that display in the background.
            if ("launch".equals(op) || "browse".equals(op)) {
                String pkg = i.getStringExtra("pkg");
                String activity = i.getStringExtra("activity");
                if (pkg == null) {
                    pkg = "com.google.android.youtube";
                    activity = "com.google.android.apps.youtube.app.WatchWhileActivity";
                }
                final String fpkg = pkg;
                shizuku.createHiddenAndLaunch(pkg, activity, new ShizukuController.OnDisplay() {
                    @Override public void ready(int id) {
                        Log.i("EvoShizuku", "hidden display ready id=" + id + " pkg=" + fpkg);
                        try {
                            java.io.File out = new java.io.File(getExternalFilesDir(null), "hidden-display.txt");
                            java.io.FileOutputStream fos = new java.io.FileOutputStream(out);
                            fos.write((id + " " + fpkg + "\n").getBytes("UTF-8"));
                            fos.close();
                        } catch (Exception ignored) {}
                    }
                });
            }
        }
    };

    /** Keep the exact loopback feed origin in the WebView; send everything else out. */
    private boolean routeIfExternal(String url) {
        if (EvogentSecurityPolicy.isTrustedWebUrl(url)) return false;
        if (EvogentSecurityPolicy.isSafeExternalWebUrl(url)) {
            openExternal(url);
        } else {
            Log.w("EvogentMain", "rejected unsafe top-frame navigation");
        }
        return true;
    }

    private boolean isCurrentFeedDocumentTrusted() {
        return isCurrentFeedDocumentAuthenticated()
                && documentAuthority.isTrusted(
                        activeWebSession.generation,
                        activeWebSession.serverInstanceId);
    }

    private boolean isCurrentFeedDocumentAuthenticated() {
        return webView != null
                && activeWebSession != null
                && documentAuthGeneration == activeWebSession.generation
                && documentNonce != null
                && documentAuthority.isBound(
                        activeWebSession.generation,
                        activeWebSession.serverInstanceId)
                && EvogentSecurityPolicy.isTrustedWebUrl(webView.getUrl());
    }

    private boolean hasFreshServerProof(long maxAgeMs) {
        return activeWebSession != null && activeWebSession.isFresh(maxAgeMs);
    }

    private void loadFeedRoot() {
        showRecoveryStarting();
        authenticateAndLoad(rootDocumentUrl(), 0);
    }

    /**
     * Never point the privileged WebView at loopback until the process currently holding the port
     * has proved the device secret and the WebView cookie write has completed.
     */
    private void authenticateAndLoad(final String targetUrl, long delayMs) {
        if (destroyed || webView == null) return;
        if (delayMs > 0) {
            final long scheduledRequestId = ++authRequestId;
            authInFlight = false;
            main.postDelayed(new Runnable() {
                @Override public void run() {
                    if (destroyed || scheduledRequestId != authRequestId) return;
                    authenticateAndLoad(targetUrl, 0);
                }
            }, delayMs);
            return;
        }
        final long requestId = ++authRequestId;
        ++backRequestId;
        backInFlight = false;
        authInFlight = true;
        homeNavigation.beginAutomaticAttempt();
        renderRecoverySurface();
        revokeDocumentTrust();
        webView.stopLoading();
        EvogentLoopbackAuth.authenticateWeb(this, new EvogentLoopbackAuth.Callback() {
            @Override public void onResult(
                    EvogentLoopbackAuth.WebSession session,
                    Exception error) {
                if (destroyed || requestId != authRequestId || webView == null) return;
                authInFlight = false;
                if (session == null || error != null) {
                    Log.i("EvogentMain", "loopback authentication unavailable — retrying");
                    showRecoveryError();
                    if (fallBackFromUnavailableSystemHome(
                            systemHomeAvailabilityRequest,
                            "loopback authentication unavailable")) {
                        return;
                    }
                    authenticateAndLoad(targetUrl, AUTH_RETRY_MS);
                    return;
                }
                activeWebSession = session;
                authorizedLoadGeneration = session.generation;
                authorizedDocumentNonce = EvogentLoopbackAuth.newDocumentNonce();
                documentAuthority.begin(
                        session.generation,
                        session.serverInstanceId,
                        authorizedDocumentNonce);
                webView.loadUrl(targetUrl);
            }
        });
    }

    /**
     * Refresh server identity on focus and periodically while the launcher is visible. A failed
     * proof revokes native authority immediately and returns to the authenticated load loop.
     */
    private void refreshCurrentDocumentAuthentication(final Runnable afterSuccess) {
        if (destroyed || webView == null) return;
        final long requestId = ++authRequestId;
        final String expectedUrl = webView.getUrl();
        final boolean expectedTrusted = isCurrentFeedDocumentAuthenticated();
        final EvogentLoopbackAuth.WebSession previousSession = activeWebSession;
        authInFlight = true;
        EvogentLoopbackAuth.authenticateWeb(this, new EvogentLoopbackAuth.Callback() {
            @Override public void onResult(
                    EvogentLoopbackAuth.WebSession session,
                    Exception error) {
                if (destroyed || requestId != authRequestId || webView == null) return;
                authInFlight = false;
                if (session == null || error != null
                        || !expectedTrusted
                        || previousSession == null
                        || expectedUrl == null
                        || !expectedUrl.equals(webView.getUrl())
                        || !previousSession.serverInstanceId.equals(
                                session == null ? null : session.serverInstanceId)
                        || !documentAuthority.rebindSession(
                                previousSession.generation,
                                session == null ? 0 : session.generation,
                                previousSession.serverInstanceId)) {
                    revokeDocumentTrust();
                    showRecoveryError();
                    if (fallBackFromUnavailableSystemHome(
                            systemHomeAvailabilityRequest,
                            "server identity refresh failed")) {
                        return;
                    }
                    authenticateAndLoad(rootDocumentUrl(), AUTH_RETRY_MS);
                    return;
                }
                activeWebSession = session;
                documentAuthGeneration = session.generation;
                trustedFeedDocument = documentAuthority.isTrusted(
                        session.generation,
                        session.serverInstanceId);
                if (afterSuccess != null) afterSuccess.run();
                drainPendingBackPress();
            }
        });
    }

    private void handleAuthenticatedMainFrameFailure(String failedUrl) {
        revokeDocumentTrust();
        showRecoveryError();
        if (fallBackFromUnavailableSystemHome(
                systemHomeAvailabilityRequest,
                "authenticated document failed")) {
            return;
        }
        if (authInFlight) return;
        String retryUrl = EvogentSecurityPolicy.isTrustedWebUrl(failedUrl)
                ? failedUrl
                : rootDocumentUrl();
        authenticateAndLoad(retryUrl, AUTH_RETRY_MS);
    }

    private void revokeDocumentTrust() {
        ++documentProofRequestId;
        documentAuthority.revoke();
        trustedFeedDocument = false;
        documentAuthGeneration = 0;
        authorizedLoadGeneration = 0;
        documentNonce = null;
        authorizedDocumentNonce = null;
    }

    private void verifyLoadedDocument(final WebView loadedView, final String loadedUrl) {
        // stopLoading() can still deliver onPageFinished for the document we just replaced.
        // Do not let that stale callback revoke the newer authenticated load between its cookie
        // handshake and onPageStarted.
        boolean authenticatedLoadPending = activeWebSession != null
                && authorizedLoadGeneration == activeWebSession.generation
                && authorizedDocumentNonce != null;
        if (authenticatedLoadPending) return;
        if (destroyed
                || loadedView == null
                || loadedView != webView
                || !EvogentSecurityPolicy.isTrustedWebUrl(loadedUrl)
                || activeWebSession == null
                || documentNonce == null
                || !documentAuthority.isBound(
                        documentAuthGeneration,
                        activeWebSession.serverInstanceId)) {
            revokeDocumentTrust();
            showRecoveryError();
            if (fallBackFromUnavailableSystemHome(
                    systemHomeAvailabilityRequest,
                    "loaded document was not authenticated")) {
                return;
            }
            if (!authInFlight) {
                authenticateAndLoad(rootDocumentUrl(), AUTH_RETRY_MS);
            }
            return;
        }
        final long proofRequestId = ++documentProofRequestId;
        final long expectedGeneration = documentAuthGeneration;
        final String expectedInstance = activeWebSession.serverInstanceId;
        final String expectedNonce = documentNonce;
        EvogentLoopbackAuth.verifyServerAsync(
                this,
                expectedInstance,
                expectedNonce,
                new EvogentLoopbackAuth.ProofCallback() {
                    @Override public void onResult(boolean verified) {
                        if (destroyed
                                || proofRequestId != documentProofRequestId
                                || webView != loadedView
                                || activeWebSession == null
                                || activeWebSession.generation != expectedGeneration
                                || !expectedInstance.equals(
                                        activeWebSession.serverInstanceId)
                                || !expectedNonce.equals(documentNonce)
                                || !loadedUrl.equals(webView.getUrl())) {
                            return;
                        }
                        trustedFeedDocument = documentAuthority.confirmAfterLoad(
                                expectedGeneration,
                                expectedInstance,
                                expectedNonce,
                                verified);
                        if (!trustedFeedDocument) {
                            handleAuthenticatedMainFrameFailure(loadedUrl);
                            return;
                        }
                        homeNavigation.markAuthenticatedDocumentReady();
                        markCurrentSystemHomeUsable();
                        renderRecoverySurface();
                        dispatchPendingNotificationView();
                        if (backInFlight) backInFlight = false;
                        drainPendingBackPress();
                        // Compatibility fallback is injected only after the loaded document has
                        // proved the same server process that authorized its navigation.
                        if (!shellDocumentStartInstalled) {
                            webView.evaluateJavascript(nativeFacadeScript(), null);
                        }
                    }
                });
    }

    private boolean authorizeCurrentDocumentForNativeAction() {
        if (!isCurrentFeedDocumentAuthenticated() || activeWebSession == null) return false;
        final long generation = activeWebSession.generation;
        final String expectedInstance = activeWebSession.serverInstanceId;
        boolean verified = EvogentLoopbackAuth.verifyServerBlocking(
                this,
                expectedInstance,
                1800);
        boolean authorized = documentAuthority.authorizeBridge(
                generation,
                expectedInstance,
                verified);
        trustedFeedDocument = authorized;
        if (!authorized) {
            main.post(new Runnable() {
                @Override public void run() {
                    if (!destroyed) {
                        revokeDocumentTrust();
                        showRecoveryError();
                        authenticateAndLoad(rootDocumentUrl(), AUTH_RETRY_MS);
                    }
                }
            });
        }
        return authorized;
    }

    /**
     * Handle the shell's synchronous prompt protocol. onJsPrompt supplies the URL of the frame
     * that called prompt, so a sandboxed/cross-origin iframe cannot inherit top-frame authority.
     */
    private void handleShellPrompt(
            String marker,
            String callerUrl,
            String payload,
            JsPromptResult result) {
        if (!EvogentSecurityPolicy.isTrustedWebUrl(callerUrl)
                || !isCurrentFeedDocumentAuthenticated()
                || payload == null
                || payload.length() > EvogentSecurityPolicy.MAX_NATIVE_PROMPT_CHARS) {
            Log.w("EvogentMain", "rejected untrusted or oversized shell prompt");
            result.cancel();
            return;
        }
        try {
            JSONObject request = new JSONObject(payload);
            String method = request.optString("method", "");
            JSONArray args = request.optJSONArray("args");
            boolean shellPrompt = SHELL_PROMPT_MARKER.equals(marker);
            boolean assistantPrompt = ASSISTANT_PROMPT_MARKER.equals(marker)
                    && supportsAssistantComposerBridge();
            boolean validOperation =
                    (shellPrompt
                            && "openExternal".equals(method)
                            && args != null
                            && args.length() == 1)
                    || (shellPrompt
                            && "openAndroidHome".equals(method)
                            && args != null
                            && args.length() == 0)
                    || (shellPrompt
                            && "dismissPhoneNotification".equals(method)
                            && args != null
                            && args.length() == 1)
                    || (assistantPrompt
                            && "getScreenContext".equals(method)
                            && args != null
                            && args.length() == 0)
                    || (assistantPrompt
                            && "setHeight".equals(method)
                            && args != null
                            && args.length() == 1)
                    || (assistantPrompt
                            && "close".equals(method)
                            && args != null
                            && args.length() == 0)
                    || (assistantPrompt
                            && "openApp".equals(method)
                            && args != null
                            && args.length() == 0);
            if (!validOperation || !authorizeCurrentDocumentForNativeAction()) {
                throw new IllegalArgumentException("unauthorized shell operation");
            }
            if ("openExternal".equals(method) && args != null && args.length() == 1) {
                String target = args.optString(0, null);
                if (!EvogentSecurityPolicy.isSafeExternalWebUrl(target)
                        || EvogentSecurityPolicy.isTrustedWebUrl(target)) {
                    throw new IllegalArgumentException("unsafe external URL");
                }
                openExternal(target);
            } else if ("openAndroidHome".equals(method)
                    && args != null
                    && args.length() == 0) {
                openAndroidHome();
            } else if ("dismissPhoneNotification".equals(method)
                    && args != null
                    && args.length() == 1) {
                boolean dismissed = EvogentNotificationListenerService.requestUserDismiss(
                        args.optString(0, ""));
                result.confirm(dismissed ? "dismissed" : "preserved");
                return;
            } else if ("getScreenContext".equals(method)
                    && args != null
                    && args.length() == 0
                    && supportsAssistantComposerBridge()) {
                EvogentAssistantContextStore.ContextData context =
                        consumeAssistantContext();
                JSONObject response = new JSONObject();
                response.put("app", context.app == null ? JSONObject.NULL : context.app);
                response.put("text", context.text);
                result.confirm(response.toString());
                return;
            } else if ("setHeight".equals(method)
                    && args != null
                    && args.length() == 1
                    && supportsAssistantComposerBridge()) {
                // The assistant Activity already occupies its system-managed layer. Validate the
                // composer page's sizing call, then intentionally leave Activity sizing to Android.
                double height = args.optDouble(0, Double.NaN);
                if (Double.isNaN(height)
                        || Double.isInfinite(height)
                        || height <= 0
                        || height > 100000) {
                    throw new IllegalArgumentException("invalid composer height");
                }
            } else if ("close".equals(method)
                    && args != null
                    && args.length() == 0
                    && supportsAssistantComposerBridge()) {
                closeAssistantComposer();
            } else if ("openApp".equals(method)
                    && args != null
                    && args.length() == 0
                    && supportsAssistantComposerBridge()) {
                Intent openHome = new Intent(this, MainActivity.class)
                        .setAction(ACTION_OPEN_EVOGENT_HOME)
                        .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP
                                | Intent.FLAG_ACTIVITY_SINGLE_TOP);
                startActivity(openHome);
                closeAssistantComposer();
            } else {
                throw new IllegalArgumentException("unknown shell operation");
            }
            result.confirm("");
        } catch (Throwable t) {
            Log.w("EvogentMain", "rejected malformed shell prompt");
            result.cancel();
        }
    }

    private void captureNotificationViewIntent(Intent intent) {
        if (!isHomeSurface()
                || intent == null
                || !intent.getBooleanExtra(OPEN_NOTIFICATIONS_EXTRA, false)) {
            return;
        }
        pendingNotificationView = true;
        intent.removeExtra(OPEN_NOTIFICATIONS_EXTRA);
    }

    private void dispatchPendingNotificationView() {
        if (!pendingNotificationView
                || webView == null
                || !isCurrentFeedDocumentTrusted()) {
            return;
        }
        webView.evaluateJavascript(
                "(function(){try{"
                + "sessionStorage.setItem('evogent.openNotifications','1');"
                + "window.dispatchEvent(new Event('evogent:open-notifications'));"
                + "return 'ok';"
                + "}catch(e){return 'error';}})()",
                new android.webkit.ValueCallback<String>() {
                    @Override public void onReceiveValue(String value) {
                        if ("\"ok\"".equals(value)) pendingNotificationView = false;
                    }
                });
    }

    /**
     * Open supported content in its installed native app when possible, with a
     * validated browser fallback for destinations that have no native handler.
     */
    private void openExternal(String url) {
        if (!EvogentSecurityPolicy.isSafeExternalWebUrl(url)
                || EvogentSecurityPolicy.isTrustedWebUrl(url)) {
            Log.w("EvogentMain", "refused unsafe external URL");
            return;
        }
        String host;
        try {
            host = Uri.parse(url).getHost();
        } catch (Exception e) {
            host = null;
        }
        host = host == null ? "" : host.toLowerCase();

        if (hostMatches(host, "youtube.com") || hostMatches(host, "youtu.be")) {
            // Deep-link into the YouTube app by video id when we can parse one.
            String id = youTubeId(url);
            if (startInApp(new Intent(Intent.ACTION_VIEW,
                    Uri.parse(id != null ? "vnd.youtube:" + id : url)), YT_PACKAGE)) {
                return;
            }
        } else if (hostMatches(host, "instagram.com")) {
            // Instagram registers its https links as App Links, so a package-targeted
            // ACTION_VIEW opens the post or profile directly in the app.
            if (startInApp(new Intent(Intent.ACTION_VIEW, Uri.parse(url)), IG_PACKAGE)) {
                return;
            }
        } else if (hostMatches(host, "x.com") || hostMatches(host, "twitter.com")) {
            if (startInApp(new Intent(Intent.ACTION_VIEW, Uri.parse(url)), X_PACKAGE)) {
                return;
            }
        } else if (hostMatches(host, "mail.google.com") || hostMatches(host, "gmail.com")) {
            // Gmail's web URL is not an App Link, so a package-targeted ACTION_VIEW would just
            // re-open the browser. Cards carry web URLs of the form .../#search/<query> (subject
            // or rfc822msgid: search) — hand that query to the Gmail app's own in-app search so
            // the tap lands on the exact message, not the inbox. No search fragment (or search
            // unresolvable) → the app's inbox; no app → browser.
            String query = gmailSearchQuery(url);
            if (query != null) {
                Intent search = new Intent(Intent.ACTION_SEARCH);
                search.setPackage(GM_PACKAGE);
                search.putExtra("query", query);
                if (startInApp(search, GM_PACKAGE)) {
                    return;
                }
            }
            Intent gmail = getPackageManager().getLaunchIntentForPackage(GM_PACKAGE);
            if (gmail != null) {
                gmail.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                try {
                    startActivity(gmail);
                    return;
                } catch (Exception ignored) {
                    // fall through to browser
                }
            }
        }

        try {
            Intent browser = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            browser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(browser);
        } catch (Exception ignored) {
        }
    }

    /** True when host equals domain or is a subdomain of it (never a partial substring). */
    private boolean hostMatches(String host, String domain) {
        return host.equals(domain) || host.endsWith("." + domain);
    }

    /** Extract the decoded query from a Gmail web URL's #search/<query> fragment, or null. */
    private String gmailSearchQuery(String url) {
        int hash = url.indexOf('#');
        if (hash < 0) return null;
        String fragment = url.substring(hash + 1);
        if (!fragment.startsWith("search/")) return null;
        String encoded = fragment.substring("search/".length());
        if (encoded.isEmpty()) return null;
        try {
            return java.net.URLDecoder.decode(encoded, "UTF-8");
        } catch (Exception e) {
            return null;
        }
    }

    /** Try to start `intent` targeted at `pkg`; return true if it launched. */
    private boolean startInApp(Intent intent, String pkg) {
        intent.setPackage(pkg);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        if (intent.resolveActivity(getPackageManager()) != null) {
            try {
                startActivity(intent);
                return true;
            } catch (Exception ignored) {
                // fall through to caller's browser fallback
            }
        }
        return false;
    }

    private String youTubeId(String url) {
        Matcher m = YT_ID.matcher(url);
        return m.find() ? m.group(1) : null;
    }

    /**
     * Explicitly choose the stock launcher. Evogent remains Android's sole HOME role holder, but
     * subsequent HOME gestures proxy back to this remembered surface until the user explicitly
     * opens Evogent again.
     */
    private void openAndroidHome() {
        if (!isCurrentFeedDocumentTrusted()) return;
        openAndroidHomeOrApps();
    }

    /**
     * Native-only escape used by the recovery surface. Web content cannot call this method
     * directly; the shell prompt still goes through openAndroidHome() and a fresh process proof.
     */
    private void openAndroidHomeOrApps() {
        if (chooseAndLaunchAndroidHome()) return;
        // Do not remember a launcher that does not exist. The native drawer remains a safe escape
        // while the next HOME gesture stays in a usable Evogent launcher.
        startActivity(new Intent(MainActivity.this, AppDrawerActivity.class));
    }

    /**
     * Resolve first, synchronously commit the Android choice, and only then start the resolved
     * component. An implicit HOME Intent would resolve right back to Evogent because Android
     * permits only one default HOME holder.
     */
    private boolean chooseAndLaunchAndroidHome() {
        return EvogentHomeChoicePolicy.chooseAndLaunchAndroidHome(
                androidHomeActions());
    }

    /** Follow remembered Android intent without rewriting the preference on each HOME gesture. */
    private boolean launchRememberedAndroidHome() {
        return EvogentHomeChoicePolicy.launchRememberedAndroidHome(
                androidHomeActions());
    }

    /**
     * Server-down failover is availability recovery, not an explicit surface choice. Keep
     * last_explicit_surface untouched so a transient outage cannot silently rewrite user intent.
     */
    private boolean launchAndroidHomeWithoutChangingChoice() {
        return EvogentHomeChoicePolicy.launchAndroidHomeWithoutChangingChoice(
                androidHomeActions());
    }

    private EvogentHomeChoicePolicy.AndroidHomeActions<ComponentName> androidHomeActions() {
        return new EvogentHomeChoicePolicy.AndroidHomeActions<ComponentName>() {
            @Override public ComponentName resolve() {
                return resolveStockAndroidHome();
            }

            @Override public boolean persist(
                    EvogentHomeChoicePolicy.Choice choice) {
                return rememberHomeChoice(choice);
            }

            @Override public boolean launch(ComponentName target) {
                return launchResolvedAndroidHome(target);
            }
        };
    }

    private ComponentName resolveStockAndroidHome() {
        Intent home = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME);
        android.content.pm.ResolveInfo pixel = null;
        android.content.pm.ResolveInfo system = null;
        for (android.content.pm.ResolveInfo ri
                : getPackageManager().queryIntentActivities(home, 0)) {
            if (ri.activityInfo != null
                    && !getPackageName().equals(ri.activityInfo.packageName)) {
                if (PIXEL_LAUNCHER_PACKAGE.equals(ri.activityInfo.packageName)) {
                    pixel = ri;
                    break;
                }
                boolean isSystemHome = ri.activityInfo.applicationInfo != null
                        && (ri.activityInfo.applicationInfo.flags
                                & android.content.pm.ApplicationInfo.FLAG_SYSTEM) != 0;
                if (isSystemHome && system == null) system = ri;
            }
        }
        android.content.pm.ResolveInfo pick = pixel != null
                ? pixel
                : system;
        return pick == null
                ? null
                : new ComponentName(
                        pick.activityInfo.packageName,
                        pick.activityInfo.name);
    }

    private boolean launchResolvedAndroidHome(ComponentName target) {
        if (target == null || getPackageName().equals(target.getPackageName())) return false;
        try {
            startActivity(new Intent(Intent.ACTION_MAIN)
                    .addCategory(Intent.CATEGORY_HOME)
                    .setComponent(target)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            return true;
        } catch (Throwable ignored) {
            // The package changed between resolution and launch. The transaction restores
            // Evogent's choice before exposing the native drawer/recovery surface.
            return false;
        }
    }

    @Override
    public void onBackPressed() {
        if (destroyed || webView == null) return;
        if (backInFlight || authInFlight) {
            pendingBackPress = true;
            return;
        }
        pendingBackPress = false;
        if (!isCurrentFeedDocumentTrusted()
                || activeWebSession == null
                || documentNonce == null) {
            loadFeedRoot();
            return;
        }

        // Back is offered first to the current proved document so React can unwind its visible
        // modal/detail/chat stack without throwing away feed scroll or conversation state. The
        // proof is fresh and bound to the same server process; a port takeover fails closed into
        // native recovery instead of receiving a page-level action.
        final long requestId = ++backRequestId;
        final long expectedGeneration = activeWebSession.generation;
        final String expectedInstance = activeWebSession.serverInstanceId;
        final String expectedDocumentNonce = documentNonce;
        final String expectedUrl = webView.getUrl();
        backInFlight = true;
        EvogentLoopbackAuth.verifyServerAsync(
                this,
                expectedInstance,
                expectedDocumentNonce,
                new EvogentLoopbackAuth.ProofCallback() {
                    @Override public void onResult(boolean verified) {
                        if (destroyed
                                || requestId != backRequestId
                                || webView == null) {
                            return;
                        }
                        boolean sameDocument = activeWebSession != null
                                && activeWebSession.generation == expectedGeneration
                                && expectedInstance.equals(activeWebSession.serverInstanceId)
                                && expectedDocumentNonce.equals(documentNonce)
                                && expectedUrl != null
                                && expectedUrl.equals(webView.getUrl());
                        boolean authorized = sameDocument
                                && documentAuthority.authorizeBridge(
                                        expectedGeneration,
                                        expectedInstance,
                                        verified);
                        trustedFeedDocument = authorized;
                        if (!authorized) {
                            backInFlight = false;
                            handleAuthenticatedMainFrameFailure(expectedUrl);
                            return;
                        }
                        evaluateAuthenticatedPageBack(requestId, expectedGeneration, expectedUrl);
                    }
                });
        // Home screen: no path in this method calls super.onBackPressed() or finish().
    }

    private void drainPendingBackPress() {
        if (destroyed
                || !pendingBackPress
                || backInFlight
                || authInFlight
                || !isCurrentFeedDocumentTrusted()) {
            return;
        }
        pendingBackPress = false;
        main.post(new Runnable() {
            @Override public void run() {
                if (!destroyed) onBackPressed();
            }
        });
    }

    private void evaluateAuthenticatedPageBack(
            final long requestId,
            final long expectedGeneration,
            final String expectedUrl) {
        if (webView == null) {
            backInFlight = false;
            loadFeedRoot();
            return;
        }
        webView.evaluateJavascript(PAGE_BACK_SCRIPT, new android.webkit.ValueCallback<String>() {
            @Override public void onReceiveValue(String value) {
                if (destroyed || requestId != backRequestId || webView == null) return;
                boolean sameDocument = activeWebSession != null
                        && activeWebSession.generation == expectedGeneration
                        && expectedUrl != null
                        && expectedUrl.equals(webView.getUrl())
                        && isCurrentFeedDocumentTrusted();
                if (sameDocument
                        && EvogentHomeNavigationPolicy.pageHandledBack(value)) {
                    backInFlight = false;
                    drainPendingBackPress();
                    return;
                }
                navigateTrustedWebHistoryOrRoot();
            }
        });
    }

    private void navigateTrustedWebHistoryOrRoot() {
        if (destroyed || webView == null) {
            backInFlight = false;
            return;
        }
        String previousUrl = previousTrustedHistoryUrl();
        if (previousUrl != null) {
            authenticateAndTraverseBack(webView.getUrl(), previousUrl);
            return;
        }

        // This Activity is HOME. Back at the base document is intentionally a no-op: reloading
        // root would discard feed scroll, while finish()/super would exit the launcher.
        backInFlight = false;
        drainPendingBackPress();
    }

    private String previousTrustedHistoryUrl() {
        if (webView == null || !webView.canGoBack()) return null;
        android.webkit.WebBackForwardList history = webView.copyBackForwardList();
        int previousIndex = history.getCurrentIndex() - 1;
        android.webkit.WebHistoryItem previousItem = previousIndex >= 0
                ? history.getItemAtIndex(previousIndex)
                : null;
        String previousUrl = previousItem == null ? null : previousItem.getUrl();
        return EvogentSecurityPolicy.isTrustedWebUrl(previousUrl) ? previousUrl : null;
    }

    /**
     * Authenticate the current loopback process, then traverse the existing WebView history.
     * Calling loadUrl(previousUrl) would append a new entry and make Back toggle A→B→A forever.
     */
    private void authenticateAndTraverseBack(
            final String expectedCurrentUrl,
            final String expectedPreviousUrl) {
        if (destroyed || webView == null) {
            backInFlight = false;
            return;
        }

        final long requestId = ++authRequestId;
        authInFlight = true;
        homeNavigation.beginAutomaticAttempt();
        renderRecoverySurface();
        revokeDocumentTrust();
        EvogentLoopbackAuth.authenticateWeb(this, new EvogentLoopbackAuth.Callback() {
            @Override public void onResult(
                    EvogentLoopbackAuth.WebSession session,
                    Exception error) {
                if (destroyed || requestId != authRequestId || webView == null) return;
                authInFlight = false;
                String actualPreviousUrl = previousTrustedHistoryUrl();
                boolean historyUnchanged = expectedCurrentUrl != null
                        && expectedCurrentUrl.equals(webView.getUrl())
                        && expectedPreviousUrl.equals(actualPreviousUrl);
                if (session == null || error != null || !historyUnchanged) {
                    backInFlight = false;
                    showRecoveryError();
                    authenticateAndLoad(rootDocumentUrl(), AUTH_RETRY_MS);
                    return;
                }

                activeWebSession = session;
                authorizedLoadGeneration = session.generation;
                authorizedDocumentNonce = EvogentLoopbackAuth.newDocumentNonce();
                documentAuthority.begin(
                        session.generation,
                        session.serverInstanceId,
                        authorizedDocumentNonce);
                webView.goBack();
            }
        });
    }

    @Override
    protected void onDestroy() {
        destroyed = true;
        ++authRequestId;
        ++backRequestId;
        authInFlight = false;
        backInFlight = false;
        pendingBackPress = false;
        revokeDocumentTrust();
        main.removeCallbacksAndMessages(null);
        try { unregisterReceiver(shizukuReceiver); } catch (Throwable ignored) {}
        if (shizuku != null) shizuku.shutdown();
        if (webView != null) {
            try { webView.stopLoading(); } catch (Throwable ignored) {}
            try { webView.destroy(); } catch (Throwable ignored) {}
            webView = null;
        }
        recoverySurface = null;
        recoveryTitle = null;
        recoveryMessage = null;
        recoveryProgress = null;
        recoveryRetry = null;
        super.onDestroy();
    }
}

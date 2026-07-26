package net.dangish.evogent;

import android.os.Build;
import android.util.Log;
import android.webkit.WebView;

import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.util.Arrays;

/**
 * Installs a JavaScript facade at document start without exposing a Java object to page frames.
 *
 * Android's addJavascriptInterface injects the object into every frame and does not identify the
 * calling frame to Java. The WebView provider's DOCUMENT_START_SCRIPT compatibility feature can
 * instead install a plain-JavaScript facade only for an exact origin. Calls then travel through
 * WebChromeClient.onJsPrompt, which supplies the calling frame URL for a second origin check.
 *
 * This project deliberately builds without Gradle. The small reflection adapter below follows the
 * same versioned WebView-provider compatibility boundary used by AndroidX WebKit, avoiding a network
 * dependency in the APK build. If the provider does not advertise the versioned feature, this
 * fails closed; callers may install a main-frame-only, post-load facade as a degraded fallback.
 */
final class NativeWebBridge {
    private static final String TAG = "EvogentWeb";
    private static final String DOCUMENT_START_FEATURE = "DOCUMENT_START_SCRIPT:1";

    private NativeWebBridge() {}

    static boolean installAtDocumentStart(WebView webView, String script) {
        if (webView == null || script == null) return false;
        try {
            ClassLoader providerLoader = providerClassLoader();
            Class<?> glue = Class.forName(
                    "org.chromium.support_lib_glue.SupportLibReflectionUtil",
                    true,
                    providerLoader);
            Method createFactory = glue.getDeclaredMethod("createWebViewProviderFactory");
            InvocationHandler factoryHandler =
                    (InvocationHandler) createFactory.invoke(null);

            Class<?> factoryInterface = Class.forName(
                    "org.chromium.support_lib_boundary.WebViewProviderFactoryBoundaryInterface",
                    false,
                    providerLoader);
            Object factory = Proxy.newProxyInstance(
                    providerLoader,
                    new Class<?>[]{factoryInterface},
                    factoryHandler);

            String[] features = (String[]) factoryInterface
                    .getMethod("getSupportedFeatures")
                    .invoke(factory);
            if (features == null
                    || !Arrays.asList(features).contains(DOCUMENT_START_FEATURE)) {
                Log.e(TAG, "WebView lacks exact-origin document-start script support");
                return false;
            }

            InvocationHandler webViewHandler = (InvocationHandler) factoryInterface
                    .getMethod("createWebView", WebView.class)
                    .invoke(factory, webView);
            Class<?> webViewInterface = Class.forName(
                    "org.chromium.support_lib_boundary.WebViewProviderBoundaryInterface",
                    false,
                    providerLoader);
            Object provider = Proxy.newProxyInstance(
                    providerLoader,
                    new Class<?>[]{webViewInterface},
                    webViewHandler);
            webViewInterface
                    .getMethod("addDocumentStartJavaScript", String.class, String[].class)
                    .invoke(
                            provider,
                            script,
                            new String[]{EvogentSecurityPolicy.LOOPBACK_ORIGIN});
            return true;
        } catch (Throwable t) {
            Log.e(TAG, "could not install exact-origin document-start facade", t);
            return false;
        }
    }

    private static ClassLoader providerClassLoader() throws Exception {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            return WebView.getWebViewClassLoader();
        }
        // AndroidX WebKit uses this pre-P compatibility path. Hidden-API enforcement does not
        // apply on the platform versions that need it.
        Method getFactory = WebView.class.getDeclaredMethod("getFactory");
        getFactory.setAccessible(true);
        Object factory = getFactory.invoke(null);
        if (factory == null) throw new IllegalStateException("WebView factory unavailable");
        return factory.getClass().getClassLoader();
    }
}

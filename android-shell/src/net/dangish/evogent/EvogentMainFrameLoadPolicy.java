package net.dangish.evogent;

import java.util.ArrayList;
import java.util.List;

/**
 * Pure-Java identity binding for authenticated WebView main-frame navigations.
 *
 * WebView callbacks do not expose an Android navigation id, and a cancelled load may report a
 * same-URL error after a newer HOME invocation has started. Each native-authorized navigation
 * therefore carries a content-free generation and the exact HOME availability request that owned
 * it in reserved query parameters. Late callbacks retain their old binding and cannot consume a
 * newer HOME request.
 */
final class EvogentMainFrameLoadPolicy {
    private static final String LOAD_PARAMETER = "__evogent_load";
    private static final String HOME_PARAMETER = "__evogent_home";

    static final class Binding {
        final long loadGeneration;
        final long homeAvailabilityRequest;

        Binding(long loadGeneration, long homeAvailabilityRequest) {
            this.loadGeneration = loadGeneration;
            this.homeAvailabilityRequest = homeAvailabilityRequest;
        }

        boolean matches(Binding other) {
            return other != null
                    && loadGeneration == other.loadGeneration
                    && homeAvailabilityRequest == other.homeAvailabilityRequest;
        }
    }

    private EvogentMainFrameLoadPolicy() {}

    static String bind(String targetUrl, long loadGeneration, long homeAvailabilityRequest) {
        if (targetUrl == null
                || loadGeneration <= 0L
                || homeAvailabilityRequest < 0L) {
            throw new IllegalArgumentException("invalid main-frame load binding");
        }

        int fragmentIndex = targetUrl.indexOf('#');
        String fragment = fragmentIndex >= 0 ? targetUrl.substring(fragmentIndex) : "";
        String withoutFragment =
                fragmentIndex >= 0 ? targetUrl.substring(0, fragmentIndex) : targetUrl;
        int queryIndex = withoutFragment.indexOf('?');
        String path = queryIndex >= 0
                ? withoutFragment.substring(0, queryIndex)
                : withoutFragment;
        String query = queryIndex >= 0
                ? withoutFragment.substring(queryIndex + 1)
                : "";

        List<String> retained = new ArrayList<String>();
        if (!query.isEmpty()) {
            String[] parts = query.split("&", -1);
            for (String part : parts) {
                String key = queryKey(part);
                if (!LOAD_PARAMETER.equals(key) && !HOME_PARAMETER.equals(key)) {
                    retained.add(part);
                }
            }
        }
        retained.add(LOAD_PARAMETER + "=" + loadGeneration);
        retained.add(HOME_PARAMETER + "=" + homeAvailabilityRequest);

        StringBuilder result = new StringBuilder(path).append('?');
        for (int index = 0; index < retained.size(); index++) {
            if (index > 0) result.append('&');
            result.append(retained.get(index));
        }
        return result.append(fragment).toString();
    }

    static Binding parse(String callbackUrl) {
        if (callbackUrl == null) return null;
        int fragmentIndex = callbackUrl.indexOf('#');
        String withoutFragment =
                fragmentIndex >= 0 ? callbackUrl.substring(0, fragmentIndex) : callbackUrl;
        int queryIndex = withoutFragment.indexOf('?');
        if (queryIndex < 0 || queryIndex + 1 >= withoutFragment.length()) return null;

        Long loadGeneration = null;
        Long homeAvailabilityRequest = null;
        String[] parts = withoutFragment.substring(queryIndex + 1).split("&", -1);
        for (String part : parts) {
            int equals = part.indexOf('=');
            if (equals < 0) continue;
            String key = part.substring(0, equals);
            String value = part.substring(equals + 1);
            if (LOAD_PARAMETER.equals(key)) {
                if (loadGeneration != null) return null;
                loadGeneration = parseCanonicalLong(value, false);
                if (loadGeneration == null) return null;
            } else if (HOME_PARAMETER.equals(key)) {
                if (homeAvailabilityRequest != null) return null;
                homeAvailabilityRequest = parseCanonicalLong(value, true);
                if (homeAvailabilityRequest == null) return null;
            }
        }
        if (loadGeneration == null || homeAvailabilityRequest == null) return null;
        return new Binding(loadGeneration, homeAvailabilityRequest);
    }

    static boolean acceptsPendingStart(Binding pending, Binding callback) {
        return pending != null && pending.matches(callback);
    }

    /**
     * Android documents onPageStarted as firing once per main-frame load. Once a pending native
     * load has consumed its one start callback, another start with the active binding is therefore
     * a renderer-initiated reload/reuse of that URL, not a duplicate callback from the same load.
     */
    static boolean isRendererReloadOfActiveDocument(Binding active, Binding callback) {
        return active != null && active.matches(callback);
    }

    private static String queryKey(String part) {
        int equals = part.indexOf('=');
        return equals < 0 ? part : part.substring(0, equals);
    }

    private static Long parseCanonicalLong(String value, boolean allowZero) {
        if (value == null || value.isEmpty()) return null;
        if (value.length() > 1 && value.charAt(0) == '0') return null;
        long parsed = 0L;
        for (int index = 0; index < value.length(); index++) {
            char digit = value.charAt(index);
            if (digit < '0' || digit > '9') return null;
            int numeric = digit - '0';
            if (parsed > (Long.MAX_VALUE - numeric) / 10L) return null;
            parsed = parsed * 10L + numeric;
        }
        if (!allowZero && parsed == 0L) return null;
        return parsed;
    }
}

package net.dangish.evogent;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.webkit.CookieManager;
import android.webkit.ValueCallback;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.Arrays;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Authenticated client for Evogent's phone-only loopback server.
 *
 * Android apps share a network namespace, so 127.0.0.1 alone is not server identity. Before a
 * WebView loads anything privileged, or a native component sends an ingest request, this client
 * verifies a fresh server HMAC challenge and completes a process-bound session exchange. The
 * durable control token never crosses the socket and no authentication material is logged.
 */
final class EvogentLoopbackAuth {
    interface Callback {
        void onResult(WebSession session, Exception error);
    }

    interface ProofCallback {
        void onResult(boolean verified);
    }

    static final class WebSession {
        final long generation;
        final long verifiedAtElapsedMs;
        final String serverInstanceId;

        private WebSession(
                long generation,
                long verifiedAtElapsedMs,
                String serverInstanceId) {
            this.generation = generation;
            this.verifiedAtElapsedMs = verifiedAtElapsedMs;
            this.serverInstanceId = serverInstanceId;
        }

        boolean isFresh(long maxAgeMs) {
            long age = SystemClock.elapsedRealtime() - verifiedAtElapsedMs;
            return age >= 0 && age <= maxAgeMs;
        }
    }

    private static final String ORIGIN = EvogentSecurityPolicy.LOOPBACK_ORIGIN;
    private static final String CHALLENGE_URL = ORIGIN + "/api/phone-auth/challenge";
    private static final String COMPLETE_URL = ORIGIN + "/api/phone-auth/complete";
    private static final String COOKIE_NAME = "evogent_phone_session";
    private static final String AUTH_SCHEME = "EvogentSession ";
    private static final int MAX_AUTH_RESPONSE_BYTES = 16 * 1024;
    private static final int DEFAULT_AUTH_STAGE_TIMEOUT_MS = 6000;
    private static final int MIN_DIRECT_RETRY_REMAINING_MS = 300;
    private static final long MAX_CHALLENGE_FUTURE_MS = 2 * 60 * 1000L;
    private static final long MAX_DIRECT_SESSION_FUTURE_MS = 2 * 60 * 1000L;
    private static final long MAX_WEB_SESSION_FUTURE_MS = 2 * 24 * 60 * 60 * 1000L;
    private static final SecureRandom RANDOM = new SecureRandom();
    private static final AtomicLong GENERATIONS = new AtomicLong();
    private static final Handler MAIN = new Handler(Looper.getMainLooper());

    private EvogentLoopbackAuth() {}

    /**
     * Authenticate a reusable WebView session, install its host-only HttpOnly cookie, and invoke
     * the callback only after CookieManager confirms that the write has completed.
     */
    static void authenticateWeb(final Context context, final Callback callback) {
        final Context appContext = context.getApplicationContext();
        new Thread(new Runnable() {
            @Override public void run() {
                try {
                    final SessionMaterial material = authenticate(appContext, "web");
                    final long verifiedAt = SystemClock.elapsedRealtime();
                    MAIN.post(new Runnable() {
                        @Override public void run() {
                            CookieManager cookies = CookieManager.getInstance();
                            cookies.setAcceptCookie(true);
                            long remainingSeconds = Math.max(
                                    1L,
                                    (material.sessionExpiresAtMs
                                            - System.currentTimeMillis()) / 1000L);
                            String cookie = COOKIE_NAME + "=" + material.sessionToken
                                    + "; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age="
                                    + remainingSeconds;
                            cookies.setCookie(ORIGIN, cookie, new ValueCallback<Boolean>() {
                                @Override public void onReceiveValue(Boolean installed) {
                                    if (!Boolean.TRUE.equals(installed)) {
                                        callback.onResult(
                                                null,
                                                new AuthException("cookie_install_failed", -1));
                                        return;
                                    }
                                    CookieManager.getInstance().flush();
                                    callback.onResult(
                                            new WebSession(
                                                    GENERATIONS.incrementAndGet(),
                                                    verifiedAt,
                                                    material.serverInstanceId),
                                            null);
                                }
                            });
                        }
                    });
                } catch (final Exception error) {
                    MAIN.post(new Runnable() {
                        @Override public void run() {
                            callback.onResult(null, error);
                        }
                    });
                }
            }
        }, "evogent-web-auth").start();
    }

    static void hardenWebViewCookies(WebView webView) {
        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(webView, false);
    }

    static String newDocumentNonce() {
        return randomLowerHex(32);
    }

    /**
     * Bind a loaded document to the exact server process authenticated before its load. The
     * caller supplies the document's one-time nonce as the challenge nonce, so a proof cannot be
     * replayed across loads even within the same server process.
     */
    static void verifyServerAsync(
            final Context context,
            final String expectedServerInstanceId,
            final String documentNonce,
            final ProofCallback callback) {
        final Context appContext = context.getApplicationContext();
        new Thread(new Runnable() {
            @Override public void run() {
                final boolean verified = verifyServer(
                        appContext,
                        expectedServerInstanceId,
                        documentNonce,
                        2000);
                MAIN.post(new Runnable() {
                    @Override public void run() {
                        callback.onResult(verified);
                    }
                });
            }
        }, "evogent-document-proof").start();
    }

    /**
     * Every privileged prompt calls this immediately before native action. Matching only the URL
     * or a prior proof is insufficient after a hostile app takes over the shared loopback port.
     * Network work runs off the WebView/UI thread; the caller waits for a tightly bounded result.
     */
    static boolean verifyServerBlocking(
            final Context context,
            final String expectedServerInstanceId,
            long waitTimeoutMs) {
        if (!EvogentLoopbackAuthProtocol.isLowerHex(expectedServerInstanceId, 32)) return false;
        final AtomicBoolean verified = new AtomicBoolean(false);
        final CountDownLatch complete = new CountDownLatch(1);
        new Thread(new Runnable() {
            @Override public void run() {
                try {
                    verified.set(verifyServer(
                            context.getApplicationContext(),
                            expectedServerInstanceId,
                            newDocumentNonce(),
                            1200));
                } finally {
                    complete.countDown();
                }
            }
        }, "evogent-bridge-proof").start();
        try {
            return complete.await(waitTimeoutMs, TimeUnit.MILLISECONDS) && verified.get();
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            return false;
        }
    }

    static boolean isPhoneSessionGateResponse(WebResourceResponse response) {
        if (response == null || response.getStatusCode() != 401) return false;
        Map<String, String> headers = response.getResponseHeaders();
        if (headers == null) return false;
        for (Map.Entry<String, String> header : headers.entrySet()) {
            if ("WWW-Authenticate".equalsIgnoreCase(header.getKey())
                    && "EvogentPhoneSession".equals(header.getValue())) {
                return true;
            }
        }
        return false;
    }

    /**
     * Send JSON using a freshly authenticated, single-use direct session. A gate 401 consumes the
     * session without reaching the route, so one new handshake + identical retry is safe for the
     * browse-cache submissions used by the notification and share components.
     */
    static int postJsonDirect(
            Context context,
            String targetUrl,
            String json,
            int connectTimeoutMs,
            int readTimeoutMs) throws Exception {
        return postJsonDirectResponse(
                context,
                targetUrl,
                json,
                connectTimeoutMs,
                readTimeoutMs).status;
    }

    /**
     * Authenticated direct POST whose small JSON response is itself part of the safety protocol.
     * Notification replacement uses this to bind cancellation to the exact event the server
     * durably persisted; callers must still validate every echoed field.
     */
    static JSONObject postJsonDirectForJson(
            Context context,
            String targetUrl,
            String json,
            int connectTimeoutMs,
            int readTimeoutMs) throws Exception {
        DirectResponse response = postJsonDirectResponse(
                context,
                targetUrl,
                json,
                connectTimeoutMs,
                readTimeoutMs);
        if (response.status != HttpURLConnection.HTTP_OK || response.body == null) {
            throw new AuthException("direct_http_error", response.status);
        }
        return new JSONObject(response.body);
    }

    /**
     * Notification-only direct request whose challenge, completion, optional gate retry, and route
     * POST all share one monotonic deadline. Every stage receives only the remaining time.
     */
    static JSONObject postJsonDirectForJsonBefore(
            Context context,
            String targetUrl,
            String json,
            long deadlineElapsedRealtimeMs) throws Exception {
        DirectResponse response = postJsonDirectResponseBefore(
                context,
                targetUrl,
                json,
                deadlineElapsedRealtimeMs);
        if (response.status != HttpURLConnection.HTTP_OK || response.body == null) {
            throw new AuthException("direct_http_error", response.status);
        }
        JSONObject parsed = new JSONObject(response.body);
        requireRemainingDeadlineMs(deadlineElapsedRealtimeMs);
        return parsed;
    }

    /**
     * Direct JSON POST with caller-specific independent stage timeouts. Callers that need a true
     * end-to-end bound use the monotonic-deadline overload above; WebView and share callers retain
     * the more patient default overload.
     */
    static JSONObject postJsonDirectForJson(
            Context context,
            String targetUrl,
            String json,
            int connectTimeoutMs,
            int readTimeoutMs,
            int authStageTimeoutMs) throws Exception {
        DirectResponse response = postJsonDirectResponse(
                context,
                targetUrl,
                json,
                connectTimeoutMs,
                readTimeoutMs,
                authStageTimeoutMs);
        if (response.status != HttpURLConnection.HTTP_OK || response.body == null) {
            throw new AuthException("direct_http_error", response.status);
        }
        return new JSONObject(response.body);
    }

    private static DirectResponse postJsonDirectResponse(
            Context context,
            String targetUrl,
            String json,
            int connectTimeoutMs,
            int readTimeoutMs) throws Exception {
        return postJsonDirectResponse(
                context,
                targetUrl,
                json,
                connectTimeoutMs,
                readTimeoutMs,
                DEFAULT_AUTH_STAGE_TIMEOUT_MS);
    }

    private static DirectResponse postJsonDirectResponse(
            Context context,
            String targetUrl,
            String json,
            int connectTimeoutMs,
            int readTimeoutMs,
            int authStageTimeoutMs) throws Exception {
        if (targetUrl == null
                || !EvogentSecurityPolicy.isTrustedWebUrl(targetUrl)
                || json == null
                || connectTimeoutMs <= 0
                || readTimeoutMs <= 0
                || authStageTimeoutMs <= 0) {
            throw new IllegalArgumentException("invalid direct request");
        }
        byte[] body = json.getBytes(StandardCharsets.UTF_8);
        for (int attempt = 0; attempt < 2; attempt++) {
            SessionMaterial session = authenticate(
                    context.getApplicationContext(),
                    "direct",
                    authStageTimeoutMs);
            DirectResponse response = postAuthenticatedJson(
                    targetUrl,
                    body,
                    session.sessionToken,
                    connectTimeoutMs,
                    readTimeoutMs);
            if (!response.phoneSessionRequired || attempt == 1) return response;
        }
        throw new AuthException("direct_request_failed", -1);
    }

    private static DirectResponse postJsonDirectResponseBefore(
            Context context,
            String targetUrl,
            String json,
            long deadlineElapsedRealtimeMs) throws Exception {
        if (targetUrl == null
                || !EvogentSecurityPolicy.isTrustedWebUrl(targetUrl)
                || json == null) {
            throw new IllegalArgumentException("invalid direct request");
        }
        requireRemainingDeadlineMs(deadlineElapsedRealtimeMs);
        byte[] body = json.getBytes(StandardCharsets.UTF_8);
        for (int attempt = 0; attempt < 2; attempt++) {
            SessionMaterial session = authenticateBefore(
                    context.getApplicationContext(),
                    "direct",
                    deadlineElapsedRealtimeMs);
            DirectResponse response = postAuthenticatedJsonBefore(
                    targetUrl,
                    body,
                    session.sessionToken,
                    deadlineElapsedRealtimeMs);
            if (!response.phoneSessionRequired || attempt == 1) return response;
            if (requireRemainingDeadlineMs(deadlineElapsedRealtimeMs)
                    < MIN_DIRECT_RETRY_REMAINING_MS) {
                throw new AuthException("direct_retry_budget_exhausted", -1);
            }
        }
        throw new AuthException("direct_request_failed", -1);
    }

    private static SessionMaterial authenticate(Context context, String sessionKind)
            throws Exception {
        return authenticate(context, sessionKind, DEFAULT_AUTH_STAGE_TIMEOUT_MS);
    }

    private static SessionMaterial authenticate(
            Context context,
            String sessionKind,
            int authStageTimeoutMs) throws Exception {
        return authenticate(
                context,
                sessionKind,
                authStageTimeoutMs,
                0L);
    }

    private static SessionMaterial authenticateBefore(
            Context context,
            String sessionKind,
            long deadlineElapsedRealtimeMs) throws Exception {
        requireRemainingDeadlineMs(deadlineElapsedRealtimeMs);
        return authenticate(
                context,
                sessionKind,
                0,
                deadlineElapsedRealtimeMs);
    }

    private static SessionMaterial authenticate(
            Context context,
            String sessionKind,
            int authStageTimeoutMs,
            long deadlineElapsedRealtimeMs) throws Exception {
        byte[] key = readControlToken(context);
        try {
            String clientNonce = randomLowerHex(32);
            ChallengeMaterial challenge = deadlineElapsedRealtimeMs > 0L
                    ? requestVerifiedChallengeBefore(
                            key,
                            clientNonce,
                            null,
                            deadlineElapsedRealtimeMs)
                    : requestVerifiedChallenge(
                            key,
                            clientNonce,
                            null,
                            authStageTimeoutMs);

            String clientProof = EvogentLoopbackAuthProtocol.clientProof(
                    key,
                    clientNonce,
                    challenge.serverInstanceId,
                    challenge.challengeId,
                    challenge.serverNonce,
                    challenge.expiresAtMs,
                    sessionKind);
            JSONObject completionBody = new JSONObject();
            completionBody.put("version", EvogentLoopbackAuthProtocol.VERSION);
            completionBody.put("clientNonce", clientNonce);
            completionBody.put("serverInstanceId", challenge.serverInstanceId);
            completionBody.put("challengeId", challenge.challengeId);
            completionBody.put("serverNonce", challenge.serverNonce);
            completionBody.put("expiresAtMs", challenge.expiresAtMs);
            completionBody.put("sessionKind", sessionKind);
            completionBody.put("clientProof", clientProof);

            JSONObject completion = deadlineElapsedRealtimeMs > 0L
                    ? postAuthJsonBefore(
                            COMPLETE_URL,
                            completionBody,
                            deadlineElapsedRealtimeMs)
                    : postAuthJson(
                            COMPLETE_URL,
                            completionBody,
                            authStageTimeoutMs);
            int completedVersion = completion.getInt("version");
            String completedKind = completion.getString("sessionKind");
            String sessionToken = completion.getString("sessionToken");
            long sessionExpiresAtMs = completion.getLong("sessionExpiresAtMs");
            String suppliedSessionProof = completion.getString("sessionProof");
            long now = System.currentTimeMillis();
            long maxFutureMs = "web".equals(sessionKind)
                    ? MAX_WEB_SESSION_FUTURE_MS
                    : MAX_DIRECT_SESSION_FUTURE_MS;
            if (completedVersion != EvogentLoopbackAuthProtocol.VERSION
                    || !sessionKind.equals(completedKind)
                    || !EvogentLoopbackAuthProtocol.isBase64UrlToken(sessionToken)
                    || sessionExpiresAtMs <= now
                    || sessionExpiresAtMs > now + maxFutureMs) {
                throw new AuthException("invalid_session", -1);
            }
            String expectedSessionProof = EvogentLoopbackAuthProtocol.sessionProof(
                    key,
                    clientNonce,
                    challenge.serverInstanceId,
                    challenge.challengeId,
                    challenge.serverNonce,
                    challenge.expiresAtMs,
                    sessionKind,
                    sessionToken,
                    sessionExpiresAtMs);
            if (!EvogentLoopbackAuthProtocol.proofMatches(
                    suppliedSessionProof,
                    expectedSessionProof)) {
                throw new AuthException("session_proof_failed", -1);
            }
            return new SessionMaterial(
                    sessionToken,
                    sessionExpiresAtMs,
                    challenge.serverInstanceId);
        } finally {
            Arrays.fill(key, (byte) 0);
        }
    }

    private static boolean verifyServer(
            Context context,
            String expectedServerInstanceId,
            String clientNonce,
            int timeoutMs) {
        byte[] key = null;
        try {
            key = readControlToken(context);
            requestVerifiedChallenge(
                    key,
                    clientNonce,
                    expectedServerInstanceId,
                    timeoutMs);
            return true;
        } catch (Throwable ignored) {
            return false;
        } finally {
            if (key != null) Arrays.fill(key, (byte) 0);
        }
    }

    private static ChallengeMaterial requestVerifiedChallenge(
            byte[] key,
            String clientNonce,
            String expectedServerInstanceId,
            int timeoutMs) throws Exception {
        return requestVerifiedChallenge(
                key,
                clientNonce,
                expectedServerInstanceId,
                timeoutMs,
                0L);
    }

    private static ChallengeMaterial requestVerifiedChallengeBefore(
            byte[] key,
            String clientNonce,
            String expectedServerInstanceId,
            long deadlineElapsedRealtimeMs) throws Exception {
        requireRemainingDeadlineMs(deadlineElapsedRealtimeMs);
        return requestVerifiedChallenge(
                key,
                clientNonce,
                expectedServerInstanceId,
                0,
                deadlineElapsedRealtimeMs);
    }

    private static ChallengeMaterial requestVerifiedChallenge(
            byte[] key,
            String clientNonce,
            String expectedServerInstanceId,
            int timeoutMs,
            long deadlineElapsedRealtimeMs) throws Exception {
        if (!EvogentLoopbackAuthProtocol.isLowerHex(clientNonce, 64)) {
            throw new AuthException("invalid_client_nonce", -1);
        }
        JSONObject challengeBody = new JSONObject();
        challengeBody.put("clientNonce", clientNonce);
        JSONObject challenge = deadlineElapsedRealtimeMs > 0L
                ? postAuthJsonBefore(
                        CHALLENGE_URL,
                        challengeBody,
                        deadlineElapsedRealtimeMs)
                : postAuthJson(CHALLENGE_URL, challengeBody, timeoutMs);

        int version = challenge.getInt("version");
        String echoedClientNonce = challenge.getString("clientNonce");
        String serverInstanceId = challenge.getString("serverInstanceId");
        String challengeId = challenge.getString("challengeId");
        String serverNonce = challenge.getString("serverNonce");
        long expiresAtMs = challenge.getLong("expiresAtMs");
        String suppliedServerProof = challenge.getString("serverProof");
        long now = System.currentTimeMillis();
        if (version != EvogentLoopbackAuthProtocol.VERSION
                || !clientNonce.equals(echoedClientNonce)
                || !EvogentLoopbackAuthProtocol.isLowerHex(serverInstanceId, 32)
                || (expectedServerInstanceId != null
                        && !expectedServerInstanceId.equals(serverInstanceId))
                || !EvogentLoopbackAuthProtocol.isLowerHex(challengeId, 32)
                || !EvogentLoopbackAuthProtocol.isLowerHex(serverNonce, 64)
                || expiresAtMs <= now
                || expiresAtMs > now + MAX_CHALLENGE_FUTURE_MS) {
            throw new AuthException("invalid_challenge", -1);
        }
        String expectedServerProof = EvogentLoopbackAuthProtocol.serverProof(
                key,
                clientNonce,
                serverInstanceId,
                challengeId,
                serverNonce,
                expiresAtMs);
        if (!EvogentLoopbackAuthProtocol.proofMatches(
                suppliedServerProof,
                expectedServerProof)) {
            throw new AuthException("server_proof_failed", -1);
        }
        return new ChallengeMaterial(
                serverInstanceId,
                challengeId,
                serverNonce,
                expiresAtMs);
    }

    private static JSONObject postAuthJson(
            String targetUrl,
            JSONObject body,
            int timeoutMs) throws Exception {
        HttpURLConnection connection = openPost(targetUrl, timeoutMs, timeoutMs);
        try {
            byte[] encoded = body.toString().getBytes(StandardCharsets.UTF_8);
            connection.setFixedLengthStreamingMode(encoded.length);
            OutputStream output = connection.getOutputStream();
            try {
                output.write(encoded);
            } finally {
                output.close();
            }
            int status = connection.getResponseCode();
            if (status != HttpURLConnection.HTTP_OK) {
                drain(connection, status);
                throw new AuthException("auth_http_error", status);
            }
            return new JSONObject(readBounded(connection.getInputStream()));
        } finally {
            connection.disconnect();
        }
    }

    private static JSONObject postAuthJsonBefore(
            String targetUrl,
            JSONObject body,
            long deadlineElapsedRealtimeMs) throws Exception {
        int timeoutMs = requireRemainingDeadlineMs(deadlineElapsedRealtimeMs);
        HttpURLConnection connection = openPost(targetUrl, timeoutMs, timeoutMs);
        try {
            byte[] encoded = body.toString().getBytes(StandardCharsets.UTF_8);
            connection.setFixedLengthStreamingMode(encoded.length);
            OutputStream output = connection.getOutputStream();
            try {
                output.write(encoded);
            } finally {
                output.close();
            }
            connection.setReadTimeout(requireRemainingDeadlineMs(deadlineElapsedRealtimeMs));
            int status = connection.getResponseCode();
            if (status != HttpURLConnection.HTTP_OK) {
                throw new AuthException("auth_http_error", status);
            }
            return new JSONObject(readBoundedBefore(
                    connection,
                    connection.getInputStream(),
                    deadlineElapsedRealtimeMs));
        } finally {
            connection.disconnect();
        }
    }

    private static DirectResponse postAuthenticatedJson(
            String targetUrl,
            byte[] body,
            String sessionToken,
            int connectTimeoutMs,
            int readTimeoutMs) throws Exception {
        HttpURLConnection connection = openPost(targetUrl, connectTimeoutMs, readTimeoutMs);
        try {
            connection.setRequestProperty("Authorization", AUTH_SCHEME + sessionToken);
            connection.setFixedLengthStreamingMode(body.length);
            OutputStream output = connection.getOutputStream();
            try {
                output.write(body);
            } finally {
                output.close();
            }
            int status = connection.getResponseCode();
            boolean phoneSessionRequired =
                    status == HttpURLConnection.HTTP_UNAUTHORIZED
                    && "EvogentPhoneSession".equals(
                            connection.getHeaderField("WWW-Authenticate"));
            String responseBody = null;
            if (status >= 200 && status < 300) {
                InputStream input = connection.getInputStream();
                if (input != null) {
                    responseBody = readBounded(input);
                }
            } else {
                drain(connection, status);
            }
            return new DirectResponse(status, phoneSessionRequired, responseBody);
        } finally {
            connection.disconnect();
        }
    }

    private static DirectResponse postAuthenticatedJsonBefore(
            String targetUrl,
            byte[] body,
            String sessionToken,
            long deadlineElapsedRealtimeMs) throws Exception {
        int timeoutMs = requireRemainingDeadlineMs(deadlineElapsedRealtimeMs);
        HttpURLConnection connection = openPost(targetUrl, timeoutMs, timeoutMs);
        try {
            connection.setRequestProperty("Authorization", AUTH_SCHEME + sessionToken);
            connection.setFixedLengthStreamingMode(body.length);
            OutputStream output = connection.getOutputStream();
            try {
                output.write(body);
            } finally {
                output.close();
            }
            connection.setReadTimeout(requireRemainingDeadlineMs(deadlineElapsedRealtimeMs));
            int status = connection.getResponseCode();
            boolean phoneSessionRequired =
                    status == HttpURLConnection.HTTP_UNAUTHORIZED
                    && "EvogentPhoneSession".equals(
                            connection.getHeaderField("WWW-Authenticate"));
            String responseBody = null;
            if (status >= 200 && status < 300) {
                InputStream input = connection.getInputStream();
                if (input != null) {
                    responseBody = readBoundedBefore(
                            connection,
                            input,
                            deadlineElapsedRealtimeMs);
                }
            }
            return new DirectResponse(status, phoneSessionRequired, responseBody);
        } finally {
            connection.disconnect();
        }
    }

    private static HttpURLConnection openPost(
            String targetUrl,
            int connectTimeoutMs,
            int readTimeoutMs) throws Exception {
        HttpURLConnection connection =
                (HttpURLConnection) new URL(targetUrl).openConnection();
        connection.setRequestMethod("POST");
        connection.setDoOutput(true);
        connection.setUseCaches(false);
        connection.setInstanceFollowRedirects(false);
        connection.setConnectTimeout(connectTimeoutMs);
        connection.setReadTimeout(readTimeoutMs);
        connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
        connection.setRequestProperty("Accept", "application/json");
        connection.setRequestProperty("Cache-Control", "no-store");
        return connection;
    }

    private static int requireRemainingDeadlineMs(
            long deadlineElapsedRealtimeMs) throws AuthException {
        long remaining = deadlineElapsedRealtimeMs - SystemClock.elapsedRealtime();
        if (deadlineElapsedRealtimeMs <= 0L || remaining <= 0L) {
            throw new AuthException("direct_deadline_exceeded", -1);
        }
        return (int) Math.min((long) Integer.MAX_VALUE, remaining);
    }

    private static void drain(HttpURLConnection connection, int status) {
        InputStream input = null;
        try {
            input = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            if (input == null) return;
            byte[] buffer = new byte[1024];
            int total = 0;
            int count;
            while (total <= MAX_AUTH_RESPONSE_BYTES
                    && (count = input.read(buffer)) != -1) {
                total += count;
            }
        } catch (Throwable ignored) {
        } finally {
            if (input != null) {
                try { input.close(); } catch (Throwable ignored) {}
            }
        }
    }

    private static String readBounded(InputStream input) throws Exception {
        try {
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            byte[] buffer = new byte[2048];
            int total = 0;
            int count;
            while ((count = input.read(buffer)) != -1) {
                total += count;
                if (total > MAX_AUTH_RESPONSE_BYTES) {
                    throw new AuthException("auth_response_too_large", -1);
                }
                output.write(buffer, 0, count);
            }
            return new String(output.toByteArray(), StandardCharsets.UTF_8);
        } finally {
            input.close();
        }
    }

    private static String readBoundedBefore(
            HttpURLConnection connection,
            InputStream input,
            long deadlineElapsedRealtimeMs) throws Exception {
        try {
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            byte[] buffer = new byte[2048];
            int total = 0;
            int count;
            while (true) {
                connection.setReadTimeout(requireRemainingDeadlineMs(
                        deadlineElapsedRealtimeMs));
                count = input.read(buffer);
                if (count == -1) break;
                total += count;
                if (total > MAX_AUTH_RESPONSE_BYTES) {
                    throw new AuthException("auth_response_too_large", -1);
                }
                output.write(buffer, 0, count);
            }
            requireRemainingDeadlineMs(deadlineElapsedRealtimeMs);
            return new String(output.toByteArray(), StandardCharsets.UTF_8);
        } finally {
            input.close();
        }
    }

    private static byte[] readControlToken(Context context) throws Exception {
        try {
            return EvogentControlToken.loadOrCreate(context)
                    .getBytes(StandardCharsets.US_ASCII);
        } catch (java.io.IOException unavailable) {
            throw new AuthException("invalid_control_token", -1);
        }
    }

    private static String randomLowerHex(int bytes) {
        byte[] value = new byte[bytes];
        RANDOM.nextBytes(value);
        try {
            return EvogentLoopbackAuthProtocol.lowerHex(value);
        } finally {
            Arrays.fill(value, (byte) 0);
        }
    }

    private static final class SessionMaterial {
        final String sessionToken;
        final long sessionExpiresAtMs;
        final String serverInstanceId;

        SessionMaterial(
                String sessionToken,
                long sessionExpiresAtMs,
                String serverInstanceId) {
            this.sessionToken = sessionToken;
            this.sessionExpiresAtMs = sessionExpiresAtMs;
            this.serverInstanceId = serverInstanceId;
        }
    }

    private static final class ChallengeMaterial {
        final String serverInstanceId;
        final String challengeId;
        final String serverNonce;
        final long expiresAtMs;

        ChallengeMaterial(
                String serverInstanceId,
                String challengeId,
                String serverNonce,
                long expiresAtMs) {
            this.serverInstanceId = serverInstanceId;
            this.challengeId = challengeId;
            this.serverNonce = serverNonce;
            this.expiresAtMs = expiresAtMs;
        }
    }

    private static final class DirectResponse {
        final int status;
        final boolean phoneSessionRequired;
        final String body;

        DirectResponse(int status, boolean phoneSessionRequired, String body) {
            this.status = status;
            this.phoneSessionRequired = phoneSessionRequired;
            this.body = body;
        }
    }

    private static final class AuthException extends Exception {
        final int httpStatus;

        AuthException(String code, int httpStatus) {
            super(code);
            this.httpStatus = httpStatus;
        }
    }
}

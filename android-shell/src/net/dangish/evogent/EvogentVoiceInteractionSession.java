package net.dangish.evogent;

import android.annotation.TargetApi;
import android.app.assist.AssistContent;
import android.app.assist.AssistStructure;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.service.voice.VoiceInteractionSession;
import android.text.InputType;
import android.util.Log;
import android.view.View;

/**
 * Converts the user's system assistant gesture into Evogent's authenticated Add Message form.
 *
 * The system-provided AssistStructure is captured only for this explicit invocation, bounded,
 * filtered for password fields, and handed to the composer through a one-shot in-process token.
 * No screenshot, Intent payload, preference, file, log, or database receives the context.
 */
final class EvogentVoiceInteractionSession extends VoiceInteractionSession {
    private static final String TAG = "EvogentAssistant";
    private static final int MAX_NODES = 600;
    private static final long ASSIST_CONTEXT_WAIT_MS = 800L;

    private final Handler main = new Handler(Looper.getMainLooper());
    private final EvogentAssistantLaunchGate launchGate =
            new EvogentAssistantLaunchGate();
    private String contextToken;
    private boolean composerStarted;
    private boolean contextTransferred;
    private boolean closed;
    private boolean timeoutScheduled;
    private final Runnable assistContextTimeout = new Runnable() {
        @Override public void run() {
            timeoutScheduled = false;
            if (closed || contextToken == null) return;
            // Timeout is an intentional first-writer-wins empty context. A late assist callback
            // cannot overwrite or relaunch it.
            EvogentAssistantContextStore.seal(contextToken, null, "");
            maybeLaunch(launchGate.onContextReady());
        }
    };

    EvogentVoiceInteractionSession(Context context) {
        super(context);
        // The composer needs semantic assist text only. Do not ask Android to capture pixels.
        setDisabledShowContext(SHOW_WITH_SCREENSHOT);
    }

    @Override
    public void onPrepareShow(Bundle args, int showFlags) {
        super.onPrepareShow(args, showFlags);
        // startAssistantActivity supplies the visible surface. Avoid a blank assistant window
        // flashing underneath it.
        setUiEnabled(false);
        ensureContextToken();
    }

    @Override
    public void onShow(Bundle args, int showFlags) {
        super.onShow(args, showFlags);
        if (closed || composerStarted) return;
        ensureContextToken();
        EvogentAssistantLaunchGate.Decision decision = launchGate.onShow();
        if (decision == EvogentAssistantLaunchGate.Decision.LAUNCH) {
            launchComposer();
            return;
        }
        if (!closed && !composerStarted && !timeoutScheduled) {
            timeoutScheduled = true;
            main.postDelayed(assistContextTimeout, ASSIST_CONTEXT_WAIT_MS);
        }
    }

    private void launchComposer() {
        if (closed || composerStarted || contextToken == null) return;
        composerStarted = true;
        timeoutScheduled = false;
        main.removeCallbacks(assistContextTimeout);
        final String token = contextToken;
        Intent composer = new Intent(getContext(), EvogentAssistantActivity.class);
        composer.putExtra(EvogentAssistantActivity.EXTRA_CONTEXT_TOKEN, token);
        composer.addFlags(Intent.FLAG_ACTIVITY_EXCLUDE_FROM_RECENTS
                | Intent.FLAG_ACTIVITY_NO_ANIMATION);
        try {
            if (Build.VERSION.SDK_INT >= 26) {
                startAssistantActivity(composer);
            } else {
                // startAssistantActivity was added in API 26. Keep the declared API-24 minimum
                // usable without weakening the modern Pixel assistant-layer path.
                composer.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(composer);
            }
            contextTransferred = true;
            contextToken = null;
            closed = true;
            launchGate.cancel();
            // The Activity owns the one-shot token now. End the inert voice session rather than
            // merely hiding it and leaving late lifecycle callbacks able to race the next gesture.
            finish();
        } catch (Throwable error) {
            EvogentAssistantContextStore.discard(token);
            contextToken = null;
            closed = true;
            launchGate.cancel();
            Log.e(TAG, "could not open Add Message", error);
            finish();
        }
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onHandleAssist(
            Bundle data,
            AssistStructure structure,
            AssistContent content) {
        if (Build.VERSION.SDK_INT < 29) storeFocusedContext(structure);
    }

    @Override
    @TargetApi(29)
    public void onHandleAssist(AssistState state) {
        if (state != null && state.isFocused()) {
            storeFocusedContext(state.getAssistStructure());
        }
    }

    private void storeFocusedContext(AssistStructure structure) {
        if (closed) return;
        ensureContextToken();
        if (contextToken == null) return;
        String app = null;
        StringBuilder text = new StringBuilder();
        if (structure != null) {
            try {
                ComponentName component = structure.getActivityComponent();
                app = component == null ? null : component.getPackageName();
            } catch (Throwable ignored) {}

            int[] visited = new int[]{0};
            try {
                for (int w = 0;
                        w < structure.getWindowNodeCount()
                                && visited[0] < MAX_NODES
                                && text.length() < EvogentAssistantContextStore.MAX_TEXT_CHARS;
                        w++) {
                    AssistStructure.WindowNode window = structure.getWindowNodeAt(w);
                    if (window != null) appendNode(window.getRootViewNode(), text, visited);
                }
            } catch (Throwable error) {
                // Partial, already-bounded context is still useful. Never log the content itself.
                Log.w(TAG, "assist structure was only partially readable");
            }
        }
        EvogentAssistantContextStore.seal(contextToken, app, text.toString());
        maybeLaunch(launchGate.onContextReady());
    }

    private void ensureContextToken() {
        if (!closed && contextToken == null) {
            contextToken = EvogentAssistantContextStore.begin();
        }
    }

    private void maybeLaunch(EvogentAssistantLaunchGate.Decision decision) {
        if (decision == EvogentAssistantLaunchGate.Decision.LAUNCH) {
            launchComposer();
        }
    }

    private void discardUntransferredContext() {
        timeoutScheduled = false;
        main.removeCallbacks(assistContextTimeout);
        launchGate.cancel();
        if (!contextTransferred && contextToken != null) {
            EvogentAssistantContextStore.discard(contextToken);
        }
        contextToken = null;
        closed = true;
    }

    @Override
    public void onHide() {
        if (!composerStarted) discardUntransferredContext();
        super.onHide();
    }

    @Override
    public void onDestroy() {
        discardUntransferredContext();
        super.onDestroy();
    }

    private void appendNode(
            AssistStructure.ViewNode node,
            StringBuilder out,
            int[] visited) {
        if (node == null
                || visited[0] >= MAX_NODES
                || out.length() >= EvogentAssistantContextStore.MAX_TEXT_CHARS) {
            return;
        }
        visited[0]++;
        if (EvogentAssistantTraversalPolicy.shouldPruneSubtree(
                node.getVisibility() == View.VISIBLE,
                isPasswordNode(node),
                node.isAssistBlocked())) {
            return;
        }
        appendValue(out, node.getText());
        appendValue(out, node.getContentDescription());
        for (int child = 0;
                child < node.getChildCount()
                        && visited[0] < MAX_NODES
                        && out.length() < EvogentAssistantContextStore.MAX_TEXT_CHARS;
                child++) {
            appendNode(node.getChildAt(child), out, visited);
        }
    }

    private static void appendValue(StringBuilder out, CharSequence value) {
        String normalized = EvogentAssistantContextStore.normalizeText(
                value,
                EvogentAssistantContextStore.MAX_TEXT_CHARS - out.length());
        if (normalized.isEmpty()) return;
        if (out.length() > 0) out.append('\n');
        int remaining = EvogentAssistantContextStore.MAX_TEXT_CHARS - out.length();
        if (remaining > 0) {
            out.append(normalized, 0, Math.min(normalized.length(), remaining));
        }
    }

    private static boolean isPasswordNode(AssistStructure.ViewNode node) {
        int variation = node.getInputType()
                & (InputType.TYPE_MASK_CLASS | InputType.TYPE_MASK_VARIATION);
        return variation
                == (InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD)
                || variation
                == (InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD)
                || variation
                == (InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD)
                || variation
                == (InputType.TYPE_CLASS_NUMBER | InputType.TYPE_NUMBER_VARIATION_PASSWORD);
    }
}

package net.dangish.evogent;

import android.annotation.TargetApi;
import android.app.assist.AssistContent;
import android.app.assist.AssistStructure;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
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

    private String contextToken;
    private boolean composerStarted;

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
        if (contextToken == null) contextToken = EvogentAssistantContextStore.begin();
    }

    @Override
    public void onShow(Bundle args, int showFlags) {
        super.onShow(args, showFlags);
        if (composerStarted) return;
        if (contextToken == null) contextToken = EvogentAssistantContextStore.begin();
        Intent composer = new Intent(getContext(), EvogentAssistantActivity.class);
        composer.putExtra(EvogentAssistantActivity.EXTRA_CONTEXT_TOKEN, contextToken);
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
            composerStarted = true;
            // The Activity is now the assistant layer; keep no inert session UI behind it.
            hide();
        } catch (Throwable error) {
            EvogentAssistantContextStore.discard(contextToken);
            contextToken = null;
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
        if (contextToken == null || structure == null) return;
        String app = null;
        try {
            ComponentName component = structure.getActivityComponent();
            app = component == null ? null : component.getPackageName();
        } catch (Throwable ignored) {}

        StringBuilder text = new StringBuilder();
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
        EvogentAssistantContextStore.update(contextToken, app, text.toString());
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
        if (node.getVisibility() == View.VISIBLE && !isPasswordNode(node)) {
            appendValue(out, node.getText());
            appendValue(out, node.getContentDescription());
        }
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

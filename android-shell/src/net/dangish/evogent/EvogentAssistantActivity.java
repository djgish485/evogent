package net.dangish.evogent;

import android.content.Intent;
import android.os.Bundle;

/**
 * Ephemeral assistant-layer host for the existing authenticated Add Message experience.
 *
 * It intentionally subclasses the hardened launcher WebView host, changing only its root URL and
 * native bridge capabilities. This keeps TLS pinning, loopback process proof, document proof,
 * external-navigation policy, and recovery UI identical on both surfaces.
 */
public final class EvogentAssistantActivity extends MainActivity {
    static final String EXTRA_CONTEXT_TOKEN =
            "net.dangish.evogent.extra.ASSISTANT_CONTEXT_TOKEN";
    private static final String COMPOSER_URL =
            EvogentSecurityPolicy.LOOPBACK_ORIGIN + "/?overlay=1";

    private String contextToken;
    private boolean contextConsumed;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        Intent intent = getIntent();
        contextToken = intent == null ? null : intent.getStringExtra(EXTRA_CONTEXT_TOKEN);
        if (!EvogentAssistantContextStore.isTokenShape(contextToken)) contextToken = null;
        super.onCreate(savedInstanceState);
    }

    @Override
    protected String rootDocumentUrl() {
        return COMPOSER_URL;
    }

    @Override
    protected boolean isHomeSurface() {
        return false;
    }

    @Override
    protected boolean supportsAssistantComposerBridge() {
        return true;
    }

    @Override
    protected EvogentAssistantContextStore.ContextData consumeAssistantContext() {
        if (contextConsumed) {
            return new EvogentAssistantContextStore.ContextData(null, "");
        }
        contextConsumed = true;
        return EvogentAssistantContextStore.consume(contextToken);
    }

    @Override
    protected void closeAssistantComposer() {
        finishAndRemoveTask();
    }

    @Override
    protected int recoveryEscapeLabelResource() {
        return R.string.assistant_recovery_close;
    }

    @Override
    protected void handleRecoveryEscape() {
        closeAssistantComposer();
    }

    @Override
    public void onBackPressed() {
        closeAssistantComposer();
    }

    @Override
    protected void onDestroy() {
        if (!contextConsumed && !isChangingConfigurations()) {
            EvogentAssistantContextStore.discard(contextToken);
        }
        contextToken = null;
        super.onDestroy();
    }
}

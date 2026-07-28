package net.dangish.evogent;

import android.os.Bundle;
import android.service.voice.VoiceInteractionSession;
import android.service.voice.VoiceInteractionSessionService;

/** Creates one short-lived Evogent composer session for each system assistant invocation. */
public final class EvogentVoiceInteractionSessionService
        extends VoiceInteractionSessionService {
    @Override
    public VoiceInteractionSession onNewSession(Bundle args) {
        return new EvogentVoiceInteractionSession(this);
    }
}

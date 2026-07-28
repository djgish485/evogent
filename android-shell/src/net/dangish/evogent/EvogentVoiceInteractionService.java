package net.dangish.evogent;

import android.service.voice.VoiceInteractionService;

/**
 * Lightweight system-assistant role entry point.
 *
 * Android keeps the selected VoiceInteractionService alive, so all actual UI and context work
 * belongs to the transient session service/activity rather than this process entry point.
 */
public final class EvogentVoiceInteractionService extends VoiceInteractionService {
}

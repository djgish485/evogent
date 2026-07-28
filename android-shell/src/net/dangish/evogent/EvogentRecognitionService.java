package net.dangish.evogent;

import android.content.Intent;
import android.os.RemoteException;
import android.speech.RecognitionService;
import android.speech.SpeechRecognizer;

/**
 * Compatibility declaration required by VoiceInteractionService metadata.
 *
 * Evogent's assistant action is text-first and does not request microphone access or run a
 * hotword listener. Android 12+ ignores recognitionService for this flow; older releases require
 * a concrete service name, so unsupported recognition requests fail immediately and explicitly.
 */
public final class EvogentRecognitionService extends RecognitionService {
    @Override
    protected void onStartListening(Intent recognizerIntent, Callback listener) {
        try {
            listener.error(SpeechRecognizer.ERROR_CLIENT);
        } catch (RemoteException ignored) {}
    }

    @Override
    protected void onStopListening(Callback listener) {
        try {
            listener.error(SpeechRecognizer.ERROR_CLIENT);
        } catch (RemoteException ignored) {}
    }

    @Override
    protected void onCancel(Callback listener) {
        // Nothing was started.
    }
}

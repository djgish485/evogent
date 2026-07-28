package net.dangish.evogent;

import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;
import java.util.UUID;

/**
 * Process-local, short-lived handoff for an explicitly invoked assistant session.
 *
 * AssistStructure can contain private screen text. It never belongs in an Intent, log, preference,
 * database, or saved instance state. The assistant Activity receives only an opaque random token;
 * the exact-origin, process-authenticated composer consumes the corresponding text once.
 */
final class EvogentAssistantContextStore {
    static final int MAX_TEXT_CHARS = 4000;
    private static final long MAX_AGE_NANOS = 10L * 60L * 1000L * 1000L * 1000L;
    private static final Map<String, Entry> ENTRIES = new HashMap<String, Entry>();

    static final class ContextData {
        final String app;
        final String text;

        ContextData(String app, String text) {
            this.app = normalizeApp(app);
            this.text = normalizeText(text, MAX_TEXT_CHARS);
        }
    }

    private static final class Entry {
        final long createdAtNanos;
        ContextData data;
        boolean sealed;

        Entry(long createdAtNanos) {
            this.createdAtNanos = createdAtNanos;
        }
    }

    private EvogentAssistantContextStore() {}

    static synchronized String begin() {
        long now = System.nanoTime();
        prune(now);
        String token = UUID.randomUUID().toString();
        ENTRIES.put(token, new Entry(now));
        return token;
    }

    /**
     * Seal the handoff exactly once. A timeout seals an empty value; a late assist callback can
     * never overwrite it after the composer has launched or consumed the token.
     */
    static synchronized boolean seal(String token, String app, String text) {
        if (!isTokenShape(token)) return false;
        long now = System.nanoTime();
        prune(now);
        Entry entry = ENTRIES.get(token);
        if (entry == null
                || entry.sealed
                || now - entry.createdAtNanos > MAX_AGE_NANOS) {
            return false;
        }
        entry.data = new ContextData(app, text);
        entry.sealed = true;
        return true;
    }

    static synchronized ContextData consume(String token) {
        if (!isTokenShape(token)) return new ContextData(null, "");
        prune(System.nanoTime());
        Entry entry = ENTRIES.remove(token);
        return entry == null || !entry.sealed || entry.data == null
                ? new ContextData(null, "")
                : entry.data;
    }

    static synchronized void discard(String token) {
        if (isTokenShape(token)) ENTRIES.remove(token);
    }

    static boolean isTokenShape(String token) {
        if (token == null || token.length() != 36) return false;
        for (int i = 0; i < token.length(); i++) {
            char c = token.charAt(i);
            if (i == 8 || i == 13 || i == 18 || i == 23) {
                if (c != '-') return false;
            } else if (!((c >= '0' && c <= '9')
                    || (c >= 'a' && c <= 'f')
                    || (c >= 'A' && c <= 'F'))) {
                return false;
            }
        }
        return true;
    }

    static String normalizeText(CharSequence raw, int maxChars) {
        if (raw == null || maxChars <= 0) return "";
        StringBuilder out = new StringBuilder(Math.min(raw.length(), maxChars));
        boolean previousWhitespace = true;
        for (int i = 0; i < raw.length() && out.length() < maxChars; i++) {
            char c = raw.charAt(i);
            if (Character.isISOControl(c) || Character.isWhitespace(c)) {
                if (!previousWhitespace && out.length() < maxChars) {
                    out.append(' ');
                    previousWhitespace = true;
                }
            } else {
                out.append(c);
                previousWhitespace = false;
            }
        }
        int length = out.length();
        if (length > 0 && out.charAt(length - 1) == ' ') out.setLength(length - 1);
        return out.toString();
    }

    private static String normalizeApp(String app) {
        if (app == null) return null;
        String normalized = normalizeText(app, 240);
        return normalized.isEmpty() ? null : normalized;
    }

    private static void prune(long now) {
        Iterator<Map.Entry<String, Entry>> iterator = ENTRIES.entrySet().iterator();
        while (iterator.hasNext()) {
            Entry entry = iterator.next().getValue();
            if (now - entry.createdAtNanos > MAX_AGE_NANOS) iterator.remove();
        }
    }
}

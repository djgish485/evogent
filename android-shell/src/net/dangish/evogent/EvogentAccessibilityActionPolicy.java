package net.dangish.evogent;

/**
 * Pure result mapping for accessibility text clicks. Keeping this Android-free makes the
 * automation contract host-testable: a caller may only report success when performAction()
 * itself returned true.
 */
final class EvogentAccessibilityActionPolicy {
    private EvogentAccessibilityActionPolicy() {}

    static String clickTextResult(boolean validText, boolean found,
                                  boolean clickableTarget, boolean performed) {
        if (!validText) return "invalid_text";
        if (!found) return "not_found";
        if (!clickableTarget) return "not_clickable";
        return performed ? "performed" : "not_performed";
    }
}

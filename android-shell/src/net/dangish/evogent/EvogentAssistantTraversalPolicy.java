package net.dangish.evogent;

/**
 * Host-testable privacy rule for AssistStructure traversal.
 *
 * Visibility and password sensitivity apply to the whole subtree. A child can report its own
 * default VISIBLE state even when an ancestor is hidden, and custom password widgets can place
 * sensitive text in descendants rather than the password node itself.
 */
final class EvogentAssistantTraversalPolicy {
    private EvogentAssistantTraversalPolicy() {}

    static boolean shouldPruneSubtree(
            boolean visible,
            boolean passwordNode,
            boolean assistBlocked) {
        return !visible || passwordNode || assistBlocked;
    }
}

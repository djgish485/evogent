package net.dangish.evogent;

public final class EvogentAccessibilityActionPolicyTest {
    private static void expect(String expected, String actual) {
        if (!expected.equals(actual)) {
            throw new AssertionError("expected " + expected + " but got " + actual);
        }
    }

    public static void main(String[] args) {
        expect("invalid_text",
                EvogentAccessibilityActionPolicy.clickTextResult(false, true, true, true));
        expect("not_found",
                EvogentAccessibilityActionPolicy.clickTextResult(true, false, false, false));
        expect("not_clickable",
                EvogentAccessibilityActionPolicy.clickTextResult(true, true, false, false));
        expect("not_performed",
                EvogentAccessibilityActionPolicy.clickTextResult(true, true, true, false));
        expect("performed",
                EvogentAccessibilityActionPolicy.clickTextResult(true, true, true, true));
        System.out.println("EvogentAccessibilityActionPolicyTest: ok");
    }
}

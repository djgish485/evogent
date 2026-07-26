package net.dangish.evogent;

public final class EvogentPhysicalDisplayPolicyTest {
    private static void check(boolean value, String message) {
        if (!value) throw new AssertionError(message);
    }

    public static void main(String[] args) {
        String normal =
                "Display #0 (activities from top to bottom):\n"
                + "  topResumedActivity=ActivityRecord{1 u0 net.dangish.evogent/.MainActivity t1}\n"
                + "Display #9 (activities from top to bottom):\n"
                + "  topResumedActivity=ActivityRecord{2 u0 com.twitter.android/.StartActivity t2}\n";
        check("net.dangish.evogent".equals(
                EvogentPhysicalDisplayPolicy.displayZeroResumedPackage(normal)),
                "must read display 0, not the hidden display");
        check(EvogentPhysicalDisplayPolicy.mayForceStop("com.twitter.android", normal),
                "different physical package should be safe");
        check(!EvogentPhysicalDisplayPolicy.mayForceStop("net.dangish.evogent", normal),
                "active physical package must be protected");

        String alternate =
                "Display 0:\n"
                + "  mResumedActivity: ActivityRecord{1 u10 com.example.reader/.Main t1}\n";
        check("com.example.reader".equals(
                EvogentPhysicalDisplayPolicy.displayZeroResumedPackage(alternate)),
                "alternate dumpsys format must parse");

        String ambiguous =
                "Display #0:\n"
                + "  topResumedActivity=ActivityRecord{1 u0 com.example.one/.Main t1}\n"
                + "  mResumedActivity: ActivityRecord{2 u0 com.example.two/.Main t2}\n";
        check(EvogentPhysicalDisplayPolicy.displayZeroResumedPackage(ambiguous) == null,
                "ambiguous resumed state must fail closed");
        check(!EvogentPhysicalDisplayPolicy.mayForceStop("com.example.three", ambiguous),
                "ambiguous state must refuse force-stop");
        check(!EvogentPhysicalDisplayPolicy.mayForceStop(
                "com.twitter.android", "topDisplayFocusedRootTask=Task{type=home}"),
                "missing display-0 package must refuse force-stop");
        System.out.println("EvogentPhysicalDisplayPolicyTest: ok");
    }
}

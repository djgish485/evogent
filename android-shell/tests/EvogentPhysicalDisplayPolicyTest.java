package net.dangish.evogent;

public final class EvogentPhysicalDisplayPolicyTest {
    private static void check(boolean value, String message) {
        if (!value) throw new AssertionError(message);
    }

    private static final String AWAKE = "  mWakefulness=Awake\n  mInteractive=true\n";
    private static final String ASLEEP = "  mWakefulness=Asleep\n  mInteractive=false\n";
    private static final String UNLOCKED = "mKeyguardShowing=false\n";

    public static void main(String[] args) {
        String differentForeground =
                "Display #0 (activities from top to bottom):\n"
                + "  topResumedActivity=ActivityRecord{1 u0 net.dangish.evogent/.MainActivity t1}\n"
                + "Display #9 (activities from top to bottom):\n"
                + "  topResumedActivity=ActivityRecord{2 u0 com.twitter.android/.StartActivity t2}\n";
        check("net.dangish.evogent".equals(
                EvogentPhysicalDisplayPolicy.displayZeroResumedPackage(differentForeground)),
                "must read display 0, not the hidden display");
        check(EvogentPhysicalDisplayPolicy.hasExactDifferentDisplayZeroForeground(
                "com.twitter.android", differentForeground),
                "one exact different physical package should pass the final branch proof");

        String targetForeground =
                "Display #0:\n"
                + "  topResumedActivity=ActivityRecord{1 u0 com.twitter.android/.StartActivity t1}\n";
        check(!EvogentPhysicalDisplayPolicy.hasExactDifferentDisplayZeroForeground(
                "com.twitter.android", targetForeground),
                "a target that became foreground after an older unattended proof must refuse");

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
        check(!EvogentPhysicalDisplayPolicy.hasExactDifferentDisplayZeroForeground(
                "com.example.three", ambiguous),
                "ambiguous state must refuse the final branch proof");
        check(!EvogentPhysicalDisplayPolicy.hasExactDifferentDisplayZeroForeground(
                "com.twitter.android", "topDisplayFocusedRootTask=Task{type=home}"),
                "missing display-0 package must refuse the final branch proof");
        check(!EvogentPhysicalDisplayPolicy.hasExactDifferentDisplayZeroForeground(
                "bad package", differentForeground),
                "invalid target package must always refuse");

        check(EvogentPhysicalDisplayPolicy.isValidTargetPackage("com.twitter.android"),
                "normal package must validate");
        check(!EvogentPhysicalDisplayPolicy.isValidTargetPackage(null),
                "null package must refuse before any branch");

        check(EvogentPhysicalDisplayPolicy.isStrictlyAwake(AWAKE),
                "awake variants must normalize");
        check(EvogentPhysicalDisplayPolicy.isStrictlyNotAwake(ASLEEP),
                "sleep variants must normalize");
        check(!EvogentPhysicalDisplayPolicy.isStrictlyAwake(
                        "mWakefulness=Awake\nmInteractive=false\n")
                        && !EvogentPhysicalDisplayPolicy.isStrictlyNotAwake(
                        "mWakefulness=Awake\nmInteractive=false\n"),
                "contradictory wake fields must satisfy neither branch");
        check(!EvogentPhysicalDisplayPolicy.isStrictlyAwake("mWakefulness=Unknown\n")
                        && !EvogentPhysicalDisplayPolicy.isStrictlyNotAwake(
                        "mWakefulness=Unknown\n"),
                "unknown wake values must satisfy neither branch");
        check(!EvogentPhysicalDisplayPolicy.isStrictlyAwake("")
                        && !EvogentPhysicalDisplayPolicy.isStrictlyNotAwake(""),
                "missing wake fields must satisfy neither branch");

        String android16LockedNonOccluded =
                "PhoneWindowManager\n"
                + "  KeyguardServiceDelegate\n"
                + "    showing=true\n"
                + "    occluded=false\n"
                + "    inputRestricted=true\n"
                + "    KeyguardStateMonitor\n"
                + "      mIsShowing=true\n";
        check(EvogentPhysicalDisplayPolicy.lockscreenStateFromDump(
                        android16LockedNonOccluded)
                        == EvogentPhysicalDisplayPolicy.LockscreenState.LOCKED,
                "Android 16 showing hierarchy must parse");
        check(EvogentPhysicalDisplayPolicy.keyguardOcclusionStateFromDump(
                        android16LockedNonOccluded)
                        == EvogentPhysicalDisplayPolicy.OcclusionState.NON_OCCLUDED,
                "exact Android 16 direct-child occluded=false must parse");
        check(EvogentPhysicalDisplayPolicy.isStrictlyLockedAndNonOccluded(
                        android16LockedNonOccluded)
                        && !EvogentPhysicalDisplayPolicy.isStrictlyUnlocked(
                        android16LockedNonOccluded),
                "showing and non-occluded must permit only the locked fast-path predicate");

        String android16LockedOccluded =
                "KeyguardServiceDelegate\n"
                + "  showing=true\n"
                + "  occluded=true\n"
                + "  KeyguardStateMonitor\n"
                + "    mIsShowing=true\n";
        check(EvogentPhysicalDisplayPolicy.keyguardOcclusionStateFromDump(
                        android16LockedOccluded)
                        == EvogentPhysicalDisplayPolicy.OcclusionState.OCCLUDED,
                "exact direct-child occluded=true must parse");
        check(!EvogentPhysicalDisplayPolicy.isStrictlyLockedAndNonOccluded(
                        android16LockedOccluded)
                        && !EvogentPhysicalDisplayPolicy.hasExactDifferentDisplayZeroForeground(
                        "com.twitter.android", targetForeground),
                "occluded keyguard with target foreground must refuse");

        String android16MissingOcclusion =
                "KeyguardServiceDelegate\n"
                + "  showing=true\n"
                + "  KeyguardStateMonitor\n"
                + "    mIsShowing=true\n";
        check(EvogentPhysicalDisplayPolicy.keyguardOcclusionStateFromDump(
                        android16MissingOcclusion)
                        == EvogentPhysicalDisplayPolicy.OcclusionState.UNKNOWN
                        && !EvogentPhysicalDisplayPolicy.isStrictlyLockedAndNonOccluded(
                        android16MissingOcclusion),
                "missing occlusion must refuse the locked fast path");

        String android16ContradictoryOcclusion =
                "KeyguardServiceDelegate\n"
                + "  showing=true\n"
                + "  occluded=false\n"
                + "  occluded=true\n"
                + "  KeyguardStateMonitor\n"
                + "    mIsShowing=true\n";
        check(EvogentPhysicalDisplayPolicy.keyguardOcclusionStateFromDump(
                        android16ContradictoryOcclusion)
                        == EvogentPhysicalDisplayPolicy.OcclusionState.UNKNOWN
                        && !EvogentPhysicalDisplayPolicy.isStrictlyLockedAndNonOccluded(
                        android16ContradictoryOcclusion),
                "contradictory occlusion must refuse the locked fast path");

        String android16Unlocked =
                "KeyguardServiceDelegate\n"
                + "  showing=false\n"
                + "  occluded=false\n"
                + "  KeyguardStateMonitor\n"
                + "    mIsShowing=false\n";
        check(EvogentPhysicalDisplayPolicy.isStrictlyUnlocked(android16Unlocked),
                "Android 16 unlocked hierarchy must parse");
        check(EvogentPhysicalDisplayPolicy.isStrictlyUnlocked(UNLOCKED)
                        && !EvogentPhysicalDisplayPolicy.isStrictlyLockedAndNonOccluded(UNLOCKED),
                "unlocked alias must not satisfy the locked fast path");

        String unrelated =
                "SomeOtherService\n"
                + "  showing=true\n"
                + "  occluded=false\n"
                + "  KeyguardStateMonitor\n"
                + "    mIsShowing=true\n";
        check(!EvogentPhysicalDisplayPolicy.isStrictlyLockedAndNonOccluded(unrelated)
                        && !EvogentPhysicalDisplayPolicy.isStrictlyUnlocked(unrelated),
                "generic showing/occluded fields outside the exact hierarchy must be ignored");
        String nestedDecoy =
                "KeyguardServiceDelegate\n"
                + "  SomeOtherState\n"
                + "    showing=true\n"
                + "    occluded=false\n";
        check(!EvogentPhysicalDisplayPolicy.isStrictlyLockedAndNonOccluded(nestedDecoy),
                "nested decoy showing/occluded fields must be ignored");
        String occlusionDecoy =
                "KeyguardServiceDelegate\n"
                + "  showing=true\n"
                + "  SomeOtherState\n"
                + "    occluded=false\n"
                + "  KeyguardStateMonitor\n"
                + "    mIsShowing=true\n";
        check(!EvogentPhysicalDisplayPolicy.isStrictlyLockedAndNonOccluded(occlusionDecoy),
                "occluded must be a direct KeyguardServiceDelegate child");
        String conflicting =
                "KeyguardServiceDelegate\n"
                + "  showing=true\n"
                + "  occluded=false\n"
                + "  KeyguardStateMonitor\n"
                + "    mIsShowing=false\n";
        check(!EvogentPhysicalDisplayPolicy.isStrictlyLockedAndNonOccluded(conflicting)
                        && !EvogentPhysicalDisplayPolicy.isStrictlyUnlocked(conflicting),
                "contradictory keyguard fields must satisfy neither branch");

        // A transition is represented by separate predicates, never one combined permissive
        // verdict: an older locked/asleep observation cannot turn a later target foreground into
        // a true final activity proof.
        check(EvogentPhysicalDisplayPolicy.isStrictlyLockedAndNonOccluded(
                        android16LockedNonOccluded),
                "older locked/non-occluded observation is independently true");
        check(EvogentPhysicalDisplayPolicy.isStrictlyNotAwake(ASLEEP),
                "older asleep observation is independently true");
        check(!EvogentPhysicalDisplayPolicy.hasExactDifferentDisplayZeroForeground(
                "com.twitter.android", targetForeground),
                "later target-foreground transition remains an unconditional refusal");

        System.out.println("EvogentPhysicalDisplayPolicyTest: ok");
    }
}

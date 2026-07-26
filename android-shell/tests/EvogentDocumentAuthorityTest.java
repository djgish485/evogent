package net.dangish.evogent;

/** Hostile loopback-takeover cases for the document/native-authority state machine. */
public final class EvogentDocumentAuthorityTest {
    private static final String SERVER_A = repeated("11", 16);
    private static final String SERVER_B = repeated("22", 16);
    private static final String DOCUMENT_A = repeated("aa", 32);
    private static final String DOCUMENT_B = repeated("bb", 32);

    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }

    public static void main(String[] args) {
        takeoverBetweenAuthenticationAndLoadFailsClosed();
        takeoverDuringTrustedDocumentRevokesAuthority();
        overlayContextRequiresCurrentProcessProof();
        mainLaunchRequiresCurrentProcessProof();
        sameProcessSessionRefreshPreservesBinding();
        oldDocumentProofCannotAuthorizeNewGeneration();
        System.out.println("EvogentDocumentAuthorityTest: PASS");
    }

    private static void takeoverBetweenAuthenticationAndLoadFailsClosed() {
        EvogentDocumentAuthority authority = new EvogentDocumentAuthority();
        authority.begin(1, SERVER_A, DOCUMENT_A);
        require(!authority.confirmAfterLoad(1, SERVER_B, DOCUMENT_A, true),
                "replacement process authenticated a document loaded for the old process");
        require(!authority.isTrusted(1, SERVER_A),
                "failed post-load binding left document trusted");
    }

    private static void takeoverDuringTrustedDocumentRevokesAuthority() {
        EvogentDocumentAuthority authority = confirmedAuthority();
        require(!authority.authorizeBridge(1, SERVER_A, false),
                "bridge survived a failed fresh server proof");
        require(!authority.isTrusted(1, SERVER_A),
                "failed bridge proof did not revoke document");
    }

    private static void overlayContextRequiresCurrentProcessProof() {
        EvogentDocumentAuthority authority = confirmedAuthority();
        require(!authority.authorizeBridge(1, SERVER_B, true),
                "overlay context was released to a replacement server process");
    }

    private static void mainLaunchRequiresCurrentProcessProof() {
        EvogentDocumentAuthority authority = confirmedAuthority();
        require(authority.authorizeBridge(1, SERVER_A, true),
                "main native launch rejected the exact bound process");
        require(!authority.authorizeBridge(1, SERVER_A, false),
                "main native launch accepted a port-takeover proof failure");
    }

    private static void oldDocumentProofCannotAuthorizeNewGeneration() {
        EvogentDocumentAuthority authority = confirmedAuthority();
        authority.begin(2, SERVER_A, DOCUMENT_B);
        require(!authority.confirmAfterLoad(1, SERVER_A, DOCUMENT_A, true),
                "old document proof authorized a new load generation");
        require(!authority.authorizeBridge(2, SERVER_A, true),
                "revoked generation retained bridge authority");
    }

    private static void sameProcessSessionRefreshPreservesBinding() {
        EvogentDocumentAuthority authority = confirmedAuthority();
        require(authority.rebindSession(1, 2, SERVER_A),
                "same-process session refresh lost document binding");
        require(authority.isTrusted(2, SERVER_A),
                "refreshed generation is not trusted");
        require(!authority.rebindSession(2, 3, SERVER_B),
                "replacement process rebound the old document");
    }

    private static EvogentDocumentAuthority confirmedAuthority() {
        EvogentDocumentAuthority authority = new EvogentDocumentAuthority();
        authority.begin(1, SERVER_A, DOCUMENT_A);
        require(authority.confirmAfterLoad(1, SERVER_A, DOCUMENT_A, true),
                "valid post-load process proof rejected");
        return authority;
    }

    private static String repeated(String value, int count) {
        StringBuilder builder = new StringBuilder(value.length() * count);
        for (int i = 0; i < count; i++) builder.append(value);
        return builder.toString();
    }
}

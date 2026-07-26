package net.dangish.evogent;

/**
 * Pure-Java state machine binding one WebView document to one authenticated server process.
 *
 * A URL, cookie, or prior handshake is not authority: another Android app can take the same
 * loopback port after the real server exits. A document becomes trusted only when a post-load
 * proof matches its generation, one-time nonce, and original server instance. Every native bridge
 * call then supplies a new proof result for that same instance; a failure revokes the document.
 */
final class EvogentDocumentAuthority {
    private long generation;
    private String serverInstanceId;
    private String documentNonce;
    private boolean confirmed;

    void begin(long nextGeneration, String nextServerInstanceId, String nextDocumentNonce) {
        if (nextGeneration <= 0
                || !EvogentLoopbackAuthProtocol.isLowerHex(nextServerInstanceId, 32)
                || !EvogentLoopbackAuthProtocol.isLowerHex(nextDocumentNonce, 64)) {
            revoke();
            return;
        }
        generation = nextGeneration;
        serverInstanceId = nextServerInstanceId;
        documentNonce = nextDocumentNonce;
        confirmed = false;
    }

    boolean confirmAfterLoad(
            long suppliedGeneration,
            String suppliedServerInstanceId,
            String suppliedDocumentNonce,
            boolean proofVerified) {
        if (!proofVerified
                || !isBound(suppliedGeneration, suppliedServerInstanceId)
                || documentNonce == null
                || !documentNonce.equals(suppliedDocumentNonce)) {
            revoke();
            return false;
        }
        confirmed = true;
        return true;
    }

    boolean authorizeBridge(
            long suppliedGeneration,
            String suppliedServerInstanceId,
            boolean freshProofVerified) {
        if (!freshProofVerified || !isBound(suppliedGeneration, suppliedServerInstanceId)) {
            revoke();
            return false;
        }
        // An early page script may call before the async post-load proof returns. Its independent
        // fresh proof for the exact bound process is equally strong and completes the binding.
        confirmed = true;
        return true;
    }

    boolean isTrusted(long suppliedGeneration, String suppliedServerInstanceId) {
        return confirmed && isBound(suppliedGeneration, suppliedServerInstanceId);
    }

    boolean rebindSession(
            long previousGeneration,
            long nextGeneration,
            String suppliedServerInstanceId) {
        if (nextGeneration <= 0 || !isBound(previousGeneration, suppliedServerInstanceId)) {
            revoke();
            return false;
        }
        generation = nextGeneration;
        return true;
    }

    boolean isBound(long suppliedGeneration, String suppliedServerInstanceId) {
        return generation > 0
                && generation == suppliedGeneration
                && serverInstanceId != null
                && serverInstanceId.equals(suppliedServerInstanceId)
                && documentNonce != null;
    }

    void revoke() {
        generation = 0;
        serverInstanceId = null;
        documentNonce = null;
        confirmed = false;
    }
}

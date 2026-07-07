package net.dangish.evogent;

/**
 * Runs inside a shell-uid (2000) process spawned by Shizuku. Only the two
 * operations that a normal app cannot do itself live here — create a TRUSTED
 * hidden virtual display, and launch an arbitrary app onto it. Everything else
 * (scroll, read, share-flow, capture) is done on-device by the accessibility
 * service at app privilege.
 */
interface IEvoPrivileged {
    int createDisplay(int width, int height, int dpi);
    boolean launch(String pkg, String activity, int displayId);
    void releaseDisplay();
    void destroy();
}

#!/data/data/com.termux/files/usr/bin/env python3
# Shared a11y shotnode->rect helper. Several browsers need real screen geometry for GESTURE
# taps: IG ignores ACTION_CLICK on tray rings and custom grid tiles, so the reliable entry is
# a gesture at the node's actual bounds (small chrome views like the tab bar report valid
# rects; custom tiles don't — anchor on chrome, then use geometry). One implementation of the
# dance: fire the shotnode op via phone.sh, pull the `<name>.rect.txt` sidecar the a11y
# service writes next to the crop, parse `container=Rect(l, t - r, b)`. This existed as two
# drifting copies (browse-instagram.py ring_rect, browse-interests.py node_rect) before being
# factored here — import it, never re-copy it.
import os, re, subprocess, time

RECT = re.compile(r"container=Rect\((-?\d+), (-?\d+) - (-?\d+), (-?\d+)\)")
_TOOLS = os.path.dirname(os.path.realpath(__file__))
_PHONE = os.path.join(_TOOLS, "phone.sh")
_RISH = os.path.expanduser("~/rish-bin/rish")


def shotnode_rect(display, match, name, timeout=30):
    """Screen bounds (l, t, r, b) of the a11y node whose text/desc contains `match` on
    `display`, via the shotnode op's rect sidecar. Returns None when no valid rect."""
    try:
        subprocess.run(["bash", _PHONE, "shotnode", match, "/dev/null", str(display), name],
                       capture_output=True, timeout=timeout)
    except Exception:
        return None
    time.sleep(1)  # the sidecar can land a beat after the op returns
    src = f"/sdcard/Android/data/net.dangish.evogent/files/{name}.rect.txt"
    stage = f"/sdcard/{name}.txt"
    try:
        subprocess.run([_RISH, "-c", f"cp '{src}' '{stage}'"],
                       env={**os.environ, "RISH_APPLICATION_ID": "com.termux"},
                       capture_output=True, timeout=20)
        m = RECT.search(open(stage).read())
        if m:
            l, t, r, b = map(int, m.groups())
            if r > l and b > t:
                return (l, t, r, b)
    except (OSError, subprocess.SubprocessError):
        pass
    return None


def shotnode_center(display, match, name, timeout=30):
    """Center point (x, y) of the matched node — the gesture-tap target."""
    r = shotnode_rect(display, match, name, timeout=timeout)
    return ((r[0] + r[2]) // 2, (r[1] + r[3]) // 2) if r else None

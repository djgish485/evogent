#!/data/data/com.termux/files/usr/bin/bash
# Auto-start the Evogent server on device boot (requires the Termux:Boot addon app).
# Shizuku + a11y still need the one host-side `restore-device.sh` on a non-rooted image.
termux-wake-lock 2>/dev/null || true
sleep 8
sshd 2>/dev/null || true
bash "$HOME/restart-evo.sh" 2>/dev/null || true

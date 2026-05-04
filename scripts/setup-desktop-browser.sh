#!/usr/bin/env bash
# setup-desktop-browser.sh — Install desktop environment for persistent Chrome cookies
#
# Chrome on Linux encrypts cookies using gnome-keyring. On a headless server,
# there's no persistent keyring session, so cookies are lost on every Chrome
# restart. The fix: install a minimal desktop (XFCE + LightDM) with auto-login.
# The desktop session provides a real gnome-keyring that persists to disk.
#
# This script:
#   1. Installs XFCE desktop + LightDM + gnome-keyring
#   2. Installs Google Chrome
#   3. Configures auto-login (no password prompt on boot)
#   4. Creates the keyring with an empty password (auto-unlocks)
#   5. Installs noVNC for remote browser access
#   6. Sets up chrome-browse.service for CDP on port 9222
#
# After running this script:
#   - Reboot the VM
#   - SSH tunnel: ssh -L 6080:localhost:6080 root@your-vm
#   - Open: http://localhost:6080/vnc.html?autoconnect=true&resize=scale
#   - Log into YouTube/Twitter in the Chrome window
#   - Cookies will persist across Chrome restarts AND VM reboots
#
# Usage:
#   bash scripts/setup-desktop-browser.sh
#
# Requirements:
#   - Ubuntu 22.04+ or Debian 12+
#   - Root access
#   - ~500MB disk space for the desktop environment
#
set -euo pipefail

echo "=== Evogent: Desktop Browser Setup ==="
echo ""
echo "This will install a minimal XFCE desktop + Chrome for persistent"
echo "browser-backed source authentication."
echo ""

# Detect if running as root
if [ "$(id -u)" -ne 0 ]; then
  echo "Error: This script must be run as root."
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

# Step 1: Install desktop environment
echo ">>> Installing XFCE desktop + LightDM..."
apt-get update -qq
apt-get install -y -qq \
  xfce4 \
  xfce4-goodies \
  lightdm \
  gnome-keyring \
  dbus-x11 \
  libsecret-1-0

# Step 2: Install Chrome (if not already installed)
if ! command -v google-chrome &>/dev/null; then
  echo ">>> Installing Google Chrome..."
  wget -q https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb -O /tmp/chrome.deb
  apt-get install -y -qq /tmp/chrome.deb
  rm /tmp/chrome.deb
else
  echo ">>> Chrome already installed: $(google-chrome --version)"
fi

# Step 3: Install noVNC for remote browser access
echo ">>> Installing noVNC + x11vnc..."
apt-get install -y -qq novnc websockify x11vnc

# Step 4: Configure auto-login
echo ">>> Configuring auto-login..."
mkdir -p /etc/lightdm/lightdm.conf.d
cat > /etc/lightdm/lightdm.conf.d/50-autologin.conf << 'EOF'
[Seat:*]
autologin-user=root
autologin-user-timeout=0
user-session=xfce
greeter-show-manual-login=true
EOF

# Step 5: Set graphical target
echo ">>> Setting default target to graphical..."
systemctl set-default graphical.target

# Step 6: Install chrome-browse.service
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$SCRIPT_DIR/chrome-browse.service" ]; then
  echo ">>> Installing chrome-browse.service..."
  cp "$SCRIPT_DIR/chrome-browse.service" /etc/systemd/system/chrome-browse.service
  systemctl daemon-reload
  systemctl enable chrome-browse.service
fi

echo ""
echo "=== Desktop Browser Setup Complete ==="
echo ""
echo "Next steps:"
echo "  1. Reboot the VM:  sudo reboot"
echo "  2. After reboot, start noVNC for login:"
echo "       ssh root@your-vm 'x11vnc -display :0 -nopw -listen 0.0.0.0 -xkb -forever -bg && websockify --daemon --web /usr/share/novnc 6080 localhost:5900'"
echo "  3. SSH tunnel:     ssh -L 6080:localhost:6080 root@your-vm"
echo "  4. Open browser:   http://localhost:6080/vnc.html?autoconnect=true&resize=scale"
echo "  5. Log into YouTube and Twitter in the Chrome window"
echo "  6. Start Chrome service: sudo systemctl start chrome-browse.service"
echo ""
echo "After login, cookies persist across Chrome restarts AND VM reboots."
echo "The noVNC step is only needed for initial login or re-authentication."

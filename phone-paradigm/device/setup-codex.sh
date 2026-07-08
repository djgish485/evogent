#!/data/data/com.termux/files/usr/bin/bash
# Install the Codex CLI on-device as an alternative Evogent brain provider (subscription-powered).
# Codex ships a STATIC musl aarch64 binary that runs directly on Android (no grun), but being
# static it bypasses Android/bionic and needs a resolv.conf (DNS) + an explicit CA bundle (TLS).
set -e
pkg install proot ca-certificates -y >/dev/null 2>&1 || true
# 1) get the binary (run on a machine with npm, then scp package/vendor/.../bin/codex to ~/.codex-bin/codex):
#    npm pack @openai/codex@<ver>-linux-arm64 ; tar xzf *.tgz
#    scp package/vendor/aarch64-unknown-linux-musl/bin/codex <device>:~/.codex-bin/codex
mkdir -p ~/.codex-bin && chmod +x ~/.codex-bin/codex 2>/dev/null || true
# 2) wrapper: proot binds resolv.conf, SSL_CERT_FILE points at the CA bundle
install -m755 "$(dirname "$0")/bin/codex" "$PREFIX/bin/codex"
# 3) auth: copy ~/.codex/auth.json from a machine where `codex login` (ChatGPT) succeeded:
#    scp ~/.codex/auth.json <device>:~/.codex/auth.json   (chmod 600)
# 4) capability: append AGENTS.phone-browse.md to ~/evogent/AGENTS.md (codex reads AGENTS.md, not .claude/skills)
grep -q "Browsing the phone.s apps" ~/evogent/AGENTS.md 2>/dev/null || cat "$(dirname "$0")/AGENTS.phone-browse.md" >> ~/evogent/AGENTS.md
# 5) switch provider: set "## Brain Provider" -> "Codex CLI" in ~/evogent/data/config.md, then restart the server.
echo "codex setup: $(codex --version 2>&1 | head -1); login: $(codex login status 2>&1 | head -1)"

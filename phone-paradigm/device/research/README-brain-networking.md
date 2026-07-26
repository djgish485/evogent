# On-device brain networking on Android

**Symptom.** A Linux-target brain binary running on Android can fail network calls with
`getaddrinfo ... EAI_AGAIN` even when authentication is valid.

**Routing check.** Do not infer that glibc sockets require a VPN, ptrace, or root. A plain glibc
`getaddrinfo` test can isolate routing from resolver configuration (`clang
--target=aarch64-unknown-linux-gnu
-nostdlibinc -isystem $G/include -nodefaultlibs -nostartfiles crt1/crti/crtn.o -l:libc.so.6
<clang_rt.builtins.a> -Wl,--dynamic-linker,$G/lib/ld-linux-aarch64.so.1`). Inspect the current
device's `ip rule` output rather than checking in its routing-table numbers.

**Common root cause (two parts).**
1. **DNS:** codex/claude are Rust binaries whose resolver reads the **literal `/etc/resolv.conf`**,
   which on Android is `/system/etc` (no usable nameserver) — NOT glibc's
   `$GLIBC_PREFIX/etc/resolv.conf`. So the brain had no nameserver → EAI_AGAIN.
2. **TLS:** once DNS was fixed the error became `invalid peer certificate: UnknownIssuer` — rustls
   couldn't find a CA bundle in the Android filesystem.

**Wrapper fix (`~/.local/bin/{codex,claude}`):**
- `proot -b ~/.evogent-resolv.conf:/etc/resolv.conf` — bind a real `nameserver 8.8.8.8` file over
  the path the Rust resolver reads.
- `SSL_CERT_FILE=/data/data/com.termux/files/usr/etc/tls/cert.pem` (+ `SSL_CERT_DIR`) — point
  rustls at Termux's CA bundle.
- then `grun ~/.codex-bin/codex "$@"` as before.

Verify the wrapper with a small authenticated command and a separate reachability check before
letting the scheduler depend on it.

`netbind.c` is an experimental LD_PRELOAD `socket()`/`getaddrinfo()` interposer. It does not
address binaries that bypass those libc calls and is not needed for the resolver-path plus
CA-bundle failure described above.

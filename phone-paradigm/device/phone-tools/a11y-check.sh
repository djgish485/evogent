#!/data/data/com.termux/files/usr/bin/bash
# Prints the byte count the Evogent accessibility service pushes over the loopback for an
# op=nodes request. >0 means the service is actually CONNECTED and responding (not just that
# the enabled_accessibility_services setting string is present). Frees a leaked listener on
# 8790 first (a stuck listener makes the bind fail and falsely reads 0).
TOKEN=$(cat "$HOME/evogent/data/control-token.txt" 2>/dev/null)
OUT="$HOME/.a11y-check.txt"; : > "$OUT"
pkill -f "8790" 2>/dev/null; sleep 1
node -e 'require("net").createServer(s=>{let d="";s.on("data",c=>d+=c);s.on("end",()=>{process.stdout.write(d);process.exit(0)})}).listen(8790,"127.0.0.1")' > "$OUT" 2>/dev/null &
LPID=$!; sleep 1
am broadcast -a net.dangish.evogent.A11Y --es op nodes --es token "$TOKEN" -p net.dangish.evogent >/dev/null 2>&1
sleep 3; kill "$LPID" 2>/dev/null; pkill -f "8790" 2>/dev/null
wc -c < "$OUT" | tr -d ' '

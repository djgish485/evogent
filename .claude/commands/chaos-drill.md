# /chaos-drill — exercise the self-healing guards against known failure modes

Run the SAFE subset of failure drills against the live system, verify each guard
detects and heals, and restore anything you disturbed. Keep exact drill dates,
live outcomes, deployment details, and incident evidence in private runtime
state. Update `.intent/failure-modes.jsonl` only when the generalized failure
class, detector, or repair mechanism changes. A guard that has never been
drilled is a guess — this command is how guards stay real.

## Iron rules

- **Backup first**: copy `data/media-agent.db` into `data/backups/` before anything else.
- **Reversible only**: every induced fault must have its restore step written down BEFORE you
  induce it. Never drill the DB itself, auth/login state, or anything touching the user's
  accounts. Never inject input on the real display (display 0).
- **Clean up loudly**: any card/notification a drill generates gets deleted after the drill
  (same-session, per the no-test-fixtures law) unless it revealed a REAL unrelated problem.
- **Record honestly**: a drill that fails or exposes a gap is the valuable
  outcome — record the live evidence privately, generalize any durable mechanism
  change into the public registry, and (if it needs code) ship one suggestion
  card.

## The standing safe drills

1. **Server death**: `pkill -9 -x node` → watchdog must restore within ~3 min (2 failed 60s
   checks → evogent-boot.sh). Verify `/api/feed` returns 200 again.
2. **Scheduler death + stale cycle**: `tmux kill-session -t evo-sched` and age
   `~/phone-tools/last-cycle-newitems` mtime past 8h → watchdog's cycle-liveness must restart
   evo-sched and ship the `cycle-liveness` card. Delete the card after; stamp self-resets.
3. **Judgment-file corruption**: back up `data/account-tiers.json` (to `~/`, NOT `/tmp` —
   Termux has no /tmp), overwrite with invalid JSON → server must keep serving (graceful
   degradation) AND `verify-intents.py` must FAIL its `datafile-*` check. Restore the file.
4. **a11y revocation**: `settings put secure enabled_accessibility_services none` via rish →
   `a11y-heal.sh` must re-arm; confirm with `a11y-check.sh` (live probe, not the settings
   string). The cycle runs heal automatically, so real revocations self-heal within a cycle.
5. **Missing browse recipe**: move a `browse-*.txt` aside → the cycle must say
   "prompt file missing, skipping" and keep going; harvest_watch counts the source barren and
   alarms at 3 cycles. Restore immediately (verify the skip line only).
6. **Barren source (simulated)**: seed `~/phone-tools/.barren-<src>` with `2` and let one
   zero-gain cycle tick it to 3 → the warning card must ship. The diagnosis agent must fire
   only when the global automatic-diagnosis slot for that service date is unspent; otherwise
   the threshold must remain durably pending and become eligible on a later service date. On
   the next gaining cycle the card must AUTO-CLEAR. (Only when a source is genuinely idle;
   never fabricate cache rows.)

## Verify-by-inspection (do not induce)

- Memory-pressure curation skip (cycle checks `free -m` before curating).
- Staged-undeployed build (watchdog deploy-guard; verify from private runtime evidence).
- Trust-gate loopback and Shizuku-down card (cycle probes rish); keep live provenance private.
- OOM orphan reaping, FK-safe deletes, byte-offset script-overwrite rule (never scp a running
  bash script).

After all drills: run `verify-intents.py` once and confirm PASS/expected state, then update the
registry and report results in one concise summary (or a single feed card if the user should
see something).

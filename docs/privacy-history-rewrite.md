# Public history privacy rewrite

This runbook creates a privacy epoch for Evogent's public Git history. It
removes identity values, private intent evidence, deployment-specific taste,
obsolete prompt snapshots, and any tracked signing material from every public
branch and tag. A signing key that actually entered public history is
compromised and must be rotated before shipping another APK. Evogent's current
development keystore was ignored and has no reachable Git history; its
preventive relocation and re-encryption instead address predictable development
credentials and an in-checkout location. Keep the protected copy outside Git and
retain the old path in the forbidden manifest as defense in depth.

The rewrite is intentionally broader than string replacement. Exact strings
cannot reliably sanitize old intent rows, prompts, comments, tests, or
hard-coded preference mechanics. Paths listed in
`scripts/history-privacy-canonical-paths.txt` therefore lose their old public
blob history and return once, with their sanitized tip content, in the privacy
epoch commit. Paths in `scripts/history-privacy-forbidden-paths.txt` remain
absent. Later public-safe commits may evolve a canonical file normally; the
verifier requires that every canonical path's first reachable introduction is
the single named privacy epoch and scans every later blob as ordinary public
history.

Canonical entries are literal paths because each must be restored from the
sanitized tip. Forbidden entries may be literal paths or narrow `glob:` rules;
the same rule is consumed by `git-filter-repo` and matched with its filename-glob
semantics by the verifier. Regex forbidden rules are deliberately
unsupported so the filtering and verification matches cannot silently diverge.

Do not run this while ordinary source work or another push is in flight.

## Preconditions

1. Finish, test, commit, and push the sanitized source tree.
2. Freeze every writer to the remote. Include bots and scheduled jobs.
3. Confirm the worktree is clean and `npm run privacy:check` passes with the
   private blob marker file.
4. Install the official `git-filter-repo` tool and confirm
   `git filter-repo --version` succeeds.
5. Choose a generic identity using an RFC-reserved email domain. The verifier
   defaults to `Evogent Contributor <contributors@example.invalid>`.
6. Keep both marker files, the backup bundle, reference snapshots, replacement
   maps, mirror, and restore archive outside every Git checkout with mode
   `0600` (or directory mode `0700`).

The private blob marker file is one exact value of at least four characters per
line. Include every known device identifier, account identifier, private handle,
address, and other value that must disappear from both blobs and Git metadata.

The separate private message marker file contains exact-case names or phrases
that must be removed only from commit and annotated-tag messages. It may contain
a three-character word: the generated rule requires a whole token and deletes
only the containing message line. This avoids turning a short personal name into
a blob literal replacement. List case variants explicitly when needed. Both
files are private inputs: never print them or paste them into an issue, CI log,
commit, or shell trace.

## Freeze and preserve

Use task-specific variables; do not aim any cleanup command at a home directory
or workspace root.

```bash
export EVOGENT_REMOTE_URL='https://example.invalid/ORG/REPOSITORY.git'
export EVOGENT_PRIMARY_BRANCH='phone-paradigm'
export EVOGENT_PRIVATE_MARKERS='/absolute/private/path/markers.txt'
export EVOGENT_PRIVATE_MESSAGE_MARKERS='/absolute/private/path/message-markers.txt'
export EVOGENT_REWRITE_ROOT="$(mktemp -d)"
chmod 700 "$EVOGENT_REWRITE_ROOT"
test "$(stat -f '%Lp' "$EVOGENT_PRIVATE_MESSAGE_MARKERS")" = 600
test "$(stat -f '%Lp' "$EVOGENT_PRIVATE_MARKERS")" = 600

git ls-remote --refs "$EVOGENT_REMOTE_URL" \
  | LC_ALL=C sort > "$EVOGENT_REWRITE_ROOT/remote-refs.before"
chmod 600 "$EVOGENT_REWRITE_ROOT/remote-refs.before"

git clone --mirror "$EVOGENT_REMOTE_URL" \
  "$EVOGENT_REWRITE_ROOT/original.git"
git -C "$EVOGENT_REWRITE_ROOT/original.git" \
  bundle create "$EVOGENT_REWRITE_ROOT/original-private.bundle" --all
chmod 600 "$EVOGENT_REWRITE_ROOT/original-private.bundle"
git -C "$EVOGENT_REWRITE_ROOT/original.git" \
  bundle verify "$EVOGENT_REWRITE_ROOT/original-private.bundle"
```

The bundle is a recovery artifact and still contains the information being
removed. It must never be published.

## Capture the sanitized privacy epoch

Archive the exact files from the already-pushed sanitized tip. Do this before
filtering, because the filter removes these paths from every old commit,
including the old tip.

```bash
EVOGENT_CANONICAL_PATH_LIST=()
while IFS= read -r EVOGENT_PATH; do
  test -n "$EVOGENT_PATH" && \
    EVOGENT_CANONICAL_PATH_LIST+=("$EVOGENT_PATH")
done < scripts/history-privacy-canonical-paths.txt

git -C "$EVOGENT_REWRITE_ROOT/original.git" archive \
  "refs/heads/$EVOGENT_PRIMARY_BRANCH" \
  -- "${EVOGENT_CANONICAL_PATH_LIST[@]}" \
  > "$EVOGENT_REWRITE_ROOT/sanitized-tip.tar"
chmod 600 "$EVOGENT_REWRITE_ROOT/sanitized-tip.tar"

LC_ALL=C sort -u \
  scripts/history-privacy-canonical-paths.txt \
  scripts/history-privacy-forbidden-paths.txt \
  > "$EVOGENT_REWRITE_ROOT/purge-paths.txt"
chmod 600 "$EVOGENT_REWRITE_ROOT/purge-paths.txt"
```

Generate exact, suppressed replacement rules from all reachable objects. A
nonzero exit is expected before the rewrite because findings still exist.

```bash
node scripts/check-public-privacy.mjs \
  --history-only \
  --root "$EVOGENT_REWRITE_ROOT/original.git" \
  --private-markers-file "$EVOGENT_PRIVATE_MARKERS" \
  --private-message-markers-file "$EVOGENT_PRIVATE_MESSAGE_MARKERS" \
  --write-private-rewrite-map \
  "$EVOGENT_REWRITE_ROOT/private-replacements.txt" \
  --write-private-message-rewrite-map \
  "$EVOGENT_REWRITE_ROOT/private-message-replacements.txt"
test -s "$EVOGENT_REWRITE_ROOT/private-replacements.txt"
test -s "$EVOGENT_REWRITE_ROOT/private-message-replacements.txt"
test "$(stat -f '%Lp' "$EVOGENT_REWRITE_ROOT/private-replacements.txt")" = 600
test "$(stat -f '%Lp' "$EVOGENT_REWRITE_ROOT/private-message-replacements.txt")" = 600
```

The blob map contains only exact, build-safe value replacements. The commit
message map additionally carries narrow, attribution-specific regex rules that
remove direct-user provenance lines. It also carries one whole-token,
whole-message-line rule per private message marker; those marker values never
enter the blob map. Generic message-only rules remove residual `verbatim`,
attributed ownership/preference, `per user feedback`, and favorite-account
provenance lines even after identity masking.

`git-filter-repo` applies literal
substitutions before regex substitutions regardless of their order in the map,
so the message map covers both the original attribution phrases and the
suppressed replacement tokens. The entire provenance line therefore disappears
after exact redaction instead of retaining a personalized shell. A message map
remains valid even when it contains only generic rules; a blob map still
requires at least one exact finding.
Never apply whole-line provenance rules to source blobs: a generic SQL fixture
containing a `user` role and timestamp can otherwise lose an entire syntactically
required line. The canonical-path purge handles multi-line semantic evidence in
tracked files.

## Rewrite only the disposable mirror

Copy the mirror first so the verified bundle and original mirror remain an
untouched recovery source.

```bash
cp -a "$EVOGENT_REWRITE_ROOT/original.git" \
  "$EVOGENT_REWRITE_ROOT/rewritten.git"

git -C "$EVOGENT_REWRITE_ROOT/rewritten.git" filter-repo --force \
  --invert-paths \
  --paths-from-file "$EVOGENT_REWRITE_ROOT/purge-paths.txt" \
  --replace-text "$EVOGENT_REWRITE_ROOT/private-replacements.txt" \
  --replace-message "$EVOGENT_REWRITE_ROOT/private-message-replacements.txt" \
  --name-callback 'return b"Evogent Contributor"' \
  --email-callback 'return b"contributors@example.invalid"'
```

`git-filter-repo` may remove the `origin` remote as a safety measure. Do not add
it back until local acceptance passes.

Restore the canonical files in a worktree on the rewritten primary branch.
Then create exactly one privacy epoch commit whose first parent is that primary
tip and whose remaining parents are every other rewritten public branch tip.
Finally, point every public branch at that epoch. This preserves every
sanitized branch history as reachable ancestry while ensuring the default
branch and stale feature branch names cannot expose an incomplete tree after
the canonical-path purge.

```bash
git --git-dir="$EVOGENT_REWRITE_ROOT/rewritten.git" \
  worktree add "$EVOGENT_REWRITE_ROOT/restore-worktree" \
  "$EVOGENT_PRIMARY_BRANCH"

tar -xf "$EVOGENT_REWRITE_ROOT/sanitized-tip.tar" \
  -C "$EVOGENT_REWRITE_ROOT/restore-worktree"

git -C "$EVOGENT_REWRITE_ROOT/restore-worktree" add -- \
  "${EVOGENT_CANONICAL_PATH_LIST[@]}"

EVOGENT_PRIMARY_TIP="$(
  git -C "$EVOGENT_REWRITE_ROOT/rewritten.git" \
    rev-parse "refs/heads/$EVOGENT_PRIMARY_BRANCH"
)"
EVOGENT_EPOCH_PARENTS=(-p "$EVOGENT_PRIMARY_TIP")
while IFS= read -r EVOGENT_BRANCH_TIP; do
  test "$EVOGENT_BRANCH_TIP" = "$EVOGENT_PRIMARY_TIP" || \
    EVOGENT_EPOCH_PARENTS+=(-p "$EVOGENT_BRANCH_TIP")
done < <(
  git -C "$EVOGENT_REWRITE_ROOT/rewritten.git" \
    for-each-ref --format='%(objectname)' refs/heads \
    | LC_ALL=C sort -u
)

EVOGENT_EPOCH_TREE="$(
  git -C "$EVOGENT_REWRITE_ROOT/restore-worktree" write-tree
)"
EVOGENT_EPOCH_COMMIT="$(
  printf '%s\n' 'Create sanitized public privacy epoch' \
    | GIT_AUTHOR_NAME='Evogent Contributor' \
      GIT_AUTHOR_EMAIL='contributors@example.invalid' \
      GIT_COMMITTER_NAME='Evogent Contributor' \
      GIT_COMMITTER_EMAIL='contributors@example.invalid' \
      git -C "$EVOGENT_REWRITE_ROOT/rewritten.git" commit-tree \
        "$EVOGENT_EPOCH_TREE" "${EVOGENT_EPOCH_PARENTS[@]}"
)"

while IFS= read -r EVOGENT_BRANCH_REF; do
  git -C "$EVOGENT_REWRITE_ROOT/rewritten.git" \
    update-ref "$EVOGENT_BRANCH_REF" "$EVOGENT_EPOCH_COMMIT"
done < <(
  git -C "$EVOGENT_REWRITE_ROOT/rewritten.git" \
    for-each-ref --format='%(refname)' refs/heads
)

test "$(
  git -C "$EVOGENT_REWRITE_ROOT/rewritten.git" \
    for-each-ref --format='%(objectname)' refs/heads \
    | LC_ALL=C sort -u \
    | wc -l \
    | tr -d ' '
)" = 1
```

The primary branch must be the already-pushed, sanitized, buildable phone tip.
All former branch names intentionally converge on the epoch commit. The private
bundle remains the recovery source for their original topology.

## Local acceptance gate

Run the normal build and focused tests from the restore worktree. Then run the
read-only history verifier:

```bash
cd "$EVOGENT_REWRITE_ROOT/restore-worktree"
npm ci
npm run lint
npm test
npm run build
node scripts/verify-public-history-rewrite.mjs \
  --private-markers-file "$EVOGENT_PRIVATE_MARKERS" \
  --private-message-markers-file "$EVOGENT_PRIVATE_MESSAGE_MARKERS"
```

That verifier requires all of the following:

- a clean worktree;
- `git fsck --full --strict --no-reflogs`;
- one generic author and committer identity across every reachable commit and
  annotated tag;
- no reachable obsolete prompt-snapshot path;
- exactly one shared introduction commit for every canonical privacy-epoch
  path, with every parent free of those paths; later revisions are allowed and
  remain subject to the all-ref privacy scan;
- zero current or all-ref privacy findings, including exact blob markers and
  message-only markers in commit and annotated-tag messages.

Also inspect the built app and Android shell before publishing. A history
rewrite is not accepted merely because textual scans pass.

## Publish with a final lease

Immediately before pushing, compare the remote with the frozen snapshot. Abort
if any ref changed.

```bash
git ls-remote --refs "$EVOGENT_REMOTE_URL" \
  | LC_ALL=C sort > "$EVOGENT_REWRITE_ROOT/remote-refs.now"
cmp "$EVOGENT_REWRITE_ROOT/remote-refs.before" \
  "$EVOGENT_REWRITE_ROOT/remote-refs.now"
```

After review, re-add the remote to the rewritten mirror and force-update only
the exact frozen public branches and tags. Build one explicit lease and one
explicit refspec per frozen writable ref, then publish them in a single atomic
transaction. Do not use `--force`, `--prune`, a wildcard refspec, or an
unrestricted `--mirror` push against a hosting service that exposes read-only
or service-owned refs.

```bash
git -C "$EVOGENT_REWRITE_ROOT/rewritten.git" \
  remote add origin "$EVOGENT_REMOTE_URL"

EVOGENT_PUSH_LEASES=()
EVOGENT_PUSH_REFSPECS=()
while IFS=$'\t' read -r EVOGENT_OLD_OID EVOGENT_REF; do
  case "$EVOGENT_REF" in
    refs/heads/*|refs/tags/*)
      EVOGENT_NEW_OID="$(
        git -C "$EVOGENT_REWRITE_ROOT/rewritten.git" \
          rev-parse --verify "$EVOGENT_REF"
      )"
      EVOGENT_PUSH_LEASES+=(
        "--force-with-lease=$EVOGENT_REF:$EVOGENT_OLD_OID"
      )
      EVOGENT_PUSH_REFSPECS+=("$EVOGENT_NEW_OID:$EVOGENT_REF")
      ;;
  esac
done < "$EVOGENT_REWRITE_ROOT/remote-refs.before"

test "${#EVOGENT_PUSH_REFSPECS[@]}" -gt 0
git -C "$EVOGENT_REWRITE_ROOT/rewritten.git" push --atomic \
  "${EVOGENT_PUSH_LEASES[@]}" \
  origin \
  "${EVOGENT_PUSH_REFSPECS[@]}"
```

Branch protection may require a temporary, deliberate administrative change.
Do not broaden that change beyond this rewrite, and restore protection
immediately.

## Verify what the public can clone

Never accept the rewritten mirror or a normal clone as proof of the remote. A
normal clone commonly omits hosting-service pull-request refs. Make a fresh
mirror clone so every advertised ref is present, compare its ref inventory with
the live advertisement, attach a detached worktree at the rewritten primary
branch, and rerun the full read-only verifier and build:

```bash
git clone --mirror "$EVOGENT_REMOTE_URL" \
  "$EVOGENT_REWRITE_ROOT/public-verification.git"
git --git-dir="$EVOGENT_REWRITE_ROOT/public-verification.git" \
  worktree add --detach \
  "$EVOGENT_REWRITE_ROOT/public-verification" \
  "refs/heads/$EVOGENT_PRIMARY_BRANCH"

git ls-remote --refs "$EVOGENT_REMOTE_URL" \
  | LC_ALL=C sort > "$EVOGENT_REWRITE_ROOT/remote-refs.after"
git --git-dir="$EVOGENT_REWRITE_ROOT/public-verification.git" \
  for-each-ref --format='%(objectname)%09%(refname)' \
  | LC_ALL=C sort > "$EVOGENT_REWRITE_ROOT/cloned-refs.after"
cmp "$EVOGENT_REWRITE_ROOT/remote-refs.after" \
  "$EVOGENT_REWRITE_ROOT/cloned-refs.after"

node "$EVOGENT_REWRITE_ROOT/public-verification/scripts/verify-public-history-rewrite.mjs" \
  --root "$EVOGENT_REWRITE_ROOT/public-verification" \
  --private-markers-file "$EVOGENT_PRIVATE_MARKERS" \
  --private-message-markers-file "$EVOGENT_PRIVATE_MESSAGE_MARKERS"

(
  cd "$EVOGENT_REWRITE_ROOT/public-verification"
  npm ci
  npm run lint
  npm test
  npm run build
)
```

An all-ref verifier proves that advertised history is clean. It does not prove
that the host stopped serving an old object by its frozen object ID. Privately
probe the old head, tag, and pull-request object IDs from
`remote-refs.before` through the host's unauthenticated object pages and API.
Never paste those IDs into public logs or issues. If any old object remains
retrievable, treat erasure as incomplete and give the private ID inventory to
the hosting provider's support team for pull-request-reference, cached-view,
and unreachable-object removal.

Then notify collaborators to delete old clones or reclone. Forks, caches,
releases, CI artifacts, package registries, and search indexes can also retain
old objects. Delete controllable artifacts and use the hosting provider's
sensitive-data removal process for everything outside Git's writable ref
namespace.

Keep the private bundle only in an encrypted private backup. Remove disposable
rewrite directories through a narrowly scoped, recoverable cleanup process
after the remote and a fresh clone have passed every check.

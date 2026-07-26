import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  privateMessageMarkerRule,
  readPrivateMessageMarkers,
  readPrivateMarkers,
  scanReachableHistory,
  scanWorkingTree,
  scanText,
  writePrivateRewriteMap,
} from "../scripts/check-public-privacy.mjs";
import {
  forbiddenRuleMatchesPath,
  forbiddenRulePathspec,
} from "../scripts/verify-public-history-rewrite.mjs";

test("reserved examples and intentional identifiers remain public-safe", () => {
  const text = [
    "contact developer@example.invalid",
    "checkout /Users/<username>/src",
    "checkout /home/runner/work/project",
    "adb -s $ANDROID_SERIAL shell true",
    "adb -s emulator-5554 shell true",
    "adb shell dumpsys activity | grep -Eo 'user serial value'",
    "package net.dangish.evogent;",
    "https://github.com/example/evogent",
  ].join("\n");

  assert.deepEqual(scanText(text), []);
});

test("personal email and absolute home matches are reported without their values", () => {
  const personalEmail = ["owner", "privacy-gate.dev"].join("@");
  const personalHome = ["/Users", "private-person", "project"].join("/");
  const findings = scanText(`${personalEmail}\n${personalHome}\n`);

  assert.deepEqual(
    findings.map(({ category }) => category),
    ["non-reserved-email", "absolute-user-home"],
  );
  assert.equal(JSON.stringify(findings).includes(personalEmail), false);
  assert.equal(JSON.stringify(findings).includes(personalHome), false);
});

test("dated direct-user provenance cannot become a public product default", () => {
  const datedEvidence = ["user", "2026-01-01"].join(" ");
  const findings = scanText(`Product rule (${datedEvidence}: direct quote).`);

  assert.deepEqual(
    findings.map(({ category }) => category),
    ["dated-direct-user-evidence"],
  );
  assert.equal(JSON.stringify(findings).includes(datedEvidence), false);
});

test("dated attributed feedback and attributed quotes stay private", () => {
  const datedAttribution = ["owner", "intent", "2026-01-01"].join(" ");
  const attributedQuote = ["the", "owner's", "words,", "verbatim"].join(" ");
  const findings = scanText(`${datedAttribution}\n${attributedQuote}`);

  assert.deepEqual(
    findings.map(({ category }) => category),
    ["dated-attributed-product-evidence", "attributed-private-quote"],
  );
});

test("direct attributed quote shapes fail without matching JSON role fixtures", () => {
  const directQuotes = [
    ["user", ': "synthetic direct evidence"'].join(""),
    ["owner", ": 'synthetic private preference'"].join(""),
    ["(user", ': "synthetic parenthesized evidence")'].join(""),
  ].join("\n");
  const findings = scanText(directQuotes);
  const fixtureJson = [
    JSON.stringify({ role: "user", content: "generic fixture content" }),
    JSON.stringify({ ["user"]: "generic fixture value" }),
  ].join("\n");

  assert.deepEqual(
    findings.map(({ category }) => category),
    [
      "attributed-private-quote",
      "attributed-private-quote",
      "attributed-private-quote",
    ],
  );
  assert.deepEqual(scanText(fixtureJson), []);
});

test("literal Android serials and durable account identifiers fail closed", () => {
  const serial = ["PIXEL", "PRIVATE", "1234"].join("");
  const accountId = ["1234567890", "1234567"].join("");
  const findings = scanText(
    `ANDROID_SERIAL=${serial}\ndevice serial is ${serial}\naccount_id=${accountId}\n`,
  );

  assert.deepEqual(
    findings.map(({ category }) => category),
    [
      "android-device-serial",
      "android-device-serial",
      "android-account-or-device-id",
    ],
  );
  assert.equal(JSON.stringify(findings).includes(serial), false);
  assert.equal(JSON.stringify(findings).includes(accountId), false);
});

test("exact marker files add private values without exposing them in results", () => {
  const directory = mkdtempSync(join(tmpdir(), "evogent-privacy-test-"));
  const markerPath = join(directory, "markers.txt");
  const marker = ["private", "marker", "value"].join("-");
  writeFileSync(markerPath, `# local only\n${marker}\n`, { mode: 0o600 });

  const privateMarkers = readPrivateMarkers([markerPath]);
  const findings = scanText(`prefix ${marker} suffix`, { privateMarkers });

  assert.equal(findings.length, 1);
  assert.equal(findings[0].category, "exact-private-marker");
  assert.equal(JSON.stringify(findings).includes(marker), false);
});

test("exact private markers are found inside NUL-bearing current and historical blobs", () => {
  const root = mkdtempSync(join(tmpdir(), "evogent-binary-privacy-test-"));
  const marker = ["binary", "private", "marker"].join("-");
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Example Contributor"], { cwd: root });
  execFileSync("git", ["config", "user.email", "contributor@example.invalid"], {
    cwd: root,
  });
  writeFileSync(
    join(root, "evidence.bin"),
    Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(marker), Buffer.from([0, 3])]),
  );
  execFileSync("git", ["add", "evidence.bin"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "binary fixture"], { cwd: root });

  const current = scanWorkingTree(root, [marker]);
  const history = scanReachableHistory(root, [marker]);
  assert.equal(
    current.findings.some(({ category }) => category === "exact-private-marker"),
    true,
  );
  assert.equal(
    history.findings.some(({ category }) => category === "exact-private-marker"),
    true,
  );
  assert.equal(JSON.stringify([...current.findings, ...history.findings]).includes(marker), false);
});

test("CLI-scoped private marker files must be private and outside the worktree", () => {
  const directory = mkdtempSync(join(tmpdir(), "evogent-marker-boundary-"));
  const root = join(directory, "repo");
  const outside = join(directory, "markers.txt");
  mkdirSync(root);
  writeFileSync(outside, "private-marker-value\n", { mode: 0o600 });
  assert.deepEqual(readPrivateMarkers([outside], root), ["private-marker-value"]);

  const inside = join(root, "markers.txt");
  writeFileSync(inside, "private-marker-value\n", { mode: 0o600 });
  assert.throws(() => readPrivateMarkers([inside], root), /outside the Git worktree/);
  chmodSync(outside, 0o644);
  assert.throws(() => readPrivateMarkers([outside], root), /mode 0600/);
});

test("public intent files reject private preference and runtime-audit detail", () => {
  const backlog = scanText(
    JSON.stringify({ kind: "preference", intent: "private by policy" }),
    { locator: ".intent/backlog.jsonl" },
  );
  const audit = scanText(
    JSON.stringify({ ts: "now", check: "curation", tasteVerdict: "private" }),
    { locator: ".intent/audit-log.jsonl" },
  );
  const genericAudit = scanText(
    JSON.stringify({
      ts: "now",
      check: "privacy-boundary",
      status: "active",
      result: "Runtime judgments remain private.",
    }),
    { locator: ".intent/audit-log.jsonl" },
  );

  assert.deepEqual(
    backlog.map(({ category }) => category),
    [
      "private-preference-ledger-entry",
      "non-general-public-backlog-entry",
    ],
  );
  assert.deepEqual(
    audit.map(({ category }) => category),
    ["private-runtime-audit-detail"],
  );
  assert.deepEqual(genericAudit, []);
});

test("public failure modes contain mechanisms, not live drill evidence", () => {
  const mechanism = scanText(
    JSON.stringify({
      mode: "server death",
      class: "process-death",
      phoneRelevant: true,
      detection: "bounded health probe",
      selfHeal: "restart the exact owner",
      gap: "retain a recovery drill",
    }),
    { locator: ".intent/failure-modes.jsonl" },
  );
  const liveEvidence = scanText(
    JSON.stringify({
      mode: "server death",
      class: "process-death",
      phoneRelevant: true,
      detection: "bounded health probe",
      selfHeal: "restart the exact owner",
      lastResult: "private live result",
    }),
    { locator: ".intent/failure-modes.jsonl" },
  );

  assert.deepEqual(mechanism, []);
  assert.deepEqual(
    liveEvidence.map(({ category }) => category),
    ["private-failure-drill-evidence"],
  );
});

test("tracked source policy cannot carry a deployment-specific account pool", () => {
  const generic = scanText(
    JSON.stringify({ accountPool: [] }),
    { locator: "data/tweet-cache-policy.json" },
  );
  const personalized = scanText(
    JSON.stringify({
      accountPool: [{ handle: "private_account", weight: 9 }],
    }),
    { locator: "data/tweet-cache-policy.json" },
  );

  assert.deepEqual(generic, []);
  assert.deepEqual(
    personalized.map(({ category }) => category),
    ["private-default-account-pool"],
  );
});

test("public backlog requires a product-wide scope and excludes direct evidence", () => {
  const generic = scanText(
    JSON.stringify({
      ts: "now",
      kind: "note",
      key: "generic-mechanism",
      area: "intent-ledger",
      intent: "Product mechanisms must generalize across deployments.",
      status: "active",
      privacy_scope: "product-wide",
    }),
    { locator: ".intent/backlog.jsonl" },
  );
  const directEvidence = scanText(
    JSON.stringify({
      ts: "now",
      kind: "directive",
      key: "private-evidence",
      area: "curation",
      intent: "A favorite source should always be first.",
      status: "active",
      privacy_scope: "product-wide",
      quote: "raw evidence",
    }),
    { locator: ".intent/backlog.jsonl" },
  );

  assert.deepEqual(generic, []);
  assert.deepEqual(
    directEvidence.map(({ category }) => category),
    ["non-general-public-backlog-entry"],
  );
});

test("public contracts cite mechanisms rather than dated personal evidence", () => {
  const generic = scanText(
    JSON.stringify({
      area: "feed",
      statement: "Ordering preserves stable identity.",
      status: "law",
      evidence: "Public feed ordering tests.",
      confidence: "product-law",
      verify_hint: "Run the ordering tests.",
    }),
    { locator: ".intent/contracts.jsonl" },
  );
  const directEvidence = scanText(
    JSON.stringify({
      area: "feed",
      statement: "Ordering preserves stable identity.",
      status: "law",
      evidence: "User requested this on 2026-01-01.",
      confidence: "established-by-user",
      verify_hint: "Inspect the feed.",
    }),
    { locator: ".intent/contracts.jsonl" },
  );

  assert.deepEqual(generic, []);
  assert.deepEqual(
    directEvidence.map(({ category }) => category),
    ["private-contract-evidence"],
  );
});

test("public contract revisions allow only explicit known supersessions", () => {
  const oldContract = {
    area: "feed",
    statement: "A historical ordering rule.",
    status: "fixed",
    evidence: "Public feed ordering tests.",
    confidence: "product-law",
    verify_hint: "Run the ordering tests.",
    key: "stable-order-contract",
  };
  const tombstone = {
    ...oldContract,
    status: "superseded",
    supersedes: ["stable-order-contract"],
  };
  const valid = scanText(
    [oldContract, tombstone].map((record) => JSON.stringify(record)).join("\n"),
    { locator: ".intent/contracts.jsonl" },
  );
  const unknown = scanText(
    JSON.stringify({
      area: "feed",
      statement: "An untraceable replacement.",
      status: "law",
      evidence: "Public feed ordering tests.",
      confidence: "product-law",
      verify_hint: "Run the ordering tests.",
      key: "replacement-contract",
      supersedes: ["missing-contract"],
    }),
    { locator: ".intent/contracts.jsonl" },
  );

  assert.deepEqual(valid, []);
  assert.deepEqual(
    unknown.map(({ category }) => category),
    ["invalid-contract-ledger-revision"],
  );
});

test("intent CLI writes only product-wide public backlog records", () => {
  const root = mkdtempSync(join(tmpdir(), "evogent-intent-cli-test-"));
  const intentDirectory = join(root, ".intent");
  const backlogPath = join(intentDirectory, "backlog.jsonl");
  const cliPath = join(process.cwd(), "scripts", "intent", "intent");
  mkdirSync(intentDirectory, { recursive: true });
  writeFileSync(backlogPath, "");
  writeFileSync(join(intentDirectory, "contracts.jsonl"), "");
  execFileSync("git", ["init", "-q"], { cwd: root });

  execFileSync(
    "python3",
    [
      cliPath,
      "append",
      JSON.stringify({
        kind: "note",
        area: "test",
        intent: "Public mechanisms generalize across deployments.",
      }),
    ],
    { cwd: root },
  );
  const text = readFileSync(backlogPath, "utf8");
  const record = JSON.parse(text.trim());

  assert.equal(record.privacy_scope, "product-wide");
  assert.deepEqual(
    Object.keys(record).sort(),
    ["area", "intent", "key", "kind", "privacy_scope", "status", "ts"],
  );
  assert.deepEqual(
    scanText(text, { locator: ".intent/backlog.jsonl" }),
    [],
  );

  const rejected = spawnSync(
    "python3",
    [
      cliPath,
      "append",
      JSON.stringify({
        kind: "preference",
        area: "test",
        intent: "A deployment-specific taste.",
        quote: "raw private evidence",
      }),
    ],
    { cwd: root, encoding: "utf8" },
  );
  assert.notEqual(rejected.status, 0);
  assert.equal(readFileSync(backlogPath, "utf8"), text);
});

test("private rewrite maps stay outside the worktree and mode 0600", () => {
  const directory = mkdtempSync(join(tmpdir(), "evogent-rewrite-map-test-"));
  const root = join(directory, "repo");
  const mapPath = join(directory, "private-rewrite-map.txt");
  const messageMapPath = join(directory, "private-message-rewrite-map.txt");
  const syntheticEmail = ["owner", "privacy-gate.dev"].join("@");
  const datedEvidence = ["user", "2026-01-01"].join(" ");
  const findings = scanText(`${syntheticEmail}\n${datedEvidence}`);

  const count = writePrivateRewriteMap(mapPath, findings, root);
  const contents = readFileSync(mapPath, "utf8");
  const messageCount = writePrivateRewriteMap(
    messageMapPath,
    findings,
    root,
    { includeGenericMessageRules: true },
  );
  const messageContents = readFileSync(messageMapPath, "utf8");
  const messageRules = messageContents.trim().split("\n");
  const genericRuleCount = messageRules.filter((rule) =>
    rule.startsWith("regex:"),
  ).length;

  assert.equal(count, 2);
  assert.equal(messageCount, count + genericRuleCount);
  assert.ok(genericRuleCount > 0);
  assert.equal(statSync(mapPath).mode & 0o777, 0o600);
  assert.equal(statSync(messageMapPath).mode & 0o777, 0o600);
  assert.equal(contents.includes(syntheticEmail), true);
  assert.equal(contents.includes(datedEvidence), true);
  assert.equal(contents.includes("regex:(?im)"), false);
  assert.equal(messageContents.includes("regex:(?im)"), true);
  assert.equal(
    messageContents.includes(
      "historical product requirement|generalized product mechanism|<private-value>",
    ),
    true,
  );
  assert.equal(messageContents.includes(String.raw`\bverbatim\b`), true);
  assert.equal(
    messageContents.includes(
      String.raw`\bfavorite(?:-account|\s+accounts?)\b`,
    ),
    true,
  );
  assert.equal(
    messageContents.includes(
      String.raw`(?:per|from)\s+(?:the\s+)?(?:user|owner)`,
    ),
    true,
  );
  assert.equal(
    messageContents.includes(
      String.raw`\b(?:user(?:'s)?|owner(?:'s)?)\b[^\r\n]*\b20`,
    ),
    false,
  );
  assert.throws(
    () => writePrivateRewriteMap(join(root, "map.txt"), findings, root),
    /outside the Git worktree/,
  );
});

test("short private message markers scan only Git messages and become whole-line rules", () => {
  const directory = mkdtempSync(join(tmpdir(), "evogent-message-marker-test-"));
  const root = join(directory, "repo");
  const markerPath = join(directory, "message-markers.txt");
  const messageMapPath = join(directory, "message-map.txt");
  const blobMapPath = join(directory, "blob-map.txt");
  const marker = ["A", "v", "a"].join("");
  const fixtureName = `${marker}-fixture.txt`;
  const syntheticEmail = ["owner", "message-marker.dev"].join("@");
  mkdirSync(root);
  writeFileSync(markerPath, `${marker}\n`, { mode: 0o600 });
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Example Contributor"], {
    cwd: root,
  });
  execFileSync(
    "git",
    ["config", "user.email", "contributor@example.invalid"],
    { cwd: root },
  );
  writeFileSync(
    join(root, fixtureName),
    `${marker} remains blob data\n${syntheticEmail}\n`,
  );
  execFileSync("git", ["add", fixtureName], { cwd: root });
  execFileSync("git", ["commit", "-q", "-m", "Safe fixture commit"], {
    cwd: root,
  });

  const privateMessageMarkers = readPrivateMessageMarkers([markerPath], root);
  const workingTreeScan = scanWorkingTree(root, [], privateMessageMarkers);
  const blobOnlyScan = scanReachableHistory(root, [], privateMessageMarkers);
  assert.equal(JSON.stringify(workingTreeScan.findings).includes(marker), false);
  assert.equal(JSON.stringify(blobOnlyScan.findings).includes(marker), false);
  assert.equal(
    blobOnlyScan.findings.some(
      ({ category }) => category === "exact-private-message-marker",
    ),
    false,
  );

  writeFileSync(
    join(root, fixtureName),
    `${marker} still remains blob data\n${syntheticEmail}\n`,
  );
  execFileSync("git", ["add", fixtureName], { cwd: root });
  execFileSync(
    "git",
    ["commit", "-q", "-m", "Keep this subject", "-m", `${marker} preference evidence`],
    { cwd: root },
  );
  execFileSync(
    "git",
    ["tag", "-a", "synthetic-tag", "-m", `${marker} actual activity evidence`],
    { cwd: root },
  );

  const scan = scanReachableHistory(root, [], privateMessageMarkers);
  const markerFindings = scan.findings.filter(
    ({ category }) => category === "exact-private-message-marker",
  );
  assert.equal(markerFindings.length, 2);
  assert.equal(JSON.stringify(markerFindings).includes(marker), false);
  assert.throws(
    () => writePrivateRewriteMap(blobMapPath, markerFindings, root),
    /No private values/,
  );

  writePrivateRewriteMap(messageMapPath, markerFindings, root, {
    includeGenericMessageRules: true,
    privateMessageMarkers,
  });
  const messageMap = readFileSync(messageMapPath, "utf8");
  assert.equal(messageMap.includes(`literal:${marker}==>`), false);
  const markerRule = privateMessageMarkerRule(marker);
  assert.equal(messageMap.includes(markerRule), true);
  assert.match(
    markerRule,
    /\^\[\^\\r\\n\]\*\(\?<\!\[A-Za-z0-9_\]\)/,
  );
  assert.match(markerRule, /\[\^\\r\\n\]\*\(\?:\\r\?\\n\|\$\)==>$/);
  const pattern = markerRule
    .slice("regex:".length, -"==>".length)
    .replace("(?m)", "");
  assert.equal(
    `Keep first line\n${marker} private line\nKeep last line\n`.replace(
      new RegExp(pattern, "gm"),
      "",
    ),
    "Keep first line\nKeep last line\n",
  );
  assert.equal(
    "Avatars remain a safe unrelated word\n".replace(
      new RegExp(pattern, "gm"),
      "",
    ),
    "Avatars remain a safe unrelated word\n",
  );

  const insidePath = join(root, "inside-markers.txt");
  writeFileSync(insidePath, `${marker}\n`, { mode: 0o600 });
  assert.throws(
    () => readPrivateMessageMarkers([insidePath], root),
    /outside the Git worktree/,
  );
  chmodSync(markerPath, 0o644);
  assert.throws(
    () => readPrivateMessageMarkers([markerPath], root),
    /mode 0600/,
  );
  const shortMarkerPath = join(directory, "short-message-markers.txt");
  writeFileSync(shortMarkerPath, "xy\n", { mode: 0o600 });
  assert.throws(
    () => readPrivateMessageMarkers([shortMarkerPath], root),
    /at least three characters/,
  );
});

test("generic commit-message map works without exact private findings", () => {
  const directory = mkdtempSync(join(tmpdir(), "evogent-message-map-test-"));
  const root = join(directory, "repo");
  const messageMapPath = join(directory, "message-map.txt");

  const count = writePrivateRewriteMap(messageMapPath, [], root, {
    includeGenericMessageRules: true,
  });
  const rules = readFileSync(messageMapPath, "utf8").trim().split("\n");

  assert.ok(count > 0);
  assert.equal(count, rules.length);
  assert.equal(rules.every((rule) => rule.startsWith("regex:")), true);
  assert.equal(statSync(messageMapPath).mode & 0o777, 0o600);
  assert.throws(
    () => writePrivateRewriteMap(join(directory, "literal-map.txt"), [], root),
    /No private values/,
  );
});

test("history verifier translates forbidden glob rules without broadening them", () => {
  const rule =
    "glob:src/lib/fixtures/feed-enrichment/parity/*/[0-9][0-9][0-9]-*.json";

  assert.equal(
    forbiddenRulePathspec(rule),
    ":(glob)src/lib/fixtures/feed-enrichment/parity/*/[0-9][0-9][0-9]-*.json",
  );
  assert.equal(
    forbiddenRulePathspec("literal:private/example.txt"),
    "private/example.txt",
  );
  assert.throws(
    () => forbiddenRulePathspec("regex:private/.+"),
    /literal and glob/,
  );
});

test("forbidden history manifest guards the retired checkout keystore path", () => {
  const manifest = readFileSync(
    join(process.cwd(), "scripts", "history-privacy-forbidden-paths.txt"),
    "utf8",
  )
    .split(/\r?\n/)
    .filter(Boolean);

  assert.equal(manifest.includes("android-shell/evogent-dev.keystore"), true);
  for (const extension of ["jks", "key", "keystore", "p12", "p8", "pfx"]) {
    const rule = `glob:*.${extension}`;
    assert.equal(manifest.includes(rule), true);
    assert.equal(forbiddenRuleMatchesPath(rule, `root.${extension}`), true);
    assert.equal(
      forbiddenRuleMatchesPath(rule, `nested/private/root.${extension}`),
      true,
    );
    assert.equal(forbiddenRuleMatchesPath(rule, `root.${extension}.txt`), false);
  }
  assert.equal(
    forbiddenRuleMatchesPath(
      "glob:src/lib/fixtures/feed-enrichment/parity/*/[0-9][0-9][0-9]-*.json",
      "src/lib/fixtures/feed-enrichment/parity/twitter/archive/001-private.json",
    ),
    true,
  );
});

test("history rewrite runbook publishes with exact leases and verifies service refs", () => {
  const runbook = readFileSync(
    join(process.cwd(), "docs", "privacy-history-rewrite.md"),
    "utf8",
  );

  assert.match(runbook, /push --atomic/);
  assert.match(runbook, /--force-with-lease=\$EVOGENT_REF:\$EVOGENT_OLD_OID/);
  assert.doesNotMatch(runbook, /--force --prune/);
  assert.doesNotMatch(runbook, /refs\/heads\/\*:refs\/heads\/\*/);
  assert.match(runbook, /clone --mirror/);
  assert.match(runbook, /pull-request refs/);
  assert.match(runbook, /npm run build/);
  assert.match(runbook, /old object remains\s+retrievable/);
  assert.match(runbook, /hosting provider's support team/);
});

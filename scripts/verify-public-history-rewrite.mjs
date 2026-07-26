#!/usr/bin/env node

/**
 * Read-only acceptance check for a privacy history rewrite.
 *
 * This intentionally scans every ref and every reachable commit rather than
 * trusting the default branch. Matched private values are never printed.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  readPrivateMessageMarkers,
  readPrivateMarkers,
  scanReachableHistory,
  scanWorkingTree,
} from "./check-public-privacy.mjs";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CANONICAL_PATHS_FILE = resolve(
  SCRIPT_DIRECTORY,
  "history-privacy-canonical-paths.txt",
);
const DEFAULT_FORBIDDEN_PATHS_FILE = resolve(
  SCRIPT_DIRECTORY,
  "history-privacy-forbidden-paths.txt",
);

function runGit(root, args, { allowFailure = false } = {}) {
  try {
    return execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      maxBuffer: 512 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    if (allowFailure) return "";
    const operation = args.slice(0, 2).join(" ");
    throw new Error(`Git verification failed while running ${operation}`);
  }
}

function readPathList(path) {
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

function parseArgs(argv) {
  const options = {
    canonicalPathsFile: DEFAULT_CANONICAL_PATHS_FILE,
    expectedEmail: "contributors@example.invalid",
    expectedName: "Evogent Contributor",
    forbiddenPathsFile: DEFAULT_FORBIDDEN_PATHS_FILE,
    markerPaths: [],
    messageMarkerPaths: [],
    root: process.cwd(),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = argv[index + 1];
    if (argument === "--root" && next) {
      options.root = resolve(next);
      index += 1;
    } else if (argument === "--private-markers-file" && next) {
      options.markerPaths.push(resolve(next));
      index += 1;
    } else if (argument === "--private-message-markers-file" && next) {
      options.messageMarkerPaths.push(resolve(next));
      index += 1;
    } else if (argument === "--expected-name" && next) {
      options.expectedName = next;
      index += 1;
    } else if (argument === "--expected-email" && next) {
      options.expectedEmail = next;
      index += 1;
    } else if (argument === "--canonical-paths-file" && next) {
      options.canonicalPathsFile = resolve(next);
      index += 1;
    } else if (argument === "--forbidden-paths-file" && next) {
      options.forbiddenPathsFile = resolve(next);
      index += 1;
    } else if (argument === "--help") {
      options.help = true;
    } else {
      throw new Error(`Unknown or incomplete argument: ${argument}`);
    }
  }
  return options;
}

function printHelp() {
  process.stdout.write(
    [
      "Usage: node scripts/verify-public-history-rewrite.mjs [options]",
      "",
      "Required:",
      "  --private-markers-file <path>   Repeat for each mode-0600 marker file",
      "  --private-message-markers-file <path>",
      "                                  Repeat for message-only mode-0600 files outside the checkout",
      "",
      "Options:",
      "  --root <path>                   Rewritten fresh clone (default: current directory)",
      "  --expected-name <name>          Rewritten Git identity",
      "  --expected-email <email>        Rewritten Git email",
      "  --canonical-paths-file <path>   Paths allowed one sanitized blob across all refs",
      "  --forbidden-paths-file <path>   Literal/glob paths absent from every ref",
      "",
      "This command is read-only and never prints matched private values.",
      "",
    ].join("\n"),
  );
}

function verifyCleanWorktree(root) {
  const status = runGit(root, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status.trim()) {
    throw new Error("The rewritten verification clone is not clean");
  }
}

function verifyRepositoryIntegrity(root) {
  runGit(root, ["fsck", "--full", "--strict", "--no-reflogs"]);
}

function verifyPrivacyGate(root, privateMarkers, privateMessageMarkers) {
  const current = scanWorkingTree(
    root,
    privateMarkers,
    privateMessageMarkers,
  );
  const history = scanReachableHistory(
    root,
    privateMarkers,
    privateMessageMarkers,
  );
  const findings = [...current.findings, ...history.findings];
  if (findings.length > 0) {
    const categories = new Map();
    for (const item of findings) {
      categories.set(item.category, (categories.get(item.category) ?? 0) + 1);
    }
    const summary = [...categories]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([category, count]) => `${category}=${count}`)
      .join(", ");
    throw new Error(
      `Privacy gate found ${findings.length} suppressed finding(s): ${summary}`,
    );
  }
  return {
    currentFiles: current.scannedFiles,
    reachableObjects: history.scannedObjects,
  };
}

export function forbiddenRulePathspec(rule) {
  if (rule.startsWith("literal:")) return rule.slice("literal:".length);
  if (rule.startsWith("glob:")) return `:(glob)${rule.slice("glob:".length)}`;
  if (rule.startsWith("regex:")) {
    throw new Error(
      "Forbidden history paths support literal and glob rules, not regex rules",
    );
  }
  return rule;
}

function filterRepoGlobRegex(pattern) {
  let expression = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*") {
      expression += "[^]*";
    } else if (character === "?") {
      expression += "[^]";
    } else if (character === "[") {
      const close = pattern.indexOf("]", index + 1);
      if (close === -1) {
        expression += "\\[";
        continue;
      }
      let body = pattern.slice(index + 1, close);
      if (body.startsWith("!")) body = `^${body.slice(1)}`;
      body = body.replaceAll("\\", "\\\\");
      expression += `[${body}]`;
      index = close;
    } else {
      expression += character.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
    }
  }
  return new RegExp(`^${expression}$`, "u");
}

export function forbiddenRuleMatchesPath(rule, path) {
  if (rule.startsWith("literal:")) {
    return path === rule.slice("literal:".length);
  }
  if (rule.startsWith("glob:")) {
    return filterRepoGlobRegex(rule.slice("glob:".length)).test(path);
  }
  if (rule.startsWith("regex:")) {
    throw new Error(
      "Forbidden history paths support literal and glob rules, not regex rules",
    );
  }
  return path === rule;
}

function verifyForbiddenPaths(root, forbiddenPaths) {
  const historicalPaths = runGit(root, ["rev-list", "--objects", "--all"])
    .split(/\r?\n/)
    .map((line) => {
      const separator = line.indexOf(" ");
      return separator === -1 ? "" : line.slice(separator + 1);
    })
    .filter(Boolean);
  const present = [];
  for (const rule of forbiddenPaths) {
    if (historicalPaths.some((path) => forbiddenRuleMatchesPath(rule, path))) {
      present.push(rule);
    }
  }
  if (present.length > 0) {
    throw new Error(
      `${present.length} forbidden path(s) still have reachable history: ${present.join(", ")}`,
    );
  }
}

function blobAt(root, commit, path) {
  const row = runGit(
    root,
    ["ls-tree", "-z", commit, "--", path],
    { allowFailure: true },
  );
  if (!row) return null;
  const headerEnd = row.indexOf("\t");
  if (headerEnd === -1) return null;
  const fields = row.slice(0, headerEnd).split(" ");
  return fields[1] === "blob" ? fields[2] : null;
}

function verifyCanonicalPaths(root, canonicalPaths) {
  const problems = [];
  for (const path of canonicalPaths) {
    const tipBlob = blobAt(root, "HEAD", path);
    if (!tipBlob) {
      problems.push(`${path} is missing from HEAD`);
      continue;
    }

    const changeCommits = runGit(root, [
      "log",
      "--all",
      "--format=%H",
      "--",
      path,
    ])
      .split(/\r?\n/)
      .filter(Boolean);
    const blobs = new Set();
    for (const commit of changeCommits) {
      const blob = blobAt(root, commit, path);
      if (blob) blobs.add(blob);
    }
    if (blobs.size !== 1 || !blobs.has(tipBlob)) {
      problems.push(`${path} has ${blobs.size} reachable historical blob version(s)`);
    }
  }
  if (problems.length > 0) {
    throw new Error(`Canonical privacy epoch failed:\n- ${problems.join("\n- ")}`);
  }
}

function verifyCommitIdentity(root, expectedName, expectedEmail) {
  const output = runGit(root, [
    "log",
    "--all",
    "--format=%an%x00%ae%x00%cn%x00%ce%x00",
  ]);
  const fields = output.split("\0").map((field) => field.trim()).filter(Boolean);
  const unexpectedNames = new Set();
  const unexpectedEmails = new Set();
  for (let index = 0; index + 3 < fields.length; index += 4) {
    const [authorName, authorEmail, committerName, committerEmail] =
      fields.slice(index, index + 4);
    if (authorName !== expectedName) unexpectedNames.add(authorName);
    if (committerName !== expectedName) unexpectedNames.add(committerName);
    if (authorEmail !== expectedEmail) unexpectedEmails.add(authorEmail);
    if (committerEmail !== expectedEmail) unexpectedEmails.add(committerEmail);
  }

  const tagOutput = runGit(root, [
    "for-each-ref",
    "refs/tags",
    "--format=%(taggername)%00%(taggeremail)%00",
  ]);
  const tagFields = tagOutput
    .split("\0")
    .map((field) => field.trim())
    .filter(Boolean);
  for (let index = 0; index + 1 < tagFields.length; index += 2) {
    const taggerName = tagFields[index];
    const taggerEmail = tagFields[index + 1].replace(/^<|>$/g, "");
    if (taggerName !== expectedName) unexpectedNames.add(taggerName);
    if (taggerEmail !== expectedEmail) unexpectedEmails.add(taggerEmail);
  }

  if (unexpectedNames.size > 0 || unexpectedEmails.size > 0) {
    throw new Error(
      "Reachable Git metadata still contains a non-canonical identity; values are suppressed",
    );
  }
}

const isMain =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      printHelp();
      process.exitCode = 0;
    } else {
      if (options.markerPaths.length === 0) {
        throw new Error("At least one --private-markers-file is required");
      }
      if (options.messageMarkerPaths.length === 0) {
        throw new Error(
          "At least one --private-message-markers-file is required",
        );
      }
      const markers = readPrivateMarkers(options.markerPaths, options.root);
      if (markers.length === 0) {
        throw new Error("Private marker files did not contain any values");
      }
      const messageMarkers = readPrivateMessageMarkers(
        options.messageMarkerPaths,
        options.root,
      );
      if (messageMarkers.length === 0) {
        throw new Error(
          "Private message marker files did not contain any values",
        );
      }

      verifyCleanWorktree(options.root);
      verifyRepositoryIntegrity(options.root);
      verifyCommitIdentity(
        options.root,
        options.expectedName,
        options.expectedEmail,
      );
      verifyForbiddenPaths(
        options.root,
        readPathList(options.forbiddenPathsFile),
      );
      verifyCanonicalPaths(
        options.root,
        readPathList(options.canonicalPathsFile),
      );
      const scan = verifyPrivacyGate(
        options.root,
        markers,
        messageMarkers,
      );
      process.stdout.write(
        `History privacy verification passed (${scan.currentFiles} current files, `
          + `${scan.reachableObjects} reachable objects).\n`,
      );
    }
  } catch (error) {
    process.stderr.write(
      `History privacy verification failed: ${error.message}\n`,
    );
    process.exitCode = 1;
  }
}

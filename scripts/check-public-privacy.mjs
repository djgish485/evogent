#!/usr/bin/env node

/**
 * Fail closed when public source material contains common forms of personal
 * identity or device identity.
 *
 * The diagnostic intentionally never prints the matched value. A short digest
 * makes repeated findings distinguishable without turning CI logs into another
 * disclosure surface.
 */

import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fchmodSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { relative, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const RESERVED_EMAIL_DOMAINS = new Set([
  "example.com",
  "example.net",
  "example.org",
  "example.invalid",
]);

const SAFE_HOME_SEGMENTS = new Set([
  "$user",
  "${user}",
  "<name>",
  "<user>",
  "<username>",
  "example",
  "me",
  "name",
  "runner",
  "user",
  "username",
  "your-name",
  "your_name",
  "yourname",
]);

const SAFE_DEVICE_IDENTIFIERS = [
  /^[$%]/,
  /^\$\{/,
  /^</,
  /^(?:android|device|pixel|serial)$/i,
  /^(?:example|placeholder|redacted|replace[-_]?me|your[-_]?(?:device|serial))$/i,
  /^(?=[A-Z0-9_]*_(?:DEVICE|SERIAL)|(?:DEVICE|SERIAL)_)[A-Z][A-Z0-9_]*$/,
  /^emulator-\d+$/i,
  /^(?:localhost|127\.0\.0\.1):\d+$/i,
];

const EMAIL_RE =
  /(?<![A-Z0-9._%+-])([A-Z0-9._%+-]+)@([A-Z0-9.-]+\.[A-Z]{2,})(?![A-Z0-9._%+-])/gi;
const MACOS_HOME_RE = /\/Users\/([^/\s"'`\\]+)/g;
const LINUX_HOME_RE = /(?<![A-Za-z0-9._-])\/home\/([^/\s"'`\\]+)/g;
const WINDOWS_HOME_RE = /\b[A-Z]:\\Users\\([^\\\s"'`/]+)/gi;
const DATED_USER_EVIDENCE_RE =
  /\buser\s+(?:said\s+|asked\s+|requested\s+)?(?:on\s+)?20[0-9]{2}(?:[-/][0-9]{2}){0,2}|\(user\s+20[0-9]{2}/gi;
const DATED_ATTRIBUTED_PRODUCT_EVIDENCE_RE =
  /\b(?:user|owner)(?:'s)?\s+(?:words?|intent|request|feedback|complaint|reads?|called|finds?|rejected|notices?)\b[^\r\n]{0,160}\b20[0-9]{2}(?:[-/][0-9]{2}){0,2}\b|\b20[0-9]{2}(?:[-/][0-9]{2}){0,2}\b[^\r\n]{0,160}\b(?:user|owner)(?:'s)?\s+(?:words?|intent|request|feedback|complaint|reads?|called|finds?|rejected|notices?)\b/gi;
const ATTRIBUTED_QUOTE_RE =
  /\bthe\s+(?:user|owner)(?:'s)?\s+words,\s*verbatim\b/gi;
const DIRECT_ATTRIBUTED_QUOTE_RE =
  /\b(?:user|owner)\s*:\s*(?:"[^"\r\n]+"|'[^'\r\n]+'|“[^”\r\n]+”)/gi;

const SERIAL_PATTERNS = [
  /\badb(?:\s+(?:-(?:H|P|L)\s+\S+|-(?:a|d|e)))*\s+-s\s+["']?([A-Za-z0-9][A-Za-z0-9._:-]{5,})/gi,
  /\b(?:ANDROID_SERIAL|DEVICE_SERIAL|PIXEL_SERIAL|deviceSerial|serial(?:_number)?)\b\s*[:=]\s*["']?([A-Za-z0-9][A-Za-z0-9._:-]{5,})/gi,
  /\b(?:device\s+)?serial(?:\s+(?:is|was))?\s+(?:number\s+)?["'`]?(?=[A-Za-z0-9._:-]{6,}\b)(?=[A-Za-z0-9._:-]*\d)([A-Za-z0-9][A-Za-z0-9._:-]{5,})/gi,
  /["']serial["']\s*:\s*["']([A-Za-z0-9][A-Za-z0-9._:-]{5,})["']/gi,
];

const UID_PATTERNS = [
  /\b(?:android[_-]?id|gaia[_-]?id|device[_-]?id|account[_-]?id|uid)\b\s*[:=]\s*["']?([0-9a-f]{16}|[0-9]{15,22}|u\d+_a\d+)\b/gi,
];

const SENSITIVE_VALUE = Symbol("sensitive-value");
const GENERIC_HISTORY_REWRITE_RULES = [
  String.raw`regex:(?im)^[^\r\n]*\buser\s+(?:said|asked|requested)\s+(?:on\s+)?20[0-9]{2}(?:[-/][0-9]{2}){0,2}\b[^\r\n]*(?:\r?\n|$)==>`,
  String.raw`regex:(?im)^[^\r\n]*\(\s*user\s+20[0-9]{2}(?:[-/][0-9]{2}){0,2}\b[^\r\n]*(?:\r?\n|$)==>`,
  String.raw`regex:(?im)^[^\r\n]*\b(?:user|owner)(?:'s)?\s+(?:words?|intent|request|feedback|complaint|reads?|called|finds?|rejected|notices?)\b[^\r\n]{0,160}\b20[0-9]{2}(?:[-/][0-9]{2}){0,2}\b[^\r\n]*(?:\r?\n|$)==>`,
  String.raw`regex:(?im)^[^\r\n]*\b20[0-9]{2}(?:[-/][0-9]{2}){0,2}\b[^\r\n]{0,160}\b(?:user|owner)(?:'s)?\s+(?:words?|intent|request|feedback|complaint|reads?|called|finds?|rejected|notices?)\b[^\r\n]*(?:\r?\n|$)==>`,
  String.raw`regex:(?im)^[^\r\n]*\bthe\s+(?:user|owner)(?:'s)?\s+words,\s*verbatim\b[^\r\n]*(?:\r?\n|$)==>`,
  String.raw`regex:(?im)^[^\r\n]*\b(?:user|owner)\s+verbatim\s*:[^\r\n]*(?:\r?\n|$)==>`,
  String.raw`regex:(?im)^[^\r\n]*\b(?:user|owner)\s*:\s*['"“][^\r\n]*(?:\r?\n|$)==>`,
  String.raw`regex:(?im)^[^\r\n]*\b(?:per|from)\s+(?:the\s+)?(?:user|owner)(?:'s)?\s+(?:feedback|request|complaint)\b[^\r\n]*(?:\r?\n|$)==>`,
  String.raw`regex:(?im)^[^\r\n]*\bverbatim\b[^\r\n]*(?:\r?\n|$)==>`,
  String.raw`regex:(?im)^[^\r\n]*(?:\b(?:his|him|he)\b[^\r\n]{0,160}\b(?:actual|real|preference|reason|account|activity)\b|\b(?:actual|real|preference|reason|account|activity)\b[^\r\n]{0,160}\b(?:his|him|he)\b)[^\r\n]*(?:\r?\n|$)==>`,
  String.raw`regex:(?im)^[^\r\n]*\bfavorite(?:-account|\s+accounts?)\b[^\r\n]*(?:\r?\n|$)==>`,
  // git-filter-repo applies literal substitutions before regex substitutions.
  // Remove any provenance line that now contains one of our suppressed
  // replacement tokens instead of its original private text.
  String.raw`regex:(?im)^[^\r\n]*(?:historical product requirement|generalized product mechanism|<private-value>)[^\r\n]*(?:\r?\n|$)==>`,
];

function sha256Prefix(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function buildLineStarts(text) {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

function lineNumberAt(lineStarts, index) {
  let low = 0;
  let high = lineStarts.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (lineStarts[middle] <= index) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

function looksBinary(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  return sample.includes(0);
}

function scanBinaryPrivateMarkers(buffer, locator, privateMarkers) {
  const findings = [];
  for (const marker of privateMarkers) {
    const encoded = Buffer.from(marker, "utf8");
    let start = 0;
    while (encoded.length > 0 && (start = buffer.indexOf(encoded, start)) !== -1) {
      const item = {
        category: "exact-private-marker",
        locator,
        line: 1,
        fingerprint: sha256Prefix(marker),
      };
      Object.defineProperty(item, SENSITIVE_VALUE, {
        value: marker,
        enumerable: false,
      });
      findings.push(item);
      start += encoded.length;
    }
  }
  return findings;
}

function isReservedEmailDomain(domain) {
  const normalized = domain.toLowerCase();
  return (
    RESERVED_EMAIL_DOMAINS.has(normalized) ||
    normalized.endsWith(".example") ||
    normalized.endsWith(".invalid") ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".test")
  );
}

function isSafePlaceholder(value, safeValues) {
  const normalized = value.trim().toLowerCase();
  return (
    safeValues.has(normalized) ||
    normalized.startsWith("${") ||
    normalized.startsWith("<") ||
    normalized.includes("placeholder") ||
    normalized.includes("redacted")
  );
}

function isSafeDeviceIdentifier(value) {
  return SAFE_DEVICE_IDENTIFIERS.some((pattern) => pattern.test(value));
}

function finding(category, value, index, locator, lineStarts) {
  const item = {
    category,
    locator,
    line: lineNumberAt(lineStarts, index),
    fingerprint: sha256Prefix(value),
  };
  Object.defineProperty(item, SENSITIVE_VALUE, {
    value,
    enumerable: false,
  });
  return item;
}

function scanIntentPrivacyBoundary(text, locator, makeFinding) {
  const findings = [];
  const isPublicBacklog =
    locator !== "<path>" && locator.includes(".intent/backlog.jsonl");
  const isPublicAudit =
    locator !== "<path>" && locator.includes(".intent/audit-log.jsonl");
  const isPublicContracts =
    locator !== "<path>" && locator.includes(".intent/contracts.jsonl");
  const isPublicFailureModes =
    locator !== "<path>" && locator.includes(".intent/failure-modes.jsonl");
  if (
    !isPublicBacklog
    && !isPublicAudit
    && !isPublicContracts
    && !isPublicFailureModes
  ) {
    return findings;
  }

  const publicAuditKeys = new Set(["ts", "check", "status", "result"]);
  const publicBacklogKeys = new Set([
    "ts",
    "kind",
    "key",
    "area",
    "intent",
    "status",
    "privacy_scope",
    "supersedes",
  ]);
  const ownerSpecificLanguage =
    /\b(?:my|mine|owner(?:'s)?|favo(?:u)?rite|logged[- ]in|inbox|account handle|device serial|current phone|live feed)\b/i;
  const publicContractKeys = new Set([
    "area",
    "statement",
    "status",
    "evidence",
    "confidence",
    "verify_hint",
    "key",
    "supersedes",
  ]);
  const directEvidenceLanguage =
    /\b(?:user|owner|I|me|my|mine|we|our)\b|20[0-9]{2}[-/][0-9]{2}|["“”]/i;
  const contractOwnerSpecificLanguage =
    /\b(?:my|owner(?:'s)?|logged[- ]in|account handle|device serial|current phone|live feed)\b/i;
  const publicFailureModeKeys = new Set([
    "mode",
    "class",
    "phoneRelevant",
    "detection",
    "selfHeal",
    "gap",
  ]);
  const knownContractKeys = new Set();
  const retiredContractKeys = new Set();
  const contractKeyPattern = /^[a-z0-9][a-z0-9._:-]{2,127}$/;
  const legacyContractKey = (record) => {
    const area = String(record.area ?? "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");
    const statement = String(record.statement ?? "")
      .trim()
      .replace(/\s+/g, " ");
    return `contract-${createHash("sha256")
      .update(`${area}\0${statement}`)
      .digest("hex")
      .slice(0, 16)}`;
  };
  let offset = 0;
  for (const line of text.split(/\n/)) {
    if (!line.trim()) {
      offset += line.length + 1;
      continue;
    }
    try {
      const record = JSON.parse(line);
      if (isPublicBacklog && record.kind === "preference") {
        findings.push(
          makeFinding("private-preference-ledger-entry", "kind:preference", offset),
        );
      }
      if (
        isPublicBacklog &&
        (record.privacy_scope !== "product-wide" ||
          Object.keys(record).some((key) => !publicBacklogKeys.has(key)) ||
          ownerSpecificLanguage.test(String(record.intent ?? "")))
      ) {
        findings.push(
          makeFinding(
            "non-general-public-backlog-entry",
            "backlog-entry-needs-manual-generalization",
            offset,
          ),
        );
      }
      if (
        isPublicAudit &&
        (record.check !== "privacy-boundary" ||
          Object.keys(record).some((key) => !publicAuditKeys.has(key)))
      ) {
        findings.push(
          makeFinding("private-runtime-audit-detail", "non-public-audit-field", offset),
        );
      }
      if (
        isPublicContracts &&
        (record.confidence !== "product-law" ||
          !["law", "open", "verified", "fixed", "superseded"].includes(record.status) ||
          Object.keys(record).some((key) => !publicContractKeys.has(key)) ||
          directEvidenceLanguage.test(String(record.evidence ?? "")) ||
          contractOwnerSpecificLanguage.test(String(record.statement ?? "")))
      ) {
        findings.push(
          makeFinding(
            "private-contract-evidence",
            "contract-needs-public-mechanism-evidence",
            offset,
          ),
        );
      }
      if (isPublicContracts) {
        const key = record.key ?? legacyContractKey(record);
        const supersedes = record.supersedes;
        let revisionIsValid =
          typeof record.area === "string"
          && record.area.trim().length > 0
          && typeof record.statement === "string"
          && record.statement.trim().length > 0
          && typeof key === "string"
          && contractKeyPattern.test(key);
        let targets = [];
        if (supersedes !== undefined) {
          revisionIsValid =
            revisionIsValid
            && Array.isArray(supersedes)
            && supersedes.length > 0
            && supersedes.every(
              (target) =>
                typeof target === "string" && contractKeyPattern.test(target),
            )
            && new Set(supersedes).size === supersedes.length;
          if (Array.isArray(supersedes)) targets = supersedes;
        }
        if (
          knownContractKeys.has(key)
          && !targets.includes(key)
        ) {
          revisionIsValid = false;
        }
        if (targets.some((target) => !knownContractKeys.has(target))) {
          revisionIsValid = false;
        }
        if (
          record.status === "superseded"
          && (
            !knownContractKeys.has(key)
            || targets.length !== 1
            || targets[0] !== key
          )
        ) {
          revisionIsValid = false;
        }
        const crossTargets = targets.filter((target) => target !== key);
        if (crossTargets.some((target) => retiredContractKeys.has(target))) {
          revisionIsValid = false;
        }
        if (!revisionIsValid) {
          findings.push(
            makeFinding(
              "invalid-contract-ledger-revision",
              "contract-revision-needs-valid-known-supersession",
              offset,
            ),
          );
        } else {
          knownContractKeys.add(key);
          for (const target of crossTargets) retiredContractKeys.add(target);
        }
      }
      if (
        isPublicFailureModes
        && Object.keys(record).some((key) => !publicFailureModeKeys.has(key))
      ) {
        findings.push(
          makeFinding(
            "private-failure-drill-evidence",
            "failure-mode-runtime-evidence-must-stay-private",
            offset,
          ),
        );
      }
    } catch {
      // JSONL syntax belongs to the intent-ledger validator, not this privacy gate.
    }
    offset += line.length + 1;
  }
  return findings;
}

function scanTrackedDefaultPrivacyBoundary(text, locator, makeFinding) {
  if (
    locator === "<path>"
    || !locator.includes("data/tweet-cache-policy.json")
  ) {
    return [];
  }
  try {
    const policy = JSON.parse(text);
    if (Array.isArray(policy.accountPool) && policy.accountPool.length > 0) {
      return [
        makeFinding(
          "private-default-account-pool",
          "tracked-source-account-pool-must-be-empty",
          0,
        ),
      ];
    }
  } catch {
    // JSON syntax belongs to the policy consumer and its tests.
  }
  return [];
}

export function scanText(text, { locator = "<memory>", privateMarkers = [] } = {}) {
  const findings = [];
  const lineStarts = buildLineStarts(text);
  const makeFinding = (category, value, index) =>
    finding(category, value, index, locator, lineStarts);

  for (const match of text.matchAll(EMAIL_RE)) {
    if (!isReservedEmailDomain(match[2])) {
      findings.push(makeFinding("non-reserved-email", match[0], match.index));
    }
  }

  for (const pattern of [MACOS_HOME_RE, LINUX_HOME_RE]) {
    for (const match of text.matchAll(pattern)) {
      if (!isSafePlaceholder(match[1], SAFE_HOME_SEGMENTS)) {
        findings.push(makeFinding("absolute-user-home", match[0], match.index));
      }
    }
  }

  for (const match of text.matchAll(WINDOWS_HOME_RE)) {
    if (!isSafePlaceholder(match[1], SAFE_HOME_SEGMENTS)) {
      findings.push(makeFinding("absolute-user-home", match[0], match.index));
    }
  }

  for (const match of text.matchAll(DATED_USER_EVIDENCE_RE)) {
    findings.push(makeFinding("dated-direct-user-evidence", match[0], match.index));
  }
  for (const match of text.matchAll(DATED_ATTRIBUTED_PRODUCT_EVIDENCE_RE)) {
    findings.push(
      makeFinding("dated-attributed-product-evidence", match[0], match.index),
    );
  }
  for (const match of text.matchAll(ATTRIBUTED_QUOTE_RE)) {
    findings.push(makeFinding("attributed-private-quote", match[0], match.index));
  }
  for (const match of text.matchAll(DIRECT_ATTRIBUTED_QUOTE_RE)) {
    findings.push(makeFinding("attributed-private-quote", match[0], match.index));
  }

  for (const pattern of SERIAL_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      if (!isSafeDeviceIdentifier(match[1])) {
        findings.push(makeFinding("android-device-serial", match[1], match.index));
      }
    }
  }

  for (const pattern of UID_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      if (!isSafeDeviceIdentifier(match[1])) {
        findings.push(
          makeFinding("android-account-or-device-id", match[1], match.index),
        );
      }
    }
  }

  for (const marker of privateMarkers) {
    let start = 0;
    while (marker && (start = text.indexOf(marker, start)) !== -1) {
      findings.push(makeFinding("exact-private-marker", marker, start));
      start += marker.length;
    }
  }

  findings.push(...scanIntentPrivacyBoundary(text, locator, makeFinding));
  findings.push(
    ...scanTrackedDefaultPrivacyBoundary(text, locator, makeFinding),
  );

  const unique = new Map();
  for (const item of findings) {
    const key = `${item.category}\0${item.locator}\0${item.line}\0${item.fingerprint}`;
    unique.set(key, item);
  }
  return [...unique.values()];
}

export function readPrivateMarkers(paths, root) {
  const markers = new Set();
  for (const path of paths) {
    let canonicalPath;
    let stats;
    try {
      canonicalPath = realpathSync(path);
      stats = statSync(canonicalPath);
    } catch {
      throw new Error("Unable to read a private marker file");
    }
    if (!stats.isFile()) {
      throw new Error("Private marker inputs must be regular files");
    }
    if (root && !isOutsideWorktree(canonicalPath, realpathSync(root))) {
      throw new Error("Private marker files must be outside the Git worktree");
    }
    if ((stats.mode & 0o777) !== 0o600) {
      throw new Error("Private marker files must have mode 0600");
    }
    const text = readFileSync(canonicalPath, "utf8");
    for (const rawLine of text.split(/\r?\n/)) {
      const marker = rawLine.trim();
      if (!marker || marker.startsWith("#")) continue;
      if (marker.length < 4) {
        throw new Error(`Private markers must contain at least four characters (${path})`);
      }
      markers.add(marker);
    }
  }
  return [...markers];
}

function isOutsideWorktree(path, root) {
  const relativeToRoot = relative(resolve(root), resolve(path));
  return (
    relativeToRoot !== ""
    && (relativeToRoot.startsWith("..") || relativeToRoot.startsWith("/"))
  );
}

export function readPrivateMessageMarkers(paths, root) {
  const markers = new Set();
  for (const path of paths) {
    let canonicalPath;
    let stats;
    try {
      canonicalPath = realpathSync(path);
      stats = statSync(canonicalPath);
    } catch {
      throw new Error("Unable to read a private message marker file");
    }
    if (!stats.isFile()) {
      throw new Error("Private message marker inputs must be regular files");
    }
    if (!isOutsideWorktree(canonicalPath, realpathSync(root))) {
      throw new Error(
        "Private message marker files must be outside the Git worktree",
      );
    }
    const mode = stats.mode & 0o777;
    if (mode !== 0o600) {
      throw new Error("Private message marker files must have mode 0600");
    }
    let text;
    try {
      text = readFileSync(canonicalPath, "utf8");
    } catch {
      throw new Error("Unable to read a private message marker file");
    }
    for (const rawLine of text.split(/\r?\n/)) {
      const marker = rawLine.trim();
      if (!marker || marker.startsWith("#")) continue;
      if (marker.length < 3) {
        throw new Error(
          "Private message markers must contain at least three characters",
        );
      }
      if (marker.includes("\0") || marker.includes("==>")) {
        throw new Error(
          "A private message marker cannot be represented safely",
        );
      }
      markers.add(marker);
    }
  }
  return [...markers];
}

function escapeRegexLiteral(value) {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

export function privateMessageMarkerRule(marker) {
  const escaped = escapeRegexLiteral(marker);
  const leftBoundary = /^[A-Za-z0-9_]/.test(marker)
    ? String.raw`(?<![A-Za-z0-9_])`
    : "";
  const rightBoundary = /[A-Za-z0-9_]$/.test(marker)
    ? String.raw`(?![A-Za-z0-9_])`
    : "";
  return (
    String.raw`regex:(?m)^[^\r\n]*`
    + leftBoundary
    + escaped
    + rightBoundary
    + String.raw`[^\r\n]*(?:\r?\n|$)==>`
  );
}

function scanPrivateMessageMarkers(text, locator, privateMessageMarkers) {
  const lineStarts = buildLineStarts(text);
  const findings = [];
  for (const marker of privateMessageMarkers) {
    const escaped = escapeRegexLiteral(marker);
    const leftBoundary = /^[A-Za-z0-9_]/.test(marker)
      ? String.raw`(?<![A-Za-z0-9_])`
      : "";
    const rightBoundary = /[A-Za-z0-9_]$/.test(marker)
      ? String.raw`(?![A-Za-z0-9_])`
      : "";
    const matcher = new RegExp(
      `${leftBoundary}${escaped}${rightBoundary}`,
      "g",
    );
    for (const match of text.matchAll(matcher)) {
      findings.push(
        finding(
          "exact-private-message-marker",
          marker,
          match.index,
          locator,
          lineStarts,
        ),
      );
    }
  }
  return findings;
}

function rewriteReplacement(category, value) {
  if (category === "non-reserved-email") return "redacted@example.invalid";
  if (category === "absolute-user-home") {
    if (/^[A-Z]:\\Users\\/i.test(value)) return "C:\\Users\\<username>";
    if (value.startsWith("/Users/")) return "/Users/<username>";
    return "/home/<username>";
  }
  if (category === "android-device-serial") return "<device-serial>";
  if (category === "android-account-or-device-id") return "<private-id>";
  if (category === "exact-private-marker") return "<private-value>";
  if (category === "dated-direct-user-evidence") {
    return "historical product requirement";
  }
  if (
    category === "dated-attributed-product-evidence"
    || category === "attributed-private-quote"
  ) {
    return "generalized product mechanism";
  }
  return undefined;
}

export function writePrivateRewriteMap(
  path,
  findings,
  root,
  {
    includeGenericMessageRules = false,
    privateMessageMarkers = [],
  } = {},
) {
  const absolutePath = resolve(path);
  if (!isOutsideWorktree(absolutePath, root)) {
    throw new Error("Private rewrite maps must be created outside the Git worktree");
  }

  const replacements = new Map();
  for (const item of findings) {
    const value = item[SENSITIVE_VALUE];
    const replacement = rewriteReplacement(item.category, value);
    if (!value || !replacement || replacements.has(value)) continue;
    if (/[\r\n]/.test(value) || value.includes("==>")) {
      throw new Error("A private value cannot be represented safely in a rewrite map");
    }
    replacements.set(value, replacement);
  }
  const genericRules = includeGenericMessageRules
    ? GENERIC_HISTORY_REWRITE_RULES
    : [];
  const messageMarkerRules = includeGenericMessageRules
    ? privateMessageMarkers.map(privateMessageMarkerRule)
    : [];
  if (
    replacements.size === 0
    && genericRules.length === 0
    && messageMarkerRules.length === 0
  ) {
    throw new Error("No private values were found for the rewrite map");
  }

  const fd = openSync(absolutePath, "wx", 0o600);
  try {
    const body = [
      ...genericRules,
      ...messageMarkerRules,
      ...[...replacements].map(
        ([value, replacement]) => `literal:${value}==>${replacement}`,
      ),
    ]
      .filter(Boolean)
      .join("\n");
    writeFileSync(fd, `${body}\n`, "utf8");
    fchmodSync(fd, 0o600);
  } finally {
    closeSync(fd);
  }
  return replacements.size + genericRules.length + messageMarkerRules.length;
}

function runGit(root, args, options = {}) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: options.encoding ?? "utf8",
    maxBuffer: 512 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
    ...options,
  });
}

function safeLocator(root, path, privateMarkers) {
  const candidate =
    path === root || path.startsWith(`${root}/`) ? relative(root, path) : path;
  const pathFindings = scanText(candidate, {
    locator: "<path>",
    privateMarkers,
  });
  return pathFindings.length === 0
    ? candidate
    : `<redacted-path>-${sha256Prefix(candidate)}`;
}

function scanPath(path, locator, privateMarkers) {
  return scanText(path, {
    locator: "<path>",
    privateMarkers,
  }).map((item) => {
    const relocated = { ...item, locator };
    Object.defineProperty(relocated, SENSITIVE_VALUE, {
      value: item[SENSITIVE_VALUE],
      enumerable: false,
    });
    return relocated;
  });
}

export function scanWorkingTree(
  root,
  privateMarkers = [],
  privateMessageMarkers = [],
) {
  const locatorMarkers = [...privateMarkers, ...privateMessageMarkers];
  const output = runGit(root, [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
  ]);
  const paths = output.split("\0").filter(Boolean);
  const findings = [];
  let scannedFiles = 0;

  for (const path of paths) {
    const absolutePath = resolve(root, path);
    if (!existsSync(absolutePath)) continue;
    const locator = safeLocator(root, absolutePath, locatorMarkers);
    findings.push(...scanPath(path, locator, privateMarkers));
    const buffer = readFileSync(absolutePath);
    scannedFiles += 1;
    if (looksBinary(buffer)) {
      findings.push(...scanBinaryPrivateMarkers(buffer, locator, privateMarkers));
      continue;
    }
    findings.push(
      ...scanText(buffer.toString("utf8"), {
        locator,
        privateMarkers,
      }),
    );
  }

  return { findings, scannedFiles };
}

function parseBatchObjects(buffer, pathByOid) {
  const objects = [];
  let cursor = 0;

  while (cursor < buffer.length) {
    const newline = buffer.indexOf(10, cursor);
    if (newline === -1) break;
    const header = buffer.subarray(cursor, newline).toString("utf8");
    cursor = newline + 1;
    const [oid, type, sizeText] = header.split(" ");
    const size = Number.parseInt(sizeText, 10);
    if (!oid || !type || !Number.isFinite(size)) {
      throw new Error("Unexpected git cat-file batch response");
    }
    const content = buffer.subarray(cursor, cursor + size);
    cursor += size + 1;
    objects.push({
      oid,
      type,
      content,
      path: pathByOid.get(oid),
    });
  }

  return objects;
}

function gitObjectMessage(content) {
  const separator = content.indexOf("\n\n");
  return separator === -1 ? "" : content.slice(separator + 2);
}

export function scanReachableHistory(
  root,
  privateMarkers = [],
  privateMessageMarkers = [],
) {
  const locatorMarkers = [...privateMarkers, ...privateMessageMarkers];
  const revList = runGit(root, ["rev-list", "--objects", "--all"]);
  const pathByOid = new Map();
  const oids = [];
  const historicalPaths = new Set();

  for (const line of revList.split(/\r?\n/)) {
    if (!line) continue;
    const separator = line.indexOf(" ");
    const oid = separator === -1 ? line : line.slice(0, separator);
    const path = separator === -1 ? undefined : line.slice(separator + 1);
    oids.push(oid);
    if (path) {
      historicalPaths.add(path);
      if (!pathByOid.has(oid)) pathByOid.set(oid, path);
    }
  }

  const batch = spawnSync("git", ["-C", root, "cat-file", "--batch"], {
    input: `${oids.join("\n")}\n`,
    encoding: null,
    maxBuffer: 512 * 1024 * 1024,
  });
  if (batch.status !== 0) {
    throw new Error("Unable to read reachable Git objects");
  }

  const findings = [];
  for (const path of historicalPaths) {
    const locator = `history-path:${safeLocator(root, path, locatorMarkers)}`;
    findings.push(...scanPath(path, locator, privateMarkers));
  }
  let scannedObjects = 0;
  for (const object of parseBatchObjects(batch.stdout, pathByOid)) {
    if (!["blob", "commit", "tag"].includes(object.type)) {
      continue;
    }
    scannedObjects += 1;
    const locator =
      object.type === "blob" && object.path
        ? `history:${safeLocator(root, object.path, locatorMarkers)}@${object.oid.slice(0, 12)}`
        : `history:${object.type}@${object.oid.slice(0, 12)}`;
    if (looksBinary(object.content)) {
      findings.push(
        ...scanBinaryPrivateMarkers(object.content, locator, privateMarkers),
      );
      continue;
    }
    findings.push(
      ...scanText(object.content.toString("utf8"), {
        locator,
        privateMarkers,
      }),
    );
    if (
      privateMessageMarkers.length > 0
      && (object.type === "commit" || object.type === "tag")
    ) {
      findings.push(
        ...scanPrivateMessageMarkers(
          gitObjectMessage(object.content.toString("utf8")),
          locator,
          privateMessageMarkers,
        ),
      );
    }
  }

  return { findings, scannedObjects };
}

function parseArgs(argv) {
  const options = {
    history: false,
    historyOnly: false,
    markerPaths: [],
    messageMarkerPaths: [],
    messageRewriteMapPath: undefined,
    root: process.cwd(),
    rewriteMapPath: undefined,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--history") {
      options.history = true;
    } else if (arg === "--history-only") {
      options.history = true;
      options.historyOnly = true;
    } else if (arg === "--private-markers-file") {
      const value = argv[index + 1];
      if (!value) throw new Error("--private-markers-file requires a path");
      options.markerPaths.push(resolve(value));
      index += 1;
    } else if (arg === "--private-message-markers-file") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--private-message-markers-file requires a path");
      }
      options.messageMarkerPaths.push(resolve(value));
      index += 1;
    } else if (arg === "--root") {
      const value = argv[index + 1];
      if (!value) throw new Error("--root requires a path");
      options.root = resolve(value);
      index += 1;
    } else if (arg === "--write-private-rewrite-map") {
      const value = argv[index + 1];
      if (!value) throw new Error("--write-private-rewrite-map requires a path");
      options.rewriteMapPath = resolve(value);
      index += 1;
    } else if (arg === "--write-private-message-rewrite-map") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--write-private-message-rewrite-map requires a path");
      }
      options.messageRewriteMapPath = resolve(value);
      index += 1;
    } else if (arg === "--help") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function printHelp() {
  process.stdout.write(
    [
      "Usage: node scripts/check-public-privacy.mjs [options]",
      "",
      "Options:",
      "  --history                       Also scan every object reachable from every ref",
      "  --history-only                  Scan reachable objects without requiring a worktree",
      "  --private-markers-file <path>   Add exact private strings, one per line",
      "  --private-message-markers-file <path>",
      "                                  Add message-only markers from a mode-0600 file outside the checkout",
      "  --write-private-rewrite-map <path>",
      "                                  Write build-safe blob replacement rules outside the checkout",
      "  --write-private-message-rewrite-map <path>",
      "                                  Write commit-message rules outside the checkout",
      "  --root <path>                   Git worktree to scan (default: current directory)",
      "",
      "Matched values are never printed.",
      "",
    ].join("\n"),
  );
}

function printReport(results) {
  const findings = results.flatMap((result) => result.findings);
  const categoryCounts = new Map();
  for (const item of findings) {
    categoryCounts.set(item.category, (categoryCounts.get(item.category) ?? 0) + 1);
  }

  const scanSummary = results
    .map((result) =>
      result.scannedFiles === undefined
        ? `${result.scannedObjects} reachable objects`
        : `${result.scannedFiles} current files`,
    )
    .join(" and ");

  if (findings.length === 0) {
    process.stdout.write(`Public privacy check passed (${scanSummary}).\n`);
    return true;
  }

  process.stderr.write(
    `Public privacy check failed: ${findings.length} finding(s) in ${scanSummary}.\n`,
  );
  for (const [category, count] of [...categoryCounts].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    process.stderr.write(`- ${category}: ${count}\n`);
  }
  process.stderr.write("Matched values are suppressed. Locations follow.\n");
  for (const item of findings.slice(0, 100)) {
    process.stderr.write(
      `- ${item.category} ${item.locator}:${item.line}\n`,
    );
  }
  if (findings.length > 100) {
    process.stderr.write(`- ${findings.length - 100} additional finding(s) suppressed\n`);
  }
  return false;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      printHelp();
      process.exitCode = 0;
    } else {
      const privateMarkers = readPrivateMarkers(options.markerPaths, options.root);
      const privateMessageMarkers = readPrivateMessageMarkers(
        options.messageMarkerPaths,
        options.root,
      );
      if (privateMessageMarkers.length > 0 && !options.history) {
        throw new Error("--private-message-markers-file requires --history");
      }
      const results = options.historyOnly
        ? []
        : [scanWorkingTree(
          options.root,
          privateMarkers,
          privateMessageMarkers,
        )];
      if (options.history) {
        results.push(
          scanReachableHistory(
            options.root,
            privateMarkers,
            privateMessageMarkers,
          ),
        );
      }
      if (options.rewriteMapPath) {
        if (!options.history) {
          throw new Error("--write-private-rewrite-map requires --history");
        }
        const count = writePrivateRewriteMap(
          options.rewriteMapPath,
          results.flatMap((result) => result.findings),
          options.root,
        );
        process.stderr.write(
          `Private rewrite map created with ${count} suppressed entr${count === 1 ? "y" : "ies"}.\n`,
        );
      }
      if (options.messageRewriteMapPath) {
        if (!options.history) {
          throw new Error("--write-private-message-rewrite-map requires --history");
        }
        const count = writePrivateRewriteMap(
          options.messageRewriteMapPath,
          results.flatMap((result) => result.findings),
          options.root,
          {
            includeGenericMessageRules: true,
            privateMessageMarkers,
          },
        );
        process.stderr.write(
          `Private message rewrite map created with ${count} suppressed entr${count === 1 ? "y" : "ies"}.\n`,
        );
      }
      process.exitCode = printReport(results) ? 0 : 1;
    }
  } catch (error) {
    process.stderr.write(`Public privacy check could not run: ${error.message}\n`);
    process.exitCode = 2;
  }
}

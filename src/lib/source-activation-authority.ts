import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getDataDir } from './data-dir';

const SOURCE_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PACKAGE_PATTERN = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;
const RUN_ID_PATTERN = /^source-discovery-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MIN_RECIPE_BYTES = 200;
const MAX_RECIPE_BYTES = 4 * 1024;
const MAX_MANIFEST_BYTES = 16 * 1024;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

const RECIPE_KEYS = [
  'cardLayout',
  'contentAttributes',
  'discoveryRunId',
  'format',
  'nodeClasses',
  'package',
  'scrollGesture',
  'source',
  'stableIdStrategy',
  'surfacePath',
  'targetPerRun',
] as const;
const SURFACE_TARGETS = new Set([
  'home', 'following', 'for_you', 'subscriptions', 'latest', 'feed', 'explore', 'discover',
]);
const NODE_CLASSES = new Set([
  'android.view.View',
  'android.view.ViewGroup',
  'android.widget.FrameLayout',
  'android.widget.LinearLayout',
  'android.widget.TextView',
  'androidx.recyclerview.widget.RecyclerView',
]);
const CONTENT_ATTRIBUTES = new Set(['text', 'desc']);
const CARD_LAYOUTS = new Set(['single_node', 'nested_nodes', 'mixed_nodes']);
const STABLE_ID_STRATEGIES = new Set(['platform_id', 'canonical_url', 'content_hash']);

type ActivationAuthorityInput = {
  source: string;
  packageName: string;
  runId: string;
  recipeSha256: string;
};

type ActivationManifest = {
  format: number;
  source: string;
  package: string;
  discoveryRunId: string;
  recipeSha256: string;
  validatedAtMs: number;
};

function assertPrivateOwnedDirectory(directoryPath: string, label: string): void {
  const metadata = fs.lstatSync(directoryPath);
  const euid = process.geteuid?.();
  if (
    metadata.isSymbolicLink()
    || !metadata.isDirectory()
    || !Number.isInteger(euid)
    || metadata.uid !== euid
    || (metadata.mode & 0o077) !== 0
  ) {
    throw new Error(`${label} is not a private owner-controlled directory`);
  }
}

function readPrivateOwnedRegular(
  filePath: string,
  label: string,
  minimumBytes: number,
  maximumBytes: number,
): Buffer {
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
    const before = fs.fstatSync(descriptor);
    const euid = process.geteuid?.();
    if (
      !before.isFile()
      || !Number.isInteger(euid)
      || before.uid !== euid
      || before.nlink !== 1
      || (before.mode & 0o077) !== 0
      || before.size < minimumBytes
      || before.size > maximumBytes
    ) {
      throw new Error(`${label} is not a bounded private owner-controlled file`);
    }

    const data = Buffer.allocUnsafe(before.size);
    let offset = 0;
    while (offset < data.length) {
      const count = fs.readSync(descriptor, data, offset, data.length - offset, null);
      if (count === 0) throw new Error(`${label} ended before its proven size`);
      offset += count;
    }
    if (fs.readSync(descriptor, Buffer.allocUnsafe(1), 0, 1, null) !== 0) {
      throw new Error(`${label} grew while it was being validated`);
    }
    const after = fs.fstatSync(descriptor);
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs
    ) {
      throw new Error(`${label} changed while it was being validated`);
    }
    return data;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(label)) throw error;
    throw new Error(`${label} could not be read as activation authority`);
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

function decodeUtf8(data: Buffer, label: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
}

function isUniqueAllowlistedStrings(
  value: unknown,
  allowlist: ReadonlySet<string>,
  minimum: number,
  maximum: number,
): value is string[] {
  return (
    Array.isArray(value)
    && value.length >= minimum
    && value.length <= maximum
    && value.every((entry) => typeof entry === 'string' && allowlist.has(entry))
    && new Set(value).size === value.length
  );
}

function validateRecipe(data: Buffer, input: ActivationAuthorityInput): void {
  const text = decodeUtf8(data, 'live source recipe');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Live source recipe is not canonical schema-2 JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Live source recipe must be a schema-2 JSON object');
  }
  const recipe = parsed as Record<string, unknown>;
  if (JSON.stringify(Object.keys(recipe).sort()) !== JSON.stringify(RECIPE_KEYS)) {
    throw new Error('Live source recipe must use only the exact schema-2 fields');
  }
  const target = recipe.targetPerRun;
  if (
    recipe.format !== 2
    || recipe.discoveryRunId !== input.runId
    || recipe.source !== input.source
    || recipe.package !== input.packageName
    || !isUniqueAllowlistedStrings(recipe.surfacePath, SURFACE_TARGETS, 0, 3)
    || !isUniqueAllowlistedStrings(recipe.nodeClasses, NODE_CLASSES, 1, 3)
    || !isUniqueAllowlistedStrings(recipe.contentAttributes, CONTENT_ATTRIBUTES, 1, 2)
    || typeof recipe.cardLayout !== 'string'
    || !CARD_LAYOUTS.has(recipe.cardLayout)
    || recipe.scrollGesture !== 'standard_up'
    || typeof recipe.stableIdStrategy !== 'string'
    || !STABLE_ID_STRATEGIES.has(recipe.stableIdStrategy)
    || !target
    || typeof target !== 'object'
    || Array.isArray(target)
    || JSON.stringify(Object.keys(target).sort()) !== JSON.stringify(['max', 'min'])
    || (target as Record<string, unknown>).min !== 10
    || (target as Record<string, unknown>).max !== 25
  ) {
    throw new Error('Live source recipe contains data outside the strict schema-2 allowlist');
  }
  const canonical = JSON.stringify({
    cardLayout: recipe.cardLayout,
    contentAttributes: recipe.contentAttributes,
    discoveryRunId: recipe.discoveryRunId,
    format: recipe.format,
    nodeClasses: recipe.nodeClasses,
    package: recipe.package,
    scrollGesture: recipe.scrollGesture,
    source: recipe.source,
    stableIdStrategy: recipe.stableIdStrategy,
    surfacePath: recipe.surfacePath,
    targetPerRun: {
      max: (target as Record<string, unknown>).max,
      min: (target as Record<string, unknown>).min,
    },
  }) + '\n';
  if (text !== canonical) {
    throw new Error('Live source recipe must be canonical single-line schema-2 JSON');
  }
}

function parseManifest(data: Buffer): ActivationManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeUtf8(data, 'source activation manifest'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('UTF-8')) throw error;
    throw new Error('Source activation manifest is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Source activation manifest must be a JSON object');
  }
  const expectedKeys = [
    'discoveryRunId',
    'format',
    'package',
    'recipeSha256',
    'source',
    'validatedAtMs',
  ];
  if (JSON.stringify(Object.keys(parsed).sort()) !== JSON.stringify(expectedKeys)) {
    throw new Error('Source activation manifest has an unexpected shape');
  }
  return parsed as ActivationManifest;
}

export function assertSourceActivationAuthority(input: ActivationAuthorityInput): void {
  if (!SOURCE_PATTERN.test(input.source)) {
    throw new Error('A canonical source slug is required');
  }
  if (!PACKAGE_PATTERN.test(input.packageName)) {
    throw new Error('A canonical Android package is required');
  }
  if (!RUN_ID_PATTERN.test(input.runId)) {
    throw new Error('An exact source discovery run identity is required');
  }
  if (!SHA256_PATTERN.test(input.recipeSha256)) {
    throw new Error('An exact lowercase recipe SHA-256 is required');
  }

  const phoneSourcesDirectory = path.join(getDataDir(), 'phone-sources');
  const activeDirectory = path.join(phoneSourcesDirectory, '.active');
  assertPrivateOwnedDirectory(phoneSourcesDirectory, 'Phone source authority');
  assertPrivateOwnedDirectory(activeDirectory, 'Phone source activation authority');

  const recipe = readPrivateOwnedRegular(
    path.join(phoneSourcesDirectory, `${input.source}.txt`),
    'Live source recipe',
    MIN_RECIPE_BYTES,
    MAX_RECIPE_BYTES,
  );
  const manifest = parseManifest(readPrivateOwnedRegular(
    path.join(activeDirectory, `${input.source}.json`),
    'Source activation manifest',
    2,
    MAX_MANIFEST_BYTES,
  ));
  if (
    manifest.format !== 1
    || manifest.source !== input.source
    || manifest.package !== input.packageName
    || manifest.discoveryRunId !== input.runId
    || manifest.recipeSha256 !== input.recipeSha256
    || !Number.isInteger(manifest.validatedAtMs)
    || manifest.validatedAtMs <= 0
    || manifest.validatedAtMs > Date.now() + MAX_CLOCK_SKEW_MS
  ) {
    throw new Error('Source activation manifest does not match the requested authority');
  }

  validateRecipe(recipe, input);
  const actualSha256 = createHash('sha256').update(recipe).digest('hex');
  if (actualSha256 !== input.recipeSha256) {
    throw new Error('Live source recipe hash disagrees with its activation manifest');
  }
}

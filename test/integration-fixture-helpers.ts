import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export interface ValidationFixtureCleanupSelector {
  ids?: string[];
  sourceIds?: string[];
  originSessionIds?: string[];
}

export interface ValidationIsolationContext {
  baseUrl: string;
  wsBaseUrl: string;
  dataDir: string;
}

function normalizeValues(values: string[] | undefined): string[] {
  if (!Array.isArray(values)) {
    return [];
  }

  return Array.from(new Set(
    values
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.trim())
      .filter(Boolean),
  ));
}

function readEnvUrl(value: string | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function parseRequiredTestServerUrl(contextLabel: string): URL {
  const rawUrl = readEnvUrl(process.env.TEST_SERVER_URL);
  if (!rawUrl) {
    throw new Error(`${contextLabel} requires TEST_SERVER_URL plus TEST_SERVER_DATA_DIR or DATA_DIR before integration tests can touch HTTP or the database.`);
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`${contextLabel} requires TEST_SERVER_URL to be a valid http:// or https:// URL.`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${contextLabel} requires TEST_SERVER_URL to use http:// or https://.`);
  }

  const hostname = parsed.hostname.toLowerCase();
  const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
  if (
    (hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '0.0.0.0' || hostname === '[::1]')
    && port === '3001'
  ) {
    throw new Error(`${contextLabel} resolved TEST_SERVER_URL=${parsed.origin}, which is the production app URL. Use an isolated validation server such as 127.0.0.1:3138.`);
  }

  return parsed;
}

function normalizeWsBaseUrl(baseUrl: URL): string {
  const explicitWsUrl = readEnvUrl(process.env.TEST_SERVER_WS_URL);
  if (explicitWsUrl) {
    return explicitWsUrl;
  }

  const wsUrl = new URL(baseUrl.toString());
  wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  return wsUrl.origin;
}

function readEnvPath(value: string | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? path.resolve(trimmed) : null;
}

function isInsideOrEqualPath(candidate: string, parent: string): boolean {
  const relativePath = path.relative(parent, candidate);
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

export function requireValidationIsolationContext(contextLabel: string): ValidationIsolationContext {
  const baseUrl = parseRequiredTestServerUrl(contextLabel);
  const testServerDataDir = readEnvPath(process.env.TEST_SERVER_DATA_DIR);
  const envDataDir = readEnvPath(process.env.DATA_DIR);
  const dataDir = testServerDataDir ?? envDataDir;
  const repoDataDir = path.resolve(process.cwd(), 'data');

  if (!dataDir) {
    throw new Error(`${contextLabel} requires TEST_SERVER_DATA_DIR or DATA_DIR to point at an isolated validation data directory before integration tests can touch HTTP or the database.`);
  }

  if (testServerDataDir && envDataDir && testServerDataDir !== envDataDir) {
    throw new Error(`${contextLabel} has conflicting TEST_SERVER_DATA_DIR=${testServerDataDir} and DATA_DIR=${envDataDir}. Direct DB setup must target the same isolated data directory as the validation server.`);
  }

  if (isInsideOrEqualPath(dataDir, repoDataDir)) {
    throw new Error(`${contextLabel} must not target ${repoDataDir} or any child directory. Use an isolated validation DATA_DIR outside repo data instead.`);
  }

  const evogentDbPath = readEnvPath(process.env.MEDIA_AGENT_DB_PATH);
  const expectedDbPath = path.join(dataDir, 'media-agent.db');
  if (evogentDbPath && evogentDbPath !== expectedDbPath) {
    throw new Error(`${contextLabel} has MEDIA_AGENT_DB_PATH=${evogentDbPath}, but validation DB setup must use ${expectedDbPath} from TEST_SERVER_DATA_DIR/DATA_DIR.`);
  }

  if (testServerDataDir) {
    process.env.DATA_DIR = testServerDataDir;
  }

  return {
    baseUrl: baseUrl.origin,
    wsBaseUrl: normalizeWsBaseUrl(baseUrl),
    dataDir,
  };
}

export function getIntegrationTestBaseUrl(): string {
  return requireValidationIsolationContext('Integration tests').baseUrl;
}

export function getIntegrationTestWsBaseUrl(): string {
  return requireValidationIsolationContext('Integration tests').wsBaseUrl;
}

export function createValidationOriginSessionId(prefix = 'validation-fixture'): string {
  return `${prefix}-${randomUUID()}`;
}

export function mergeValidationFixtureSelectors(
  ...selectors: Array<ValidationFixtureCleanupSelector | null | undefined>
): ValidationFixtureCleanupSelector {
  return {
    ids: normalizeValues(selectors.flatMap((selector) => selector?.ids ?? [])),
    sourceIds: normalizeValues(selectors.flatMap((selector) => selector?.sourceIds ?? [])),
    originSessionIds: normalizeValues(selectors.flatMap((selector) => selector?.originSessionIds ?? [])),
  };
}

export async function cleanupValidationFixtures(
  selector: ValidationFixtureCleanupSelector,
  baseUrl = getIntegrationTestBaseUrl(),
): Promise<void> {
  const payload = mergeValidationFixtureSelectors(selector);
  if (
    (payload.ids?.length ?? 0) === 0
    && (payload.sourceIds?.length ?? 0) === 0
    && (payload.originSessionIds?.length ?? 0) === 0
  ) {
    return;
  }

  const response = await fetch(`${baseUrl}/api/internal/validation/cleanup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  assert.strictEqual(response.status, 200);
}

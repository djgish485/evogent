import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getDataPath } from '@/lib/data-dir';
import { DEFAULT_CONFIG_CONTENT } from '../../lib/brain-config.js';

export type ConfigDocumentTargetKey = 'config' | 'curation-prompt';
export type ConfigMutationSource = 'manual_edit' | 'brain_provider' | 'suggestion';
const CONFIG_SNAPSHOT_RETENTION_LIMIT = 100;

const DEFAULT_CURATION_PROMPT_CONTENT = `# Evogent Curation Prompt

## Private Selection Lens
- Use the deployment's private preference context and interaction history.
- Prefer concrete mechanisms, primary evidence, and material that changes a decision.
- Reject shallow recap, engagement bait, and content that does not earn attention.
`;

export interface ConfigDocumentTarget {
  key: ConfigDocumentTargetKey;
  relativePath: 'data/config.md' | 'data/curation-prompt.md';
  filePath: string;
  historyDir: string;
  defaultContent: string;
}

export interface ConfigSnapshotRecord {
  id: string;
  target: ConfigDocumentTargetKey;
  path: string;
  contentHash: string;
  source: ConfigMutationSource;
  suggestionId: string | null;
  createdAt: string;
  snapshotPath: string;
}

export interface ConfigIntegrityReport {
  target: ConfigDocumentTargetKey;
  latestSnapshot: ConfigSnapshotRecord | null;
  issues: Array<never>;
}

interface PersistConfigContentInput {
  target: ConfigDocumentTarget;
  content: string;
  source: ConfigMutationSource;
  suggestionId?: string | null;
  expectedCurrentContentHash?: string;
}

interface PersistConfigContentSuccess {
  ok: true;
  changed: boolean;
  content: string;
  snapshot?: ConfigSnapshotRecord;
  integrity: ConfigIntegrityReport;
}

interface PersistConfigContentFailure {
  ok: false;
  changed: false;
  message: string;
  statusCode: 400 | 409 | 500;
  integrity: ConfigIntegrityReport;
}

export type PersistConfigContentResult = PersistConfigContentSuccess | PersistConfigContentFailure;

interface EnsureConfigTargetIntegritySuccess {
  ok: true;
  repaired: boolean;
  content: string;
  snapshot?: ConfigSnapshotRecord;
  integrity: ConfigIntegrityReport;
  reason?: string;
}

interface EnsureConfigTargetIntegrityFailure {
  ok: false;
  repaired: false;
  message: string;
  integrity: ConfigIntegrityReport;
}

export type EnsureConfigTargetIntegrityResult =
  | EnsureConfigTargetIntegritySuccess
  | EnsureConfigTargetIntegrityFailure;

export const CONFIG_DOCUMENT_TARGETS: Record<ConfigDocumentTargetKey, ConfigDocumentTarget> = {
  config: {
    key: 'config',
    relativePath: 'data/config.md',
    filePath: getDataPath('config.md'),
    historyDir: getDataPath('config-history'),
    defaultContent: DEFAULT_CONFIG_CONTENT,
  },
  'curation-prompt': {
    key: 'curation-prompt',
    relativePath: 'data/curation-prompt.md',
    filePath: getDataPath('curation-prompt.md'),
    historyDir: getDataPath('curation-prompt-history'),
    defaultContent: DEFAULT_CURATION_PROMPT_CONTENT,
  },
};

function normalizeContent(value: string): string {
  return value.replace(/\r\n/g, '\n');
}

function looksLikeUnifiedDiff(value: string): boolean {
  const normalized = normalizeContent(value);
  return /^(---|\+\+\+|@@)\b/m.test(normalized) && (/^---\s/m.test(normalized) || /^\+\+\+\s/m.test(normalized));
}

function hashContent(content: string): string {
  return createHash('sha256')
    .update(normalizeConfigDocumentContent(content), 'utf8')
    .digest('hex');
}

async function readTargetContent(target: ConfigDocumentTarget): Promise<{ content: string; exists: boolean }> {
  try {
    return {
      content: await fs.promises.readFile(target.filePath, 'utf8'),
      exists: true,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        content: '',
        exists: false,
      };
    }
    throw error;
  }
}

async function ensureParentDirectory(filePath: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
}

async function atomicWritePrivateText(filePath: string, content: string): Promise<void> {
  const directory = path.dirname(filePath);
  const tempPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  const handle = await fs.promises.open(tempPath, 'wx', 0o600);
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.promises.rename(tempPath, filePath);
    await fs.promises.chmod(filePath, 0o600);
    try {
      const directoryHandle = await fs.promises.open(directory, 'r');
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } catch {
      // Directory fsync is not supported by every host filesystem. The file itself is synced.
    }
  } catch (error) {
    await fs.promises.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

function pruneConfigSnapshots(historyDir: string): void {
  try {
    const snapshots = fs.readdirSync(historyDir)
      .filter((entry) => entry.endsWith('.md'))
      .sort((left, right) => right.localeCompare(left));
    for (const stale of snapshots.slice(CONFIG_SNAPSHOT_RETENTION_LIMIT)) {
      fs.rmSync(path.join(historyDir, stale), { force: true });
    }
  } catch {
    // Snapshot pruning is best effort and must never invalidate the successful document write.
  }
}

export function normalizeConfigDocumentContent(value: string): string {
  return `${normalizeContent(value).trimEnd()}\n`;
}

export function getLatestConfigSnapshot(historyDir: string): ConfigSnapshotRecord | null {
  try {
    const entries = fs.readdirSync(historyDir)
      .filter((entry) => entry.endsWith('.md'))
      .sort((left, right) => right.localeCompare(left));
    const latest = entries[0];
    if (!latest) {
      return null;
    }

    const snapshotPath = path.join(historyDir, latest);
    const content = fs.readFileSync(snapshotPath, 'utf8');
    return {
      id: latest.replace(/\.md$/i, ''),
      target: historyDir.includes('curation-prompt') ? 'curation-prompt' : 'config',
      path: snapshotPath,
      contentHash: hashContent(content),
      source: 'manual_edit',
      suggestionId: null,
      createdAt: latest.replace(/\.md$/i, ''),
      snapshotPath,
    };
  } catch {
    return null;
  }
}

export function createConfigSnapshot(
  filePath: string,
  historyDir: string,
  options: {
    target: ConfigDocumentTargetKey;
    source: ConfigMutationSource;
    suggestionId?: string | null;
  },
): ConfigSnapshotRecord {
  fs.mkdirSync(historyDir, { recursive: true });
  const createdAt = new Date().toISOString();
  const snapshotPath = path.join(historyDir, `${createdAt}.md`);
  fs.copyFileSync(filePath, snapshotPath);
  fs.chmodSync(snapshotPath, 0o600);
  const content = fs.readFileSync(snapshotPath, 'utf8');
  pruneConfigSnapshots(historyDir);

  return {
    id: createdAt,
    target: options.target,
    path: filePath,
    contentHash: hashContent(content),
    source: options.source,
    suggestionId: typeof options.suggestionId === 'string' && options.suggestionId.trim()
      ? options.suggestionId.trim()
      : null,
    createdAt,
    snapshotPath,
  };
}

export function buildConfigIntegrityReport(
  target: ConfigDocumentTargetKey,
  _filePath: string,
  historyDir: string,
): ConfigIntegrityReport {
  return {
    target,
    latestSnapshot: getLatestConfigSnapshot(historyDir),
    issues: [],
  };
}

export async function persistConfigContent(input: PersistConfigContentInput): Promise<PersistConfigContentResult> {
  const nextContent = normalizeConfigDocumentContent(input.content);
  if (looksLikeUnifiedDiff(nextContent)) {
    return {
      ok: false,
      changed: false,
      message: 'Rejected document because it still contains unified diff markers.',
      statusCode: 400,
      integrity: buildConfigIntegrityReport(input.target.key, input.target.filePath, input.target.historyDir),
    };
  }

  const current = await readTargetContent(input.target);
  const currentContent = current.exists ? normalizeConfigDocumentContent(current.content) : '';
  if (
    input.expectedCurrentContentHash
    && (
      !current.exists
      || hashContent(currentContent) !== input.expectedCurrentContentHash
    )
  ) {
    return {
      ok: false,
      changed: false,
      message: `${input.target.relativePath} changed after this apply was journaled.`,
      statusCode: 409,
      integrity: buildConfigIntegrityReport(input.target.key, input.target.filePath, input.target.historyDir),
    };
  }
  const changed = !current.exists || currentContent !== nextContent;
  if (!changed) {
    return {
      ok: true,
      changed: false,
      content: currentContent || nextContent,
      integrity: buildConfigIntegrityReport(input.target.key, input.target.filePath, input.target.historyDir),
    };
  }

  try {
    await ensureParentDirectory(input.target.filePath);
    const snapshot = current.exists
      ? createConfigSnapshot(input.target.filePath, input.target.historyDir, {
          target: input.target.key,
          source: input.source,
          suggestionId: input.suggestionId,
        })
      : undefined;
    await atomicWritePrivateText(input.target.filePath, nextContent);

    return {
      ok: true,
      changed: true,
      content: nextContent,
      ...(snapshot ? { snapshot } : {}),
      integrity: buildConfigIntegrityReport(input.target.key, input.target.filePath, input.target.historyDir),
    };
  } catch (error) {
    return {
      ok: false,
      changed: false,
      message: error instanceof Error && error.message.trim()
        ? error.message.trim()
        : `Failed to persist ${input.target.relativePath}.`,
      statusCode: 500,
      integrity: buildConfigIntegrityReport(input.target.key, input.target.filePath, input.target.historyDir),
    };
  }
}

export async function ensureConfigTargetIntegrity(
  target: ConfigDocumentTarget,
): Promise<EnsureConfigTargetIntegrityResult> {
  try {
    const current = await readTargetContent(target);
    if (current.exists) {
      return {
        ok: true,
        repaired: false,
        content: normalizeConfigDocumentContent(current.content),
        integrity: buildConfigIntegrityReport(target.key, target.filePath, target.historyDir),
      };
    }

    const persisted = await persistConfigContent({
      target,
      content: target.defaultContent,
      source: 'manual_edit',
    });
    if (!persisted.ok) {
      return {
        ok: false,
        repaired: false,
        message: persisted.message,
        integrity: persisted.integrity,
      };
    }

    return {
      ok: true,
      repaired: true,
      content: persisted.content,
      ...(persisted.snapshot ? { snapshot: persisted.snapshot } : {}),
      integrity: persisted.integrity,
      reason: `Created ${target.relativePath} from defaults.`,
    };
  } catch (error) {
    return {
      ok: false,
      repaired: false,
      message: error instanceof Error ? error.message : `Failed to read ${target.relativePath}`,
      integrity: buildConfigIntegrityReport(target.key, target.filePath, target.historyDir),
    };
  }
}

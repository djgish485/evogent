import { execFileSync } from 'node:child_process';

function normalizeString(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

export function shouldSuppressFailureForSuggestionStatus(status: unknown): boolean {
  const normalized = normalizeString(status).toLowerCase();
  return normalized === 'dismissed' || normalized === 'merged';
}

function runGit(repoDir: string, args: string[]): string {
  try {
    return execFileSync('git', args, {
      cwd: repoDir || process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    }).trim();
  } catch {
    return '';
  }
}

function gitCommandSucceeds(repoDir: string, args: string[]): boolean {
  try {
    execFileSync('git', args, {
      cwd: repoDir || process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'ignore', 'ignore'],
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

function resolveCommit(repoDir: string, commitish: string | null): string {
  const normalized = normalizeString(commitish);
  return normalized ? runGit(repoDir, ['rev-parse', '--verify', `${normalized}^{commit}`]) : '';
}

export function getReachableProducedCommit(
  repoDir: string,
  input: { producedCommit?: string | null; producedCommitFull?: string | null },
) {
  const commit = resolveCommit(repoDir, input.producedCommitFull ?? null)
    || resolveCommit(repoDir, input.producedCommit ?? null);
  if (!commit) {
    return { reachable: false, commit: null, ref: null };
  }

  for (const ref of ['main', 'origin/main']) {
    if (!resolveCommit(repoDir, ref)) {
      continue;
    }
    if (gitCommandSucceeds(repoDir, ['merge-base', '--is-ancestor', commit, ref])) {
      return { reachable: true, commit, ref };
    }
  }

  return { reachable: false, commit, ref: null };
}

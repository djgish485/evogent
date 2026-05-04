import path from 'node:path';

export function getDataDir(rootDir = process.cwd()): string {
  return path.resolve(process.env.DATA_DIR || path.join(rootDir, 'data'));
}

export function getDataPath(...segments: string[]): string {
  return path.join(getDataDir(), ...segments);
}

export function getDefaultDbPath(): string {
  return getDataPath('media-agent.db');
}

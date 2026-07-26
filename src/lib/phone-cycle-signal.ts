import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getDataPath } from '@/lib/data-dir';

export interface PhoneCycleRequest {
  id: string;
  requestedAt: string;
  reason: string;
  triggeredBy: string;
}

export interface PhoneCycleSignalResult {
  request: PhoneCycleRequest;
  duplicate: boolean;
  path: string;
}

export function getPhoneCycleRequestPath(): string {
  const configured = process.env.EVOGENT_PHONE_CYCLE_REQUEST_PATH?.trim();
  return configured || getDataPath('phone-cycle-request.json');
}

function readExistingRequest(filePath: string): PhoneCycleRequest | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<PhoneCycleRequest>;
    if (
      typeof parsed.id === 'string'
      && typeof parsed.requestedAt === 'string'
      && typeof parsed.reason === 'string'
      && typeof parsed.triggeredBy === 'string'
    ) {
      return parsed as PhoneCycleRequest;
    }
  } catch {
    // A missing or malformed request is replaced atomically below.
  }
  return null;
}

export function requestPhoneCycle(input: {
  reason: string;
  triggeredBy: string;
}): PhoneCycleSignalResult {
  const filePath = getPhoneCycleRequestPath();
  const existing = readExistingRequest(filePath);
  if (existing) {
    return { request: existing, duplicate: true, path: filePath };
  }

  const request: PhoneCycleRequest = {
    id: `phone-cycle-${randomUUID()}`,
    requestedAt: new Date().toISOString(),
    reason: input.reason.trim() || 'adaptive_heartbeat',
    triggeredBy: input.triggeredBy.trim() || 'adaptive_heartbeat',
  };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = fs.openSync(tempPath, 'wx', 0o600);
    try {
      fs.writeFileSync(handle, `${JSON.stringify(request)}\n`, {
        encoding: 'utf8',
      });
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
    try {
      // link(2) is an atomic create-if-absent operation. rename(2) would overwrite another
      // request that won the race between our initial read and publish.
      fs.linkSync(tempPath, filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const winner = readExistingRequest(filePath);
      if (winner) {
        return { request: winner, duplicate: true, path: filePath };
      }
      throw new Error('Phone cycle request exists but is malformed');
    }
  } finally {
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {
      // The rename already made the durable request; cleanup failure is harmless.
    }
  }

  return { request, duplicate: false, path: filePath };
}

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { getDataPath } from '@/lib/data-dir';

export const SOURCE_DUE_SIGNAL_MARKER = 'EVOGENT_SOURCE_DUE_V1\n';
export const SOURCE_DUE_SIGNAL_PENDING_MODE = 0o400;

const SOURCE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MARKER_BYTES = Buffer.from(SOURCE_DUE_SIGNAL_MARKER, 'utf8');

function currentUid(): number {
  if (typeof process.getuid !== 'function') {
    throw new Error('Source due signals require Unix ownership checks');
  }
  return process.getuid();
}

function assertPrivateDirectory(directory: string): fs.Stats {
  const metadata = fs.lstatSync(directory);
  if (
    !metadata.isDirectory()
    || metadata.isSymbolicLink()
    || (metadata.mode & 0o777) !== 0o700
    || metadata.uid !== currentUid()
  ) {
    throw new Error('Source due-signal directory is not private');
  }
  return metadata;
}

function openPrivateDirectory(directory: string): number {
  const expected = assertPrivateDirectory(directory);
  const descriptor = fs.openSync(
    directory,
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
  );
  const opened = fs.fstatSync(descriptor);
  if (
    !opened.isDirectory()
    || (opened.mode & 0o777) !== 0o700
    || opened.uid !== currentUid()
    || opened.dev !== expected.dev
    || opened.ino !== expected.ino
  ) {
    fs.closeSync(descriptor);
    throw new Error('Source due-signal directory changed during publication');
  }
  return descriptor;
}

function verifyFinalSignal(signalPath: string, expectedDescriptor: number): void {
  const descriptor = fs.openSync(
    signalPath,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  );
  try {
    const metadata = fs.fstatSync(descriptor);
    if (
      !metadata.isFile()
      || (metadata.mode & 0o777) !== 0o600
      || metadata.uid !== currentUid()
      || metadata.nlink !== 1
      || metadata.size !== MARKER_BYTES.length
    ) {
      throw new Error('Published source due signal is not a private regular file');
    }
    const expected = fs.fstatSync(expectedDescriptor);
    if (metadata.dev !== expected.dev || metadata.ino !== expected.ino) {
      throw new Error('Published source due signal changed during verification');
    }
    const body = Buffer.alloc(MARKER_BYTES.length + 1);
    const bytesRead = fs.readSync(descriptor, body, 0, body.length, 0);
    if (bytesRead !== MARKER_BYTES.length || !body.subarray(0, bytesRead).equals(MARKER_BYTES)) {
      throw new Error('Published source due signal body is invalid');
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

function syncPrivateDirectory(directory: string): void {
  const directoryDescriptor = openPrivateDirectory(directory);
  try {
    fs.fsyncSync(directoryDescriptor);
  } finally {
    fs.closeSync(directoryDescriptor);
  }
}

function normalizeSource(source: string): string {
  const normalized = source.trim().toLowerCase();
  if (!SOURCE_NAME.test(normalized)) {
    throw new Error('Invalid source due-signal name');
  }
  return normalized;
}

export function getSourceDueSignalPath(source: string): string {
  return getDataPath('source-due-signals', `${normalizeSource(source)}.due`);
}

/**
 * Publish one bounded, content-free source watermark.
 *
 * The filename contains only the canonical public source identifier and the
 * body is one fixed marker. Its normally published mtime is the signal
 * generation; a crash-pending marker uses its final-rename ctime instead. On
 * successful browsing, the scheduler separately records completion cadence
 * and the browse-start generation this run actually covered. It deliberately
 * does not unlink the marker: a notification that races browse completion must
 * remain observable instead of being deleted by an acknowledgement of older
 * work.
 */
export function signalSourceDue(source: string): string {
  const signalPath = getSourceDueSignalPath(source);
  const directory = path.dirname(signalPath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const directoryStat = fs.lstatSync(directory);
  if (
    !directoryStat.isDirectory()
    || directoryStat.isSymbolicLink()
    || directoryStat.uid !== currentUid()
  ) {
    throw new Error('Source due-signal directory is not an owned real directory');
  }
  fs.chmodSync(directory, 0o700);
  assertPrivateDirectory(directory);

  const temporaryPath = path.join(
    directory,
    `.${path.basename(signalPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let descriptor: number | null = null;
  let published = false;
  try {
    descriptor = fs.openSync(
      temporaryPath,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR,
      0o600,
    );
    fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(descriptor, SOURCE_DUE_SIGNAL_MARKER, 'utf8');
    // A final name with this private read-only mode is a crash-recovery
    // publication. The cadence reader uses its rename-updated ctime as the
    // generation until the normal post-rename mtime stamp is durable.
    fs.fchmodSync(descriptor, SOURCE_DUE_SIGNAL_PENDING_MODE);
    fs.fsyncSync(descriptor);
    fs.renameSync(temporaryPath, signalPath);
    published = true;

    // A positional rewrite asks the kernel to timestamp the inode after the
    // final rename, at filesystem-clock precision. Reusing the temp-file mtime
    // would let a browse that starts between the temp write and rename
    // acknowledge a notification it could not have observed.
    const bytesWritten = fs.writeSync(
      descriptor,
      MARKER_BYTES,
      0,
      MARKER_BYTES.length,
      0,
    );
    if (bytesWritten !== MARKER_BYTES.length) {
      throw new Error('Could not stamp the published source due signal');
    }
    // First make the post-rename generation durable while the marker is still
    // recognizably pending. Only then publish the normal mode and sync again.
    // A crash at either boundary therefore leaves a due pending marker or a
    // normal marker whose post-rename mtime is already durable.
    fs.fsyncSync(descriptor);
    fs.fchmodSync(descriptor, 0o600);
    fs.fsyncSync(descriptor);
    verifyFinalSignal(signalPath, descriptor);
    syncPrivateDirectory(directory);
    fs.closeSync(descriptor);
    descriptor = null;
  } catch (error) {
    // Once rename succeeds, never remove or hide the signal. If normal
    // publication fails, durably retain either the pending-mode marker (whose
    // ctime is the rename generation) or the already-restamped final marker.
    // The cadence reader fails due on pending ambiguity.
    if (published) {
      if (descriptor !== null) {
        try {
          fs.fsyncSync(descriptor);
        } catch {
          // The directory sync below can still preserve an already-durable
          // pending marker. Preserve the original publication failure.
        }
      }
      try {
        syncPrivateDirectory(directory);
      } catch {
        // Preserve the original publication failure.
      }
    }
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // Preserve the original publication failure.
      }
    }
    if (!published) {
      try {
        fs.unlinkSync(temporaryPath);
      } catch {
        // The temporary file may not exist.
      }
    }
    throw error;
  }
  return signalPath;
}

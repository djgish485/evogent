import { spawn } from 'node:child_process';
import {
  getSharedBrowserCdpUrl,
  probeSharedBrowserSession,
  probeSharedBrowserVersion,
} from '@/lib/shared-browser';

const SHARED_BROWSER_RESTART_COMMAND_ENV_KEYS = [
  'MEDIA_AGENT_SHARED_BROWSER_RESTART_COMMAND',
  'SHARED_BROWSER_RESTART_COMMAND',
] as const;
const SHARED_BROWSER_RESTART_TIMEOUT_MS = 30_000;
const SHARED_BROWSER_RESTART_POLL_INTERVAL_MS = 1_000;

export type SharedBrowserRestartAdapterOverrides = {
  restartSharedBrowser?: (input: {
    cdpUrl: string;
    previousWebSocketDebuggerUrl: string | null;
    verifyReady?: () => Promise<void>;
  }) => Promise<void>;
};

let restartAdapterOverrides: SharedBrowserRestartAdapterOverrides | null = null;

function compactErrorMessage(error: unknown) {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }

  if (typeof error === 'string' && error.trim()) {
    return error.trim();
  }

  return 'unknown error';
}

function getSharedBrowserRestartCommand() {
  for (const key of SHARED_BROWSER_RESTART_COMMAND_ENV_KEYS) {
    const value = process.env[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  return '';
}

function getManagedSharedBrowserServiceName(input: { serviceName?: string | null }) {
  const explicit = typeof input.serviceName === 'string' ? input.serviceName.trim() : '';
  if (explicit) {
    return explicit;
  }

  const configured = process.env.SHARED_BROWSER_SERVICE_NAME;
  if (typeof configured === 'string' && configured.trim()) {
    return configured.trim();
  }

  return '';
}

async function runSharedBrowserRestartCommand(command: string, cdpUrl: string) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('bash', ['-lc', command], {
      env: {
        ...process.env,
        MEDIA_AGENT_SHARED_BROWSER_CDP_URL: cdpUrl,
        SHARED_BROWSER_CDP_URL: cdpUrl,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      const detail = [
        stderr.trim() ? `stderr=${stderr.trim()}` : null,
        stdout.trim() ? `stdout=${stdout.trim()}` : null,
      ].filter(Boolean).join(', ');

      reject(new Error(
        `Shared browser restart command exited with code ${code ?? 'unknown'}`
        + (detail ? ` [${detail}]` : ''),
      ));
    });
  });
}

async function restartManagedSharedBrowserService(serviceName: string) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('systemctl', ['restart', serviceName], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      const detail = [
        stderr.trim() ? `stderr=${stderr.trim()}` : null,
        stdout.trim() ? `stdout=${stdout.trim()}` : null,
      ].filter(Boolean).join(', ');

      reject(new Error(
        `systemctl restart ${serviceName} exited with code ${code ?? 'unknown'}`
        + (detail ? ` [${detail}]` : ''),
      ));
    });
  });
}

async function waitForSharedBrowserReady(input: {
  cdpUrl: string;
  previousWebSocketDebuggerUrl: string | null;
  verifyReady?: () => Promise<void>;
  timeoutMs?: number;
}) {
  const timeoutMs = Math.max(1, input.timeoutMs ?? SHARED_BROWSER_RESTART_TIMEOUT_MS);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const probeTimeoutMs = Math.max(1, Math.min(5_000, deadline - Date.now()));
    const probe = await probeSharedBrowserVersion({
      cdpUrl: input.cdpUrl,
      timeoutMs: probeTimeoutMs,
    });

    if (
      probe.ok
      && (!input.previousWebSocketDebuggerUrl || probe.webSocketDebuggerUrl !== input.previousWebSocketDebuggerUrl)
    ) {
      const sessionProbe = await probeSharedBrowserSession({
        cdpUrl: input.cdpUrl,
        timeoutMs: probeTimeoutMs,
      });

      if (sessionProbe.ok) {
        if (input.verifyReady) {
          await input.verifyReady();
        }
        return;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, SHARED_BROWSER_RESTART_POLL_INTERVAL_MS));
  }

  const finalProbe = await probeSharedBrowserVersion({
    cdpUrl: input.cdpUrl,
    timeoutMs: 5_000,
  });
  if (!finalProbe.ok) {
    throw new Error(finalProbe.error || 'Shared browser did not recover');
  }

  if (
    input.previousWebSocketDebuggerUrl
    && finalProbe.webSocketDebuggerUrl === input.previousWebSocketDebuggerUrl
  ) {
    throw new Error(
      `Shared browser restart kept returning the same browser WebSocket (${input.previousWebSocketDebuggerUrl})`
      + ` at ${finalProbe.versionUrl} after ${timeoutMs}ms.`,
    );
  }

  const finalSessionProbe = await probeSharedBrowserSession({
    cdpUrl: input.cdpUrl,
    timeoutMs: 5_000,
  });
  if (!finalSessionProbe.ok) {
    throw new Error(finalSessionProbe.error || 'Shared browser session did not recover');
  }

  if (input.verifyReady) {
    await input.verifyReady();
  }
}

export async function restartSharedBrowserUsingAdapter(input: {
  cdpUrl?: string;
  verifyReady?: () => Promise<void>;
} = {}) {
  const cdpUrl = getSharedBrowserCdpUrl(input.cdpUrl);
  const previousProbe = await probeSharedBrowserVersion({
    cdpUrl,
    timeoutMs: 5_000,
  }).catch(() => null);
  const previousWebSocketDebuggerUrl = previousProbe?.ok ? previousProbe.webSocketDebuggerUrl : null;

  if (restartAdapterOverrides?.restartSharedBrowser) {
    await restartAdapterOverrides.restartSharedBrowser({
      cdpUrl,
      previousWebSocketDebuggerUrl,
      verifyReady: input.verifyReady,
    });
    return;
  }

  const command = getSharedBrowserRestartCommand();
  const serviceName = getManagedSharedBrowserServiceName({
    serviceName: previousProbe?.ownership?.serviceName ?? null,
  });
  if (!command) {
    if (!serviceName) {
      throw new Error(
        'Shared browser restart adapter is not configured for this deployment.'
        + ' Set MEDIA_AGENT_SHARED_BROWSER_RESTART_COMMAND if a non-desktop environment needs restart handling.',
      );
    }
  }

  try {
    if (command) {
      await runSharedBrowserRestartCommand(command, cdpUrl);
    } else {
      await restartManagedSharedBrowserService(serviceName);
    }
    await waitForSharedBrowserReady({
      cdpUrl,
      previousWebSocketDebuggerUrl,
      verifyReady: input.verifyReady,
    });
  } catch (error) {
    throw new Error(`Shared browser restart adapter failed: ${compactErrorMessage(error)}`);
  }
}

export const __testOnly = {
  resetRestartAdapterOverrides() {
    restartAdapterOverrides = null;
  },
  setRestartAdapterOverrides(overrides: SharedBrowserRestartAdapterOverrides | null) {
    restartAdapterOverrides = overrides;
  },
};

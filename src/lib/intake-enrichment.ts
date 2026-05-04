import { execFile } from 'node:child_process';

const defaultIntakeEnrichScriptPath = 'scripts/intake-enrich.ts';
const intakeEnrichTimeoutMs = 30_000;

function getIntakeEnrichScriptPath() {
  const configuredPath = process.env.INTAKE_ENRICH_SCRIPT_PATH?.trim();
  return configuredPath || defaultIntakeEnrichScriptPath;
}

export function triggerIntakeEnrichment(feedItemId: string): Promise<void> {
  if (!feedItemId) return Promise.resolve();

  return new Promise((resolve, reject) => {
    execFile('npx', ['tsx', getIntakeEnrichScriptPath(), '--id', feedItemId], {
      cwd: process.cwd(),
      env: process.env,
      timeout: intakeEnrichTimeoutMs,
    }, (error, stdout, stderr) => {
      if (stdout) {
        console.log('[intake-enrich]', stdout.trim());
      }
      if (stderr) {
        console.warn('[intake-enrich] stderr:', stderr.trim());
      }
      if (error) {
        console.error('[intake-enrich] error:', error.message);
        reject(error);
        return;
      }
      resolve();
    });
  });
}

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const codingAgentOnly = process.argv.includes('--coding-agent-only');
const port = Number.parseInt(process.env.PORT || '3001', 10);
const apiBase = `http://127.0.0.1:${Number.isFinite(port) ? port : 3001}`;
const installedPhoneCurl = path.join(os.homedir(), 'phone-tools', 'evo-curl');
const authenticatedCurl = process.env.EVOGENT_API_CURL?.trim()
  || (fs.existsSync(installedPhoneCurl) ? installedPhoneCurl : '');

function requestViaAuthenticatedCurl(path, init) {
  return new Promise((resolve, reject) => {
    const method = init?.method || 'GET';
    const args = [
      '--fail-with-body',
      '--silent',
      '--show-error',
      '--max-time',
      '15',
      '--request',
      method,
      '--header',
      'Content-Type: application/json',
    ];
    if (init?.body !== undefined) args.push('--data-binary', '@-');
    args.push(`${apiBase}${path}`);
    const child = spawn(authenticatedCurl, args, {
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      const text = Buffer.concat(stdout).toString('utf8');
      if (code !== 0) {
        const detail = Buffer.concat(stderr).toString('utf8').trim();
        reject(new Error(`${method} ${path} failed: ${detail || `client exit ${code}`}`));
        return;
      }
      try {
        resolve(text ? JSON.parse(text) : null);
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(init?.body);
  });
}

async function requestJson(path, init = {}) {
  let lastError;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      if (authenticatedCurl) {
        return await requestViaAuthenticatedCurl(path, init);
      }
      const response = await fetch(`${apiBase}${path}`, {
        ...init,
        headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
        cache: 'no-store',
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`${init?.method || 'GET'} ${path} failed: ${response.status} ${response.statusText} ${text}`);
      }
      return text ? JSON.parse(text) : null;
    } catch (error) {
      lastError = error;
      if (attempt < 19) await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw lastError;
}

async function getSessions() {
  const sessions = [];
  let offset = 0;
  for (;;) {
    const payload = await requestJson(`/api/chat/sessions?limit=100&offset=${offset}`);
    if (!payload || !Array.isArray(payload.sessions)) throw new Error('GET /api/chat/sessions returned an invalid response');
    sessions.push(...payload.sessions);
    if (!payload.hasMore) return sessions;
    offset = Number.isFinite(payload.nextOffset) ? payload.nextOffset : sessions.length;
  }
}

try {
  const sessions = await getSessions();
  const hasGeneral = sessions.some((session) => session?.sessionType === null);
  const hasCurator = sessions.some((session) => session?.sessionType === 'curator');
  const results = {
    general: hasGeneral ? 'skipped' : 'created',
    curator: codingAgentOnly ? 'skipped-coding-agent-only' : hasCurator ? 'skipped' : 'created',
  };

  if (!hasGeneral) await requestJson('/api/chat/sessions', {
    method: 'POST',
    body: JSON.stringify({ title: 'General Agent', sessionType: null }),
  });
  if (!codingAgentOnly && !hasCurator) await requestJson('/api/chat/sessions', {
    method: 'POST',
    body: JSON.stringify({ title: 'Curator Agent', sessionType: 'curator', color: 'amber' }),
  });

  console.log(`default sessions: general=${results.general} curator=${results.curator}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

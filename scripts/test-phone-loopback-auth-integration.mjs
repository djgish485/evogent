import assert from 'node:assert/strict';
import fs from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  CHALLENGE_DOMAIN,
  CLIENT_DOMAIN,
  SESSION_DOMAIN,
  hmacHex,
} = require('../lib/phone-loopback-auth.js');
const Database = require('better-sqlite3');

const repoDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const testToken = 'integration-control-token-with-enough-entropy';

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function waitForReady(child, output, timeoutMs = 45_000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`phone server did not become ready\n${output.text.slice(-4000)}`));
    }, timeoutMs);
    const inspect = () => {
      if (!output.text.includes('> Ready on ')) return;
      clearTimeout(timeout);
      child.off('exit', onExit);
      resolve();
    };
    const onExit = (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`phone server exited before ready (${code ?? signal})\n${output.text.slice(-4000)}`));
    };
    child.once('exit', onExit);
    child.stdout.on('data', inspect);
    child.stderr.on('data', inspect);
    inspect();
  });
}

function makeTestTlsMaterial(dataDir) {
  const certPath = path.join(dataDir, 'test-server-cert.pem');
  const keyPath = path.join(dataDir, 'test-server-key.pem');
  const generated = spawnSync('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-sha256',
    '-nodes',
    '-keyout',
    keyPath,
    '-out',
    certPath,
    '-days',
    '1',
    '-subj',
    '/CN=127.0.0.1',
    '-addext',
    'subjectAltName=IP:127.0.0.1',
  ], {
    cwd: repoDir,
    encoding: 'utf8',
  });
  assert.equal(
    generated.status,
    0,
    `could not generate integration-test TLS material: ${generated.stderr}`,
  );
  fs.chmodSync(keyPath, 0o600);
  return { certPath, keyPath };
}

function startServer({
  port,
  httpsPort,
  dataDir,
  certPath,
  keyPath,
}) {
  const output = { text: '' };
  const child = spawn(process.execPath, ['server.js'], {
    cwd: repoDir,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      EVOGENT_RUNTIME_PROFILE: 'phone',
      EVOGENT_ADAPTIVE_HEARTBEAT_MODE: 'off',
      EVOGENT_PHONE_HTTPS_PORT: String(httpsPort),
      EVOGENT_PHONE_TLS_CERT_PATH: certPath,
      EVOGENT_PHONE_TLS_KEY_PATH: keyPath,
      PORT: String(port),
      DATA_DIR: dataDir,
      MEDIA_AGENT_STATE_DIR: path.join(dataDir, 'agent-state'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const append = (chunk) => {
    output.text = `${output.text}${chunk.toString('utf8')}`.slice(-16_000);
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  return { child, output };
}

async function stopServer(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  const force = setTimeout(() => child.kill('SIGKILL'), 5000);
  await exited;
  clearTimeout(force);
}

function runEvoCurl({ port, dataDir, args }) {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [
      path.join(repoDir, 'phone-paradigm/device/phone-tools/evo-curl'),
      ...args,
    ], {
      cwd: repoDir,
      env: {
        ...process.env,
        PORT: String(port),
        DATA_DIR: dataDir,
        EVOGENT_PHONE_TOOLS: path.join(
          repoDir,
          'phone-paradigm/device/phone-tools',
        ),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', reject);
    child.once('exit', (code) => resolve({
      code,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }));
  });
}

async function jsonPost(url, body, headers = {}) {
  return fetch(url, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function httpsFetch(url, options, ca) {
  return new Promise((resolve, reject) => {
    const body = typeof options?.body === 'string'
      ? Buffer.from(options.body, 'utf8')
      : null;
    const request = https.request(url, {
      method: options?.method || 'GET',
      ca,
      rejectUnauthorized: true,
      headers: {
        ...(options?.headers || {}),
        ...(body ? { 'Content-Length': String(body.length) } : {}),
      },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const responseBody = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: response.statusCode,
          headers: {
            get(name) {
              const value = response.headers[name.toLowerCase()];
              return Array.isArray(value) ? value[0] ?? null : value ?? null;
            },
          },
          async json() {
            return JSON.parse(responseBody);
          },
        });
      });
    });
    request.once('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

async function authenticate(baseUrl, kind, post = jsonPost, expectedStatus = 200) {
  const clientNonce = 'ab'.repeat(32);
  const challengeResponse = await post(`${baseUrl}/api/phone-auth/challenge`, {
    clientNonce,
  });
  assert.equal(challengeResponse.status, 200);
  assert.match(challengeResponse.headers.get('content-type') || '', /^application\/json/);
  assert.match(challengeResponse.headers.get('cache-control') || '', /no-store/);
  assert.match(challengeResponse.headers.get('pragma') || '', /no-cache/);
  assert.equal(challengeResponse.headers.get('expires'), '0');
  const challenge = await challengeResponse.json();
  const fields = [
    '1',
    clientNonce,
    challenge.serverInstanceId,
    challenge.challengeId,
    challenge.serverNonce,
    String(challenge.expiresAtMs),
  ];
  assert.equal(
    challenge.serverProof,
    hmacHex(Buffer.from(testToken), CHALLENGE_DOMAIN, fields)
  );
  const clientProof = hmacHex(
    Buffer.from(testToken),
    CLIENT_DOMAIN,
    [...fields, kind]
  );
  const completeResponse = await post(`${baseUrl}/api/phone-auth/complete`, {
    ...challenge,
    sessionKind: kind,
    clientProof,
  });
  assert.equal(completeResponse.status, expectedStatus);
  if (expectedStatus !== 200) {
    return { session: null, setCookie: completeResponse.headers.get('set-cookie') };
  }
  const session = await completeResponse.json();
  assert.equal(
    session.sessionProof,
    hmacHex(Buffer.from(testToken), SESSION_DOMAIN, [
      ...fields,
      kind,
      session.sessionToken,
      String(session.sessionExpiresAtMs),
    ])
  );
  return {
    session,
    setCookie: completeResponse.headers.get('set-cookie'),
  };
}

async function main() {
  assert.equal(
    fs.existsSync(path.join(repoDir, '.next', 'BUILD_ID')),
    true,
    'run npm run build before the phone auth integration test'
  );
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-phone-server-'));
  const tls = makeTestTlsMaterial(dataDir);
  fs.writeFileSync(path.join(dataDir, 'control-token.txt'), `${testToken}\n`, {
    mode: 0o600,
  });
  const port = await freePort();
  const httpsPort = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const secureBaseUrl = `https://127.0.0.1:${httpsPort}`;
  const ca = fs.readFileSync(tls.certPath);
  const securePost = (url, body, headers = {}) => httpsFetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  }, ca);
  const secureGet = (url, headers = {}) => httpsFetch(url, { headers }, ca);
  let first;
  let second;
  try {
    first = startServer({
      port,
      httpsPort,
      dataDir,
      certPath: tls.certPath,
      keyPath: tls.keyPath,
    });
    await waitForReady(first.child, first.output);

    const anonymous = await fetch(`${baseUrl}/`);
    assert.equal(anonymous.status, 401);

    const termuxClient = await runEvoCurl({
      port,
      dataDir,
      args: [
        '--fail',
        '--silent',
        '--show-error',
        `${baseUrl}/api/internal/deployment-status`,
      ],
    });
    assert.equal(termuxClient.code, 0, termuxClient.stderr);
    assert.ok(JSON.parse(termuxClient.stdout).running);

    const privateCanary = 'PRIVATE_PHONE_NOTIFICATION_RUNTIME_CANARY_6217';
    const database = new Database(path.join(dataDir, 'media-agent.db'));
    database.prepare(`
      INSERT INTO feed (
        id, type, source, source_id, title, text, published_at, created_at
      ) VALUES
        (
          'phone-runtime-private',
          'notification',
          'phone-notification',
          'phone-notification:runtime-private',
          ?,
          ?,
          '2026-07-28T12:01:00.000Z',
          '2026-07-28T12:01:00.000Z'
        ),
        (
          'phone-runtime-safe',
          'article',
          'integration-test',
          'integration-test:safe',
          'Safe runtime evidence',
          'Safe runtime evidence body',
          '2026-07-28T12:00:00.000Z',
          '2026-07-28T12:00:00.000Z'
        )
    `).run(`Private title ${privateCanary}`, `Private body ${privateCanary}`);
    database.close();

    // This is the exact caller used by on-phone runtime agents. The ordinary
    // feed URL must automatically select the supported agent-evidence view from
    // its direct application session; no voluntary query flag is involved.
    // This tests API routing, not isolation from same-UID filesystem access.
    const runtimeFeed = await runEvoCurl({
      port,
      dataDir,
      args: [
        '--fail',
        '--silent',
        '--show-error',
        `${baseUrl}/api/feed?limit=20`,
      ],
    });
    assert.equal(runtimeFeed.code, 0, runtimeFeed.stderr);
    assert.doesNotMatch(runtimeFeed.stdout, new RegExp(privateCanary));
    assert.ok(
      JSON.parse(runtimeFeed.stdout).items.some((item) => item.id === 'phone-runtime-safe'),
    );

    const direct = await authenticate(baseUrl, 'direct');
    const directHeader = {
      Authorization: `EvogentSession ${direct.session.sessionToken}`,
    };
    assert.equal(
      (await fetch(`${baseUrl}/api/feed?limit=1`, { headers: directHeader })).status,
      200
    );
    assert.equal(
      (await fetch(`${baseUrl}/api/feed?limit=1`, { headers: directHeader })).status,
      401
    );

    const refusedWeb = await authenticate(baseUrl, 'web', jsonPost, 403);
    assert.equal(refusedWeb.setCookie, null);

    const web = await authenticate(secureBaseUrl, 'web', securePost);
    assert.match(web.setCookie || '', /^evogent_phone_session=/);
    assert.match(web.setCookie || '', /HttpOnly/);
    assert.match(web.setCookie || '', /Secure/);
    const cookie = (web.setCookie || '').split(';', 1)[0];
    assert.equal((await fetch(`${baseUrl}/`, { headers: { Cookie: cookie } })).status, 401);
    assert.equal((await secureGet(`${secureBaseUrl}/`, { Cookie: cookie })).status, 200);
    const webFeedResponse = await secureGet(
      `${secureBaseUrl}/api/feed?limit=20`,
      { Cookie: cookie },
    );
    assert.equal(webFeedResponse.status, 200);
    const webFeed = await webFeedResponse.json();
    assert.match(JSON.stringify(webFeed), new RegExp(privateCanary));
    assert.ok(webFeed.items.some((item) => item.id === 'phone-runtime-private'));
    assert.equal(
      (await securePost(`${secureBaseUrl}/api/internal/feed-notify`, { items: [] }, { Cookie: cookie })).status,
      200
    );

    const secretPath = path.join(dataDir, 'server-loopback-secret');
    const firstSecret = fs.readFileSync(secretPath, 'utf8').trim();
    assert.equal(fs.statSync(secretPath).mode & 0o777, 0o600);
    assert.equal(
      (await fetch(`${baseUrl}/api/feed?limit=1`, {
        headers: { 'X-Evogent-Server-Secret': firstSecret },
      })).status,
      200
    );

    await stopServer(first.child);
    first = null;
    second = startServer({
      port,
      httpsPort,
      dataDir,
      certPath: tls.certPath,
      keyPath: tls.keyPath,
    });
    await waitForReady(second.child, second.output);

    assert.equal((await secureGet(`${secureBaseUrl}/`, { Cookie: cookie })).status, 401);
    assert.equal(
      (await fetch(`${baseUrl}/api/feed?limit=1`, {
        headers: { 'X-Evogent-Server-Secret': firstSecret },
      })).status,
      401
    );
    const secondSecret = fs.readFileSync(secretPath, 'utf8').trim();
    assert.notEqual(secondSecret, firstSecret);
    assert.equal(
      (await fetch(`${baseUrl}/api/feed?limit=1`, {
        headers: { 'X-Evogent-Server-Secret': secondSecret },
      })).status,
      200
    );

    process.stdout.write('phone loopback auth integration: passed\n');
  } finally {
    if (first) await stopServer(first.child);
    if (second) await stopServer(second.child);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

await main();

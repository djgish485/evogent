import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const wrapper = path.join(
  root,
  'phone-paradigm/device/phone-tools/evo-curl',
);
const healthProbe = path.join(
  root,
  'phone-paradigm/device/phone-tools/evo-health',
);
const phoneTools = path.join(root, 'phone-paradigm/device/phone-tools');
const CHALLENGE_DOMAIN = 'evogent/phone-auth/server/v1';
const CLIENT_DOMAIN = 'evogent/phone-auth/client/v1';
const SESSION_DOMAIN = 'evogent/phone-auth/session/v1';

function encodeField(value) {
  const body = Buffer.from(String(value));
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  return Buffer.concat([length, body]);
}

function hmacHex(token, domain, fields) {
  return createHmac('sha256', Buffer.from(token))
    .update(Buffer.concat([encodeField(domain), ...fields.map(encodeField)]))
    .digest('hex');
}

function makeFixture() {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-evo-curl-'));
  const home = path.join(fixture, 'home');
  const data = path.join(home, 'evogent', 'data');
  fs.mkdirSync(data, { recursive: true });
  const token = 'test-control-token-with-enough-entropy';
  const tokenFile = path.join(data, 'control-token.txt');
  fs.writeFileSync(tokenFile, token, { mode: 0o600 });
  return {
    fixture,
    home,
    data,
    token,
    tokenFile,
    env: {
      ...process.env,
      HOME: home,
      DATA_DIR: data,
      PORT: '3001',
      EVOGENT_PHONE_TOOLS: phoneTools,
    },
  };
}

function run(clientFixture, args, env = {}) {
  return spawnSync('bash', [wrapper, ...args], {
    encoding: 'utf8',
    env: { ...clientFixture.env, ...env },
  });
}

function runAsync(clientFixture, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [wrapper, ...args], {
      env: { ...clientFixture.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (status) => resolve({
      status,
      stdout: Buffer.concat(stdout).toString(),
      stderr: Buffer.concat(stderr).toString(),
    }));
  });
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

test('evo-curl authenticates and sends the protected request on one TCP connection', async () => {
  const fixture = makeFixture();
  const sockets = [];
  const protectedBody = 'protected-body-never-for-a-first-contact-listener';
  const sessionToken = 'S'.repeat(43);
  let fields;
  const server = http.createServer(async (request, response) => {
    if (!sockets.includes(request.socket)) sockets.push(request.socket);
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();

    if (request.url === '/api/phone-auth/challenge') {
      const input = JSON.parse(body);
      const challenge = {
        version: 1,
        clientNonce: input.clientNonce,
        serverInstanceId: '1'.repeat(32),
        challengeId: '2'.repeat(32),
        serverNonce: '3'.repeat(64),
        expiresAtMs: Date.now() + 30_000,
      };
      fields = [
        '1',
        challenge.clientNonce,
        challenge.serverInstanceId,
        challenge.challengeId,
        challenge.serverNonce,
        String(challenge.expiresAtMs),
      ];
      challenge.serverProof = hmacHex(
        fixture.token,
        CHALLENGE_DOMAIN,
        fields,
      );
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(challenge));
      return;
    }
    if (request.url === '/api/phone-auth/complete') {
      const input = JSON.parse(body);
      assert.equal(
        input.clientProof,
        hmacHex(fixture.token, CLIENT_DOMAIN, [...fields, 'direct']),
      );
      const sessionExpiresAtMs = Date.now() + 30_000;
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({
        version: 1,
        sessionKind: 'direct',
        sessionToken,
        sessionExpiresAtMs,
        sessionProof: hmacHex(fixture.token, SESSION_DOMAIN, [
          ...fields,
          'direct',
          sessionToken,
          String(sessionExpiresAtMs),
        ]),
      }));
      return;
    }
    assert.equal(request.url, '/api/internal/example');
    assert.equal(
      request.headers.authorization,
      `EvogentSession ${sessionToken}`,
    );
    assert.equal(body, protectedBody);
    response.setHeader('Content-Type', 'application/json');
    response.setHeader('Connection', 'close');
    response.end('{"ok":true}');
  });
  const port = await listen(server);
  const result = await runAsync(fixture, [
    '-sS',
    '-m8',
    '-X',
    'POST',
    '-H',
    'Content-Type: text/plain',
    '-d',
    protectedBody,
    `http://127.0.0.1:${port}/api/internal/example`,
  ], { PORT: String(port) });
  await close(server);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '{"ok":true}');
  assert.equal(sockets.length, 1, 'challenge, completion, and request changed TCP sockets');
});

test('a hostile listener receives no control token, stale secret, or protected body', async () => {
  const fixture = makeFixture();
  const protectedBody = 'highly-protected-request-body';
  const staleSecret = 'stale-process-secret-must-never-cross-the-socket';
  fs.writeFileSync(
    path.join(fixture.data, 'server-loopback-secret'),
    `${staleSecret}\n`,
    { mode: 0o600 },
  );
  const received = [];
  const hostile = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    received.push(body);
    const input = JSON.parse(body);
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({
      version: 1,
      clientNonce: input.clientNonce,
      serverInstanceId: '1'.repeat(32),
      challengeId: '2'.repeat(32),
      serverNonce: '3'.repeat(64),
      expiresAtMs: Date.now() + 30_000,
      serverProof: '0'.repeat(64),
    }));
  });
  const port = await listen(hostile);
  const result = await runAsync(fixture, [
    '--silent',
    '--request',
    'POST',
    '--header',
    `X-Test-Stale-Marker: ${staleSecret}`,
    '--data',
    protectedBody,
    `http://127.0.0.1:${port}/api/internal/example`,
  ], { PORT: String(port) });
  await close(hostile);
  assert.notEqual(result.status, 0);
  assert.equal(received.length, 1, 'client progressed past the unauthenticated challenge');
  const firstContact = received.join('\n');
  assert.doesNotMatch(firstContact, new RegExp(fixture.token));
  assert.doesNotMatch(firstContact, new RegExp(staleSecret));
  assert.doesNotMatch(firstContact, new RegExp(protectedBody));
  assert.match(firstContact, /clientNonce/);
});

test('evo-curl refuses off-origin and authority-confusion destinations', () => {
  for (const destination of [
    'https://127.0.0.1:3001/api/status',
    'http://localhost:3001/api/status',
    'http://127.0.0.1:3002/api/status',
    'http://127.0.0.1:3001@example.invalid/api/status',
    'https://example.invalid/',
  ]) {
    const fixture = makeFixture();
    const result = run(fixture, [destination]);
    assert.equal(result.status, 64, destination);
    assert.match(result.stderr, /exact on-phone Evogent origin/);
  }

  const fixture = makeFixture();
  const extraDestination = run(fixture, [
    'example.invalid/hidden-second-request',
    'http://127.0.0.1:3001/api/status',
  ]);
  assert.equal(extraDestination.status, 64);
  assert.match(
    extraDestination.stderr,
    /exactly one explicit on-phone Evogent URL/,
  );
});

test('evo-curl refuses redirect, proxy, hidden-config, reroute, and trace options', () => {
  for (const option of [
    '-L',
    '-fsSL',
    '-sK/tmp/hidden-curl-config',
    '-sHAuthorization:injected',
    '-0',
    '-2',
    '--location',
    '--config',
    '--proxy=http://example.invalid',
    '--connect-to=127.0.0.1:3001:example.invalid:80',
    '--resolve=127.0.0.1:3001:203.0.113.1',
    '--url=http://127.0.0.1:3001/api/status',
    '--variable=destination=http://example.invalid',
    '--expand-url={{destination}}',
    '--doh-url=https://example.invalid/dns-query',
    '-:',
    '-Z',
    '--trace-ascii=-',
    '--verbose',
  ]) {
    const fixture = makeFixture();
    const result = run(fixture, [
      option,
      'http://127.0.0.1:3001/api/status',
    ]);
    assert.equal(result.status, 64, option);
    assert.match(result.stderr, /unsafe curl option/);
  }
});

test('evo-curl rejects malformed, permissive, and caller-supplied credentials', () => {
  {
    const fixture = makeFixture();
    fs.chmodSync(fixture.tokenFile, 0o644);
    const result = run(fixture, ['http://127.0.0.1:3001/api/status']);
    assert.equal(result.status, 64);
    assert.match(result.stderr, /permissions must be 0600/);
  }
  {
    const fixture = makeFixture();
    fs.writeFileSync(fixture.tokenFile, 'short\n', { mode: 0o600 });
    const result = run(fixture, ['http://127.0.0.1:3001/api/status']);
    assert.equal(result.status, 64);
    assert.match(result.stderr, /invalid length/);
  }
  {
    const fixture = makeFixture();
    const target = path.join(fixture.data, 'real-control-token.txt');
    fs.renameSync(fixture.tokenFile, target);
    fs.symlinkSync(target, fixture.tokenFile);
    const result = run(fixture, ['http://127.0.0.1:3001/api/status']);
    assert.equal(result.status, 64);
    assert.match(result.stderr, /not a regular private file/);
  }
  {
    const fixture = makeFixture();
    const result = run(fixture, [
      '-H',
      'X-Evogent-Server-Secret: caller-value',
      'http://127.0.0.1:3001/api/status',
    ]);
    assert.equal(result.status, 64);
    assert.match(result.stderr, /may not provide/);
  }
  {
    const fixture = makeFixture();
    const result = run(fixture, [
      '-H',
      'X-Safe: value\r\nAuthorization: injected',
      'http://127.0.0.1:3001/api/status',
    ]);
    assert.equal(result.status, 64);
    assert.match(result.stderr, /forbidden control character/);
  }
});

test('evo-health accepts only authenticated output for the exact running release', () => {
  const fixture = makeFixture();
  const identity = {
    releaseFormat: 1,
    releaseId: 'release-under-test',
    buildId: 'build-under-test',
    sourceCommit: 'a'.repeat(40),
  };
  const identityFile = path.join(fixture.fixture, 'identity.json');
  const mockClient = path.join(fixture.fixture, 'mock-evo-curl');
  fs.writeFileSync(identityFile, JSON.stringify(identity), { mode: 0o600 });
  fs.writeFileSync(
    mockClient,
    '#!/usr/bin/env bash\nprintf "%s" "${MOCK_HEALTH_BODY:-}"\nexit "${MOCK_HEALTH_EXIT:-0}"\n',
    { mode: 0o755 },
  );
  const validBody = JSON.stringify({
    running: {
      releaseFormat: identity.releaseFormat,
      releaseId: identity.releaseId,
      buildId: identity.buildId,
      commitFull: identity.sourceCommit,
    },
  });
  const env = {
    ...fixture.env,
    EVOGENT_EVO_CURL: mockClient,
    EVOGENT_RELEASE_IDENTITY: identityFile,
    MOCK_HEALTH_BODY: validBody,
  };
  const valid = spawnSync('bash', [healthProbe], { encoding: 'utf8', env });
  assert.equal(valid.status, 0, valid.stderr);
  assert.equal(valid.stdout, '');

  for (const override of [
    { MOCK_HEALTH_BODY: '' },
    {
      MOCK_HEALTH_BODY: JSON.stringify({
        running: {
          releaseFormat: 1,
          releaseId: 'different-release',
          buildId: identity.buildId,
          commitFull: identity.sourceCommit,
        },
      }),
    },
    { MOCK_HEALTH_EXIT: '22' },
  ]) {
    const rejected = spawnSync('bash', [healthProbe], {
      encoding: 'utf8',
      env: { ...env, ...override },
    });
    assert.notEqual(rejected.status, 0);
    assert.equal(rejected.stdout, '');
  }
});

test('phone mechanics and prompts do not bypass authenticated Evogent HTTP', () => {
  const mechanics = [
    'phone-paradigm/device/install-release.sh',
    'phone-paradigm/device/restart-evo.sh',
    'phone-paradigm/device/phone-tools/evo-health',
    'phone-paradigm/device/phone-tools/evogent-boot.sh',
    'phone-paradigm/device/phone-tools/evogent-cycle.sh',
    'phone-paradigm/device/phone-tools/evogent-scheduler.sh',
    'phone-paradigm/device/phone-tools/evogent-watchdog.sh',
    'phone-paradigm/device/phone-tools/source-discovery.sh',
  ].map((relative) => fs.readFileSync(path.join(root, relative), 'utf8'));
  for (const source of mechanics) {
    assert.doesNotMatch(
      source,
      /(?:^|[^\w-])curl\b[^\n]*(?:127\.0\.0\.1|localhost|\$BASE)[^\n]*\/api\//m,
    );
  }

  const pythonMechanics = [
    'hn-fetch.py',
    'browse-x-parse.py',
    'browse-x-scrape.py',
    'browse-instagram.py',
    'browse-interests.py',
    'source-scout.py',
    'verify-intents.py',
  ].map((name) => fs.readFileSync(path.join(
    root,
    'phone-paradigm/device/phone-tools',
    name,
  ), 'utf8'));
  for (const source of pythonMechanics) {
    assert.match(source, /from evogent_api import/);
    assert.doesNotMatch(
      source,
      /urllib\.request\.(?:Request|urlopen)\([^\n]*(?:BASE|127\.0\.0\.1)/,
    );
  }

  const runtimeInstructions = [
    'AGENTS.md',
    'CLAUDE.md',
    'phone-paradigm/device/phone-tools/source-discovery-prompt.txt',
    'phone-paradigm/device/skills/phone-browse/SKILL.md',
  ].map((relative) => fs.readFileSync(path.join(root, relative), 'utf8')).join('\n');
  assert.match(runtimeInstructions, /evo-curl/);
  assert.match(runtimeInstructions, /EVOGENT_API_CURL/);

  const agentLaunchers = [
    'phone-paradigm/device/start-prod.sh',
    'phone-paradigm/device/phone-tools/evogent-boot.sh',
    'phone-paradigm/device/phone-tools/evogent-cycle.sh',
    'phone-paradigm/device/phone-tools/source-discovery.sh',
  ].map((relative) => fs.readFileSync(path.join(root, relative), 'utf8'));
  for (const source of agentLaunchers) {
    assert.match(
      source,
      /export EVOGENT_API_CURL=.*evo-curl|export EVOGENT_API_CURL="\$EVO_CURL"/,
    );
  }
});

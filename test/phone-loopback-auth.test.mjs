import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  CHALLENGE_DOMAIN,
  CLIENT_DOMAIN,
  SESSION_DOMAIN,
  createPhoneLoopbackAuth,
  hmacHex,
} = require('../lib/phone-loopback-auth.js');

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-phone-auth-'));
  const token = 'test-control-token-with-enough-entropy';
  const tokenFile = path.join(dir, 'control-token.txt');
  fs.writeFileSync(tokenFile, token, { mode: 0o600 });
  let clock = 1_800_000_000_000;
  let byte = 0;
  const auth = createPhoneLoopbackAuth({
    tokenFile,
    now: () => clock,
    randomBytes: (size) => Buffer.alloc(size, byte++),
  });
  return {
    auth,
    token,
    tokenFile,
    advance(ms) {
      clock += ms;
    },
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function complete(auth, token, sessionKind = 'web') {
  const clientNonce = 'ab'.repeat(32);
  const challenge = auth.issueChallenge(clientNonce, 'test');
  const fields = [
    '1',
    clientNonce,
    challenge.serverInstanceId,
    challenge.challengeId,
    challenge.serverNonce,
    String(challenge.expiresAtMs),
  ];
  const expectedServerProof = hmacHex(
    Buffer.from(token),
    CHALLENGE_DOMAIN,
    fields
  );
  assert.equal(challenge.serverProof, expectedServerProof);
  const clientProof = hmacHex(
    Buffer.from(token),
    CLIENT_DOMAIN,
    [...fields, sessionKind]
  );
  if (
    token === 'test-control-token-with-enough-entropy'
    && clientNonce === 'ab'.repeat(32)
    && sessionKind === 'web'
  ) {
    assert.equal(
      clientProof,
      'c7a91ea8e75817b8c0503c8e28071e5952c28dddcbc7677f7188795e7bd6e67f'
    );
  }
  const session = auth.completeChallenge({
    ...challenge,
    sessionKind,
    clientProof,
  }, 'test');
  const expectedSessionProof = hmacHex(
    Buffer.from(token),
    SESSION_DOMAIN,
    [...fields, sessionKind, session.sessionToken, String(session.sessionExpiresAtMs)]
  );
  assert.equal(session.sessionProof, expectedSessionProof);
  return { challenge, session };
}

test('server, client, and session proofs bind the full transcript', () => {
  const f = fixture();
  try {
    const { challenge, session } = complete(f.auth, f.token, 'web');
    // These fixed values are also asserted by the pure-Java Android test. A wire-format drift
    // on either side must fail the build before an APK can strand the launcher at bootstrap.
    assert.equal(
      challenge.serverProof,
      '07454b98e9cbd470868282108fb2cb35c5e47e24f94858f5546f7d82fafc10fc'
    );
    assert.equal(
      session.sessionProof,
      'fa2f1562ca5930dc190a9ff8920ad0dfb6e3d29ca472b4fdbf272160e0c66e66'
    );
    const cookie = f.auth.getWebCookie(session);
    assert.match(cookie, /^evogent_phone_session=[A-Za-z0-9_-]+;/);
    assert.match(cookie, /Secure/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.equal(f.auth.authorizeRequest({ headers: { cookie } }, { allowWeb: false }), false);
    assert.equal(f.auth.authorizeRequest({ headers: { cookie } }), true);
    assert.equal(f.auth.authorizeRequest({ headers: { cookie } }), true);
  } finally {
    f.cleanup();
  }
});

test('a direct session is single-use', () => {
  const f = fixture();
  try {
    const { session } = complete(f.auth, f.token, 'direct');
    const request = {
      headers: { authorization: `EvogentSession ${session.sessionToken}` },
    };
    assert.equal(f.auth.authorizeRequest(request, { allowDirect: false }), false);
    assert.equal(f.auth.authorizeRequest(request), true);
    assert.equal(f.auth.authorizeRequest(request), false);
  } finally {
    f.cleanup();
  }
});

test('wrong client proof consumes the challenge', () => {
  const f = fixture();
  try {
    const challenge = f.auth.issueChallenge('cd'.repeat(32), 'test');
    const request = {
      ...challenge,
      sessionKind: 'web',
      clientProof: '00'.repeat(32),
    };
    assert.throws(
      () => f.auth.completeChallenge(request, 'test'),
      { code: 'invalid_proof' }
    );
    assert.throws(
      () => f.auth.completeChallenge(request, 'test'),
      { code: 'invalid_challenge' }
    );
  } finally {
    f.cleanup();
  }
});

test('expired challenges and sessions fail closed', () => {
  const f = fixture();
  try {
    const clientNonce = 'ef'.repeat(32);
    const challenge = f.auth.issueChallenge(clientNonce, 'test');
    f.advance(31_000);
    assert.throws(
      () => f.auth.completeChallenge({
        ...challenge,
        sessionKind: 'web',
        clientProof: '00'.repeat(32),
      }, 'test'),
      { code: 'invalid_challenge' }
    );

    const { session } = complete(f.auth, f.token, 'direct');
    f.advance(31_000);
    assert.equal(f.auth.authorizeRequest({
      headers: { authorization: `EvogentSession ${session.sessionToken}` },
    }), false);
  } finally {
    f.cleanup();
  }
});

test('sessions are bound to one server process instance', () => {
  const f = fixture();
  try {
    const { session } = complete(f.auth, f.token, 'web');
    const cookie = f.auth.getWebCookie(session);
    const other = createPhoneLoopbackAuth({ tokenFile: f.tokenFile });
    assert.equal(other.authorizeRequest({ headers: { cookie } }), false);
  } finally {
    f.cleanup();
  }
});

test('missing token material never issues a challenge', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-phone-auth-missing-'));
  try {
    const auth = createPhoneLoopbackAuth({
      tokenFile: path.join(dir, 'missing.txt'),
    });
    assert.throws(
      () => auth.issueChallenge('ab'.repeat(32), 'test'),
      { code: 'unavailable' }
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

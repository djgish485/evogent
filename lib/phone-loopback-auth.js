const fs = require('node:fs');
const {
  createHmac,
  randomBytes,
  timingSafeEqual,
} = require('node:crypto');

const PROTOCOL_VERSION = 1;
const CHALLENGE_DOMAIN = 'evogent/phone-auth/server/v1';
const CLIENT_DOMAIN = 'evogent/phone-auth/client/v1';
const SESSION_DOMAIN = 'evogent/phone-auth/session/v1';
const DEFAULT_CHALLENGE_TTL_MS = 30_000;
const DEFAULT_WEB_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DIRECT_SESSION_TTL_MS = 30_000;
const MAX_CHALLENGES = 512;
const MAX_SESSIONS = 512;
const MAX_AUTH_ATTEMPTS_PER_MINUTE = 600;
const WEB_COOKIE_NAME = 'evogent_phone_session';

class PhoneAuthError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PhoneAuthError';
    this.code = code;
  }
}

function encodeField(value) {
  const bytes = Buffer.isBuffer(value)
    ? value
    : Buffer.from(String(value), 'utf8');
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(bytes.length, 0);
  return Buffer.concat([length, bytes]);
}

function canonicalTranscript(domain, fields) {
  return Buffer.concat([
    encodeField(domain),
    ...fields.map(encodeField),
  ]);
}

function hmacHex(key, domain, fields) {
  return createHmac('sha256', key)
    .update(canonicalTranscript(domain, fields))
    .digest('hex');
}

function safeEqualHex(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  if (!/^[a-f0-9]{64}$/.test(actual) || !/^[a-f0-9]{64}$/.test(expected)) return false;
  return timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}

function randomBase64Url(size, randomBytesFn) {
  return randomBytesFn(size).toString('base64url');
}

function randomHex(size, randomBytesFn) {
  return randomBytesFn(size).toString('hex');
}

function parseCookies(header) {
  if (typeof header !== 'string' || !header) return new Map();
  const cookies = new Map();
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name && !cookies.has(name)) cookies.set(name, value);
  }
  return cookies;
}

function pruneExpired(map, nowMs) {
  for (const [key, value] of map) {
    if (!value || value.expiresAtMs <= nowMs) map.delete(key);
  }
}

function trimMap(map, maxEntries) {
  while (map.size > maxEntries) {
    const oldest = map.keys().next();
    if (oldest.done) return;
    map.delete(oldest.value);
  }
}

function normalizeToken(contents) {
  if (typeof contents !== 'string') return '';
  const token = contents.trim();
  if (token.length < 24 || token.length > 512 || /[\r\n\0]/.test(token)) return '';
  return token;
}

function createPhoneLoopbackAuth(options = {}) {
  const tokenFile = options.tokenFile;
  if (typeof tokenFile !== 'string' || !tokenFile) {
    throw new TypeError('tokenFile is required');
  }

  const now = typeof options.now === 'function' ? options.now : Date.now;
  const randomBytesFn = typeof options.randomBytes === 'function' ? options.randomBytes : randomBytes;
  const challengeTtlMs = options.challengeTtlMs || DEFAULT_CHALLENGE_TTL_MS;
  const webSessionTtlMs = options.webSessionTtlMs || DEFAULT_WEB_SESSION_TTL_MS;
  const directSessionTtlMs = options.directSessionTtlMs || DEFAULT_DIRECT_SESSION_TTL_MS;
  const instanceId = randomHex(16, randomBytesFn);
  const challenges = new Map();
  const sessions = new Map();
  const rateWindows = new Map();
  let key = null;
  let normalizedToken = '';

  function loadKey({ force = false } = {}) {
    if (key && !force) return key;
    let nextToken = '';
    try {
      nextToken = normalizeToken(fs.readFileSync(tokenFile, 'utf8'));
    } catch {
      nextToken = '';
    }
    if (!nextToken) {
      key = null;
      normalizedToken = '';
      throw new PhoneAuthError('unavailable', 'Phone authentication is not provisioned');
    }
    if (normalizedToken && normalizedToken !== nextToken) {
      challenges.clear();
      sessions.clear();
    }
    normalizedToken = nextToken;
    key = Buffer.from(nextToken, 'utf8');
    return key;
  }

  function allowAttempt(remoteKey = 'loopback') {
    const timestamp = now();
    const windowStartMs = timestamp - (timestamp % 60_000);
    const previous = rateWindows.get(remoteKey);
    if (!previous || previous.windowStartMs !== windowStartMs) {
      rateWindows.set(remoteKey, { windowStartMs, count: 1 });
      trimMap(rateWindows, 32);
      return true;
    }
    previous.count += 1;
    return previous.count <= MAX_AUTH_ATTEMPTS_PER_MINUTE;
  }

  function issueChallenge(clientNonce, remoteKey) {
    if (!allowAttempt(remoteKey)) {
      throw new PhoneAuthError('rate_limited', 'Too many authentication attempts');
    }
    if (typeof clientNonce !== 'string' || !/^[a-f0-9]{64}$/.test(clientNonce)) {
      throw new PhoneAuthError('invalid_request', 'Invalid authentication request');
    }
    const activeKey = loadKey({ force: true });
    const timestamp = now();
    pruneExpired(challenges, timestamp);
    pruneExpired(sessions, timestamp);

    const challengeId = randomHex(16, randomBytesFn);
    const serverNonce = randomHex(32, randomBytesFn);
    const expiresAtMs = timestamp + challengeTtlMs;
    const fields = [
      String(PROTOCOL_VERSION),
      clientNonce,
      instanceId,
      challengeId,
      serverNonce,
      String(expiresAtMs),
    ];
    const serverProof = hmacHex(activeKey, CHALLENGE_DOMAIN, fields);
    challenges.set(challengeId, {
      clientNonce,
      serverNonce,
      expiresAtMs,
    });
    trimMap(challenges, MAX_CHALLENGES);

    return {
      version: PROTOCOL_VERSION,
      clientNonce,
      serverInstanceId: instanceId,
      challengeId,
      serverNonce,
      expiresAtMs,
      serverProof,
    };
  }

  function completeChallenge(request, remoteKey) {
    if (!allowAttempt(remoteKey)) {
      throw new PhoneAuthError('rate_limited', 'Too many authentication attempts');
    }
    const activeKey = loadKey({ force: true });
    const challengeId = request && request.challengeId;
    const challenge = typeof challengeId === 'string'
      ? challenges.get(challengeId)
      : null;
    if (challengeId) challenges.delete(challengeId);

    const timestamp = now();
    pruneExpired(challenges, timestamp);
    pruneExpired(sessions, timestamp);
    if (!challenge || challenge.expiresAtMs <= timestamp) {
      throw new PhoneAuthError('invalid_challenge', 'Authentication challenge is invalid');
    }

    const version = request.version;
    const clientNonce = request.clientNonce;
    const serverInstanceId = request.serverInstanceId;
    const serverNonce = request.serverNonce;
    const expiresAtMs = request.expiresAtMs;
    const sessionKind = request.sessionKind;
    const clientProof = request.clientProof;
    if (
      version !== PROTOCOL_VERSION ||
      clientNonce !== challenge.clientNonce ||
      serverInstanceId !== instanceId ||
      serverNonce !== challenge.serverNonce ||
      expiresAtMs !== challenge.expiresAtMs ||
      (sessionKind !== 'web' && sessionKind !== 'direct')
    ) {
      throw new PhoneAuthError('invalid_challenge', 'Authentication challenge is invalid');
    }

    const challengeFields = [
      String(PROTOCOL_VERSION),
      clientNonce,
      instanceId,
      challengeId,
      serverNonce,
      String(expiresAtMs),
    ];
    const expectedClientProof = hmacHex(
      activeKey,
      CLIENT_DOMAIN,
      [...challengeFields, sessionKind]
    );
    if (!safeEqualHex(clientProof, expectedClientProof)) {
      throw new PhoneAuthError('invalid_proof', 'Authentication proof is invalid');
    }

    const sessionToken = randomBase64Url(32, randomBytesFn);
    const sessionExpiresAtMs = timestamp + (
      sessionKind === 'web' ? webSessionTtlMs : directSessionTtlMs
    );
    sessions.set(sessionToken, {
      kind: sessionKind,
      expiresAtMs: sessionExpiresAtMs,
    });
    trimMap(sessions, MAX_SESSIONS);

    const sessionProof = hmacHex(activeKey, SESSION_DOMAIN, [
      ...challengeFields,
      sessionKind,
      sessionToken,
      String(sessionExpiresAtMs),
    ]);
    return {
      version: PROTOCOL_VERSION,
      sessionKind,
      sessionToken,
      sessionExpiresAtMs,
      sessionProof,
    };
  }

  function authorizeRequest(request, options = {}) {
    const timestamp = now();
    pruneExpired(sessions, timestamp);
    const allowDirect = options.allowDirect !== false;
    const allowWeb = options.allowWeb !== false;

    const authorization = request && request.headers
      ? request.headers.authorization
      : undefined;
    if (typeof authorization === 'string' && authorization.startsWith('EvogentSession ')) {
      const token = authorization.slice('EvogentSession '.length);
      const session = sessions.get(token);
      if (!allowDirect || !session || session.kind !== 'direct') return false;
      sessions.delete(token);
      return session.expiresAtMs > timestamp;
    }

    if (!allowWeb) return false;
    const rawCookie = request && request.headers
      ? request.headers.cookie
      : undefined;
    const cookieHeader = Array.isArray(rawCookie) ? rawCookie[0] : rawCookie;
    const token = parseCookies(cookieHeader).get(WEB_COOKIE_NAME);
    const session = token ? sessions.get(token) : null;
    return Boolean(session && session.kind === 'web' && session.expiresAtMs > timestamp);
  }

  function getWebCookie(session) {
    if (!session || session.sessionKind !== 'web') {
      throw new TypeError('A web session is required');
    }
    // Keep the browser cookie process-scoped. The server independently enforces the bounded
    // expiry, and every server restart drops the in-memory session regardless of cookie state.
    return `${WEB_COOKIE_NAME}=${session.sessionToken}; Secure; HttpOnly; SameSite=Strict; Path=/`;
  }

  function getStats() {
    const timestamp = now();
    pruneExpired(challenges, timestamp);
    pruneExpired(sessions, timestamp);
    return {
      challenges: challenges.size,
      sessions: sessions.size,
      instanceId,
    };
  }

  return {
    authorizeRequest,
    completeChallenge,
    getStats,
    getWebCookie,
    issueChallenge,
  };
}

module.exports = {
  CHALLENGE_DOMAIN,
  CLIENT_DOMAIN,
  PROTOCOL_VERSION,
  SESSION_DOMAIN,
  WEB_COOKIE_NAME,
  PhoneAuthError,
  canonicalTranscript,
  createPhoneLoopbackAuth,
  hmacHex,
};

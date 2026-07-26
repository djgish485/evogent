function getInternalRequestHeaders(headers = {}) {
  const secret = typeof process.env.EVOGENT_SERVER_LOOPBACK_SECRET === 'string'
    ? process.env.EVOGENT_SERVER_LOOPBACK_SECRET.trim()
    : '';
  return secret
    ? { ...headers, 'X-Evogent-Server-Secret': secret }
    : { ...headers };
}

function assertSafeInternalUrl(url) {
  const secret = typeof process.env.EVOGENT_SERVER_LOOPBACK_SECRET === 'string'
    ? process.env.EVOGENT_SERVER_LOOPBACK_SECRET.trim()
    : '';
  if (!secret) return;

  const parsed = new URL(url);
  const expectedPort = String(process.env.PORT || '3001');
  if (
    parsed.protocol !== 'http:'
    || parsed.hostname !== '127.0.0.1'
    || (parsed.port || '80') !== expectedPort
  ) {
    throw new Error('Refusing to send the server credential outside the exact loopback origin');
  }
}

async function fetchInternal(url, options = {}) {
  assertSafeInternalUrl(url);
  return fetch(url, {
    ...options,
    headers: getInternalRequestHeaders(options.headers),
  });
}

module.exports = {
  assertSafeInternalUrl,
  fetchInternal,
  getInternalRequestHeaders,
};

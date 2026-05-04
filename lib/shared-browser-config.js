const DEFAULT_SHARED_BROWSER_CDP_URL = 'http://127.0.0.1:9222';
const SHARED_BROWSER_CDP_ENV_KEYS = Object.freeze([
  'MEDIA_AGENT_SHARED_BROWSER_CDP_URL',
  'SHARED_BROWSER_CDP_URL',
]);

function compactString(value) {
  return typeof value === 'string' && value.trim()
    ? value.trim()
    : '';
}

function firstNonEmptyValue(values) {
  for (const value of values) {
    const compacted = compactString(value);
    if (compacted) {
      return compacted;
    }
  }

  return '';
}

function isLoopbackHostname(hostname) {
  const normalized = compactString(hostname).replace(/^\[(.*)\]$/, '$1').toLowerCase();
  return (
    normalized === 'localhost'
    || normalized === '127.0.0.1'
    || normalized === '::1'
    || normalized === '::ffff:127.0.0.1'
  );
}

function normalizeSharedBrowserLoopbackUrl(value) {
  const normalized = compactString(value);
  if (!normalized) {
    return '';
  }

  try {
    const url = new URL(normalized);
    if (!isLoopbackHostname(url.hostname)) {
      return normalized;
    }

    const authorityMatch = normalized.match(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i);
    if (!authorityMatch) {
      return normalized;
    }

    const userInfo = url.username
      ? `${url.username}${url.password ? `:${url.password}` : ''}@`
      : '';
    const port = url.port ? `:${url.port}` : '';
    const rewrittenAuthority = `${url.protocol}//${userInfo}127.0.0.1${port}`;

    return `${rewrittenAuthority}${normalized.slice(authorityMatch[0].length)}`;
  } catch {
    return normalized;
  }
}

function readSharedBrowserCdpUrlFromEnvironment(env = process.env) {
  return firstNonEmptyValue(
    SHARED_BROWSER_CDP_ENV_KEYS.map((key) => compactString(env?.[key])),
  );
}

function resolveSharedBrowserCdpUrl(options = {}) {
  return normalizeSharedBrowserLoopbackUrl(
    compactString(options.configuredUrl)
      || readSharedBrowserCdpUrlFromEnvironment(options.env)
      || DEFAULT_SHARED_BROWSER_CDP_URL,
  );
}

module.exports = {
  DEFAULT_SHARED_BROWSER_CDP_URL,
  SHARED_BROWSER_CDP_ENV_KEYS,
  compactString,
  firstNonEmptyValue,
  isLoopbackHostname,
  normalizeSharedBrowserLoopbackUrl,
  readSharedBrowserCdpUrlFromEnvironment,
  resolveSharedBrowserCdpUrl,
};

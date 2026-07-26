export function getInternalRequestHeaders(
  headers: Record<string, string> = {},
): Record<string, string> {
  const secret = process.env.EVOGENT_SERVER_LOOPBACK_SECRET?.trim();
  return secret
    ? { ...headers, 'X-Evogent-Server-Secret': secret }
    : { ...headers };
}

export function assertSafeInternalUrl(url: string | URL): void {
  const secret = process.env.EVOGENT_SERVER_LOOPBACK_SECRET?.trim();
  if (!secret) return;

  const parsed = new URL(url);
  const expectedPort = process.env.PORT || '3001';
  if (
    parsed.protocol !== 'http:'
    || parsed.hostname !== '127.0.0.1'
    || (parsed.port || '80') !== expectedPort
  ) {
    throw new Error('Refusing to send the server credential outside the exact loopback origin');
  }
}

export async function fetchInternal(
  url: string | URL,
  options: RequestInit = {},
): Promise<Response> {
  assertSafeInternalUrl(url);
  return fetch(url, {
    ...options,
    headers: getInternalRequestHeaders(
      (options.headers || {}) as Record<string, string>,
    ),
  });
}

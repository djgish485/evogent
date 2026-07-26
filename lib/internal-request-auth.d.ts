export function getInternalRequestHeaders(
  headers?: Record<string, string>
): Record<string, string>;

export function assertSafeInternalUrl(url: string | URL): void;

export function fetchInternal(
  url: string | URL,
  options?: RequestInit
): Promise<Response>;

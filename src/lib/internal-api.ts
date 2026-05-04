interface InternalBaseUrlOptions {
  env?: NodeJS.ProcessEnv;
  preferTestServer?: boolean;
}

function readEnvUrl(value: string | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function getInternalBaseUrl(options: InternalBaseUrlOptions = {}): string {
  const env = options.env ?? process.env;

  if (options.preferTestServer) {
    const testServerUrl = readEnvUrl(env.TEST_SERVER_URL);
    if (testServerUrl) {
      return testServerUrl;
    }
  }

  const evogentInternalBaseUrl = readEnvUrl(env.MEDIA_AGENT_INTERNAL_BASE_URL);
  if (evogentInternalBaseUrl) {
    return evogentInternalBaseUrl;
  }

  const orchestratorInternalUrl = readEnvUrl(env.ORCHESTRATOR_INTERNAL_URL);
  if (orchestratorInternalUrl) {
    return orchestratorInternalUrl;
  }

  const internalPort = env.PORT || '3001';
  return `http://127.0.0.1:${internalPort}`;
}

export function getInternalWebSocketBaseUrl(options: InternalBaseUrlOptions = {}): string {
  const env = options.env ?? process.env;
  const explicitWsUrl = options.preferTestServer ? readEnvUrl(env.TEST_SERVER_WS_URL) : null;
  if (explicitWsUrl) {
    return explicitWsUrl;
  }

  return getInternalBaseUrl(options).replace(/^http/i, 'ws');
}

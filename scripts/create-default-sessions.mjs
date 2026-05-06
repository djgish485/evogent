const codingAgentOnly = process.argv.includes('--coding-agent-only');
const port = Number.parseInt(process.env.PORT || '3001', 10);
const apiBase = `http://127.0.0.1:${Number.isFinite(port) ? port : 3001}`;

async function requestJson(path, init = {}) {
  let lastError;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
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

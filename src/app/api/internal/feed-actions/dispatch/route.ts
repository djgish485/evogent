import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function getInternalBaseUrl(): string {
  return process.env.ORCHESTRATOR_INTERNAL_URL
    || process.env.MEDIA_AGENT_INTERNAL_BASE_URL
    || `http://127.0.0.1:${process.env.PORT || '3001'}`;
}
function findSkillForNamespace(namespace: string): { name: string; skillPath: string } | null {
  const skillsDir = path.join(process.cwd(), '.claude', 'skills');
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillPath = path.join(skillsDir, entry.name, 'SKILL.md');
    try {
      const data = matter(fs.readFileSync(skillPath, 'utf8')).data as Record<string, unknown>;
      const metadata = isRecord(data.metadata) ? data.metadata : {};
      const mediaAgent = isRecord(metadata['media-agent']) ? metadata['media-agent'] : isRecord(metadata.evogent) ? metadata.evogent : {};
      const namespaces = mediaAgent['action-namespaces'];
      const claimed = Array.isArray(namespaces)
        ? namespaces.map((value) => typeof value === 'string' ? value.trim().toLowerCase() : '')
        : [];
      if (claimed.includes(namespace)) return { name: entry.name, skillPath };
    } catch {
      // Missing or malformed skills do not claim action namespaces.
    }
  }
  return null;
}
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON payload' }, { status: 400 });
  }

  const record = isRecord(body) ? body : {};
  const itemId = typeof record.itemId === 'string' ? record.itemId.trim() : '';
  const actionId = typeof record.actionId === 'string' ? record.actionId.trim().toLowerCase() : '';
  const actionPayload = isRecord(record.payload) ? record.payload : {};
  const namespace = actionId.split('.', 1)[0] || '';
  if (!itemId || !/^[a-z0-9_-]+\.[a-z0-9_.-]+$/.test(actionId)) {
    return NextResponse.json({ ok: false, error: 'itemId and dotted actionId are required' }, { status: 400 });
  }
  const skill = findSkillForNamespace(namespace);
  if (!skill) {
    return NextResponse.json({ ok: false, error: `No installed skill claims feed action namespace "${namespace}"` }, { status: 400 });
  }
  const baseUrl = getInternalBaseUrl();
  const message = [
    'A user clicked a freeform feed-card action. Route and interpret it only through the routed source skill.',
    `Action ID: ${actionId}`,
    `Feed item ID: ${itemId}`,
    `Payload JSON: ${JSON.stringify(actionPayload)}`,
    `Routed skill: ${skill.name}`,
    `Read ${skill.skillPath}, especially its "Feed action handlers" section, before acting.`,
    `After the action, PATCH ${baseUrl}/api/feed/${encodeURIComponent(itemId)} to update metadata.mcpAppHtml to a done or error state.`,
  ].join('\n');
  const response = await fetch(`${baseUrl}/api/orchestrator/enqueue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({ message, priority: 'feed_action', source: 'feed_action_dispatch', metadata: { requiresBrowserTools: true, feedAction: { actionId, itemId, payload: actionPayload, namespace, skillName: skill.name, skillPath: skill.skillPath } } }),
  });
  return NextResponse.json(await response.json().catch(() => ({})), { status: response.status });
}

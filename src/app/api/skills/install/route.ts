import { NextResponse } from 'next/server';
import { installSkill } from '@/lib/skills';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface InstallRequestBody {
  url?: string;
  registry?: string;
}

export async function POST(request: Request) {
  let payload: InstallRequestBody;

  try {
    payload = (await request.json()) as InstallRequestBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON payload' }, { status: 400 });
  }

  try {
    const result = await installSkill({
      url: payload.url,
      registry: payload.registry,
    });

    return NextResponse.json({
      ok: true,
      installed: result.skill,
      source: result.source,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to install skill';
    const status = message.toLowerCase().includes('unknown registry')
      || message.toLowerCase().includes('provide either')
      || message.toLowerCase().includes('provide only one')
      || message.toLowerCase().includes('frontmatter')
      ? 400
      : 500;

    return NextResponse.json({ error: message }, { status });
  }
}

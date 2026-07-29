import { NextResponse } from 'next/server';
import { activateSourceDiscoveryRun } from '@/lib/db/browse-cache';
import { assertSourceActivationAuthority } from '@/lib/source-activation-authority';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON payload' }, { status: 400 });
  }

  const body = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {};
  try {
    const activationInput = {
      source: typeof body.source === 'string' ? body.source : '',
      packageName: typeof body.package === 'string' ? body.package : '',
      runId: typeof body.runId === 'string' ? body.runId : '',
      recipeSha256: typeof body.recipeSha256 === 'string' ? body.recipeSha256 : '',
    };
    assertSourceActivationAuthority(activationInput);
    const activation = activateSourceDiscoveryRun(activationInput);
    return NextResponse.json({ ok: true, activation });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : 'Failed to activate source discovery',
    }, { status: 400 });
  }
}

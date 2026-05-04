import { NextResponse } from 'next/server';
import { listUserFacingCommands } from '@/lib/commands';
import { getDataPath } from '@/lib/data-dir';
import { readBrainConfig } from '../../../../lib/brain-config.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const brainConfig = readBrainConfig(getDataPath('config.md'));
    return NextResponse.json(await listUserFacingCommands({
      provider: brainConfig.provider,
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to read commands';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

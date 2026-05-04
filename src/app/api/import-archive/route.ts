import fs from 'node:fs';
import { NextResponse } from 'next/server';
import { importTwitterArchive } from '@/lib/import-archive';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const archivePath = typeof (body as { archivePath?: unknown }).archivePath === 'string'
    ? (body as { archivePath: string }).archivePath.trim()
    : '';

  if (!archivePath) {
    return NextResponse.json({ error: 'archivePath is required' }, { status: 400 });
  }

  if (!fs.existsSync(archivePath)) {
    return NextResponse.json({ error: 'Archive path does not exist' }, { status: 400 });
  }

  try {
    const result = await importTwitterArchive(archivePath);
    return NextResponse.json({ success: true, stats: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Archive import failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

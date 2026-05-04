import { NextResponse } from 'next/server';
import { matchPreferenceText } from '@/lib/preferences-match';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const text = typeof (payload as { text?: unknown }).text === 'string'
    ? (payload as { text: string }).text.trim()
    : '';
  if (!text) {
    return NextResponse.json({ error: 'text must be a non-empty string' }, { status: 400 });
  }

  return NextResponse.json(await matchPreferenceText(text));
}

import { NextResponse } from 'next/server';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Serves on-device-captured media (e.g. cropped Instagram post images written by the a11y
// `shotnode` op) to the WebView. The WebView runs as a different app uid and cannot read the
// device filesystem directly, but it CAN fetch same-origin from this server, which does have
// the files under data/media/. This is the general local-media capability: any on-device
// capture drops a file under data/media/<...> and references it as /api/local-media/<...>.
const MEDIA_ROOT = path.join(process.cwd(), 'data', 'media');

const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

export async function GET(_request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const { path: segments } = await params;
  // Resolve within MEDIA_ROOT and confirm the result stays inside it — blocks ../ traversal.
  const target = path.resolve(MEDIA_ROOT, ...segments);
  if (target !== MEDIA_ROOT && !target.startsWith(MEDIA_ROOT + path.sep)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const ext = path.extname(target).toLowerCase();
  const contentType = CONTENT_TYPES[ext];
  if (!contentType) {
    return NextResponse.json({ error: 'unsupported media type' }, { status: 415 });
  }
  try {
    const bytes = await readFile(target);
    return new NextResponse(new Uint8Array(bytes), {
      status: 200,
      headers: {
        'content-type': contentType,
        // Captures are immutable once written (id is content-derived); cache aggressively.
        'cache-control': 'public, max-age=31536000, immutable',
      },
    });
  } catch {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
}

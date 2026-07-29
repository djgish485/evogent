import { NextResponse } from 'next/server';
import { insertPreference } from '@/lib/db/preferences';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Explicit taste capture from the Android assistant surface's Like / Bookmark buttons. The user
 * invokes Add Message while viewing another app and deliberately shares bounded, filtered
 * AssistStructure text. This turns one tap into a durable signal in the SAME `preferences` table
 * the curator reads and migrations can fill.
 *
 * - like     -> signal_type 'liked'  (weight 1.5, same as an imported bookmark-like)
 * - bookmark -> signal_type 'liked'  PLUS reason "bookmark" (a stronger save-for-the-feed intent)
 *
 * This path accepts text only. The assistant privacy contract does not capture screenshots.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

// Historical callers may supply accessibility-tree-shaped text with lines like
// `LinearLayout desc="Example Author @example_author Verified. <post text>. 2h. 12 likes" [clickable]`.
// Normalize that legacy shape defensively while treating current AssistStructure text as already
// clean. The stored taste signal should describe the content, not surrounding UI chrome.
const CHROME = /^(show navigation|navigate up|home|search|notifications|messages|for you|following|post|reply|repost|like|bookmark|share|profile|more|back|settings|upgrade|watch again|show more|show original|translated from)/i;

function extractContent(dump: string): string {
  // If it doesn't look like an a11y dump, it's already clean text — return as-is.
  if (!/\b(?:text|desc)="/.test(dump)) return dump.replace(/\s+/g, ' ').trim();
  const values: string[] = [];
  const rx = /\b(?:text|desc)="([^"]{4,})"/g;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(dump)) !== null) {
    const v = m[1].replace(/\s+/g, ' ').trim();
    if (v.length >= 18 && !CHROME.test(v)) values.push(v);
  }
  if (!values.length) return dump.replace(/\s+/g, ' ').trim().slice(0, 200);
  // The longest substantive value is almost always the post body (or a tweet's full desc).
  values.sort((a, b) => b.length - a.length);
  return values.slice(0, 3).join(' — ');
}

// Author "@handle" from the extracted content, or from a "Quoted."/name-@handle shape.
function guessAuthor(text: string): string | undefined {
  const at = text.match(/@([A-Za-z0-9_.]{2,30})/);
  return at?.[1];
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }
  if (!isRecord(body)) {
    return NextResponse.json({ error: 'body must be an object' }, { status: 400 });
  }

  const kind = str(body.kind).toLowerCase();
  if (kind !== 'like' && kind !== 'bookmark') {
    return NextResponse.json({ error: "kind must be 'like' or 'bookmark'" }, { status: 400 });
  }
  const app = str(body.app) || 'phone';
  const text = str(body.text);
  const sourceUrl = str(body.sourceUrl);
  if (text.length < 3 && !sourceUrl) {
    return NextResponse.json({ error: 'nothing to capture: empty screen text and no url' }, { status: 400 });
  }

  // Map the foreground app package to a readable source label.
  const sourceLabel = app.includes('twitter') || app.includes('.x.')
    ? 'twitter_overlay_like'
    : app.includes('instagram')
      ? 'instagram_overlay_like'
      : `overlay_like:${app}`;

  const content = extractContent(text);
  const author = guessAuthor(content);
  const captured = content.length > 600 ? `${content.slice(0, 600)}…` : content;

  try {
    insertPreference({
      signalType: 'liked',
      source: sourceLabel,
      text: captured || sourceUrl,
      reason: kind === 'bookmark' ? 'bookmark (overlay save)' : 'like (overlay)',
      authorUsername: author,
      weight: kind === 'bookmark' ? 2.0 : 1.5,
      // Dedupe on identical text within the source so a double-tap is idempotent.
      sourceId: `overlay-${kind}-${app}-${Buffer.from(captured || sourceUrl).toString('base64').slice(0, 40)}`,
    });
  } catch (error) {
    return NextResponse.json({ error: `failed to record: ${(error as Error).message}` }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    kind,
    source: sourceLabel,
    author: author ?? null,
    message: kind === 'bookmark' ? 'Bookmarked — saved to your taste' : 'Liked — more like this',
  });
}

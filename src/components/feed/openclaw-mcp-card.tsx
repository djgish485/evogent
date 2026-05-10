'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

export interface MCPAppActionEvent {
  actionId: string;
  source: 'mcpapp';
  payload?: Record<string, unknown>;
}

const mcpAppMessageTypes = new Set(['height', 'action']);

const frameBridgeScript = `
(function () {
  function post(message) {
    parent.postMessage(Object.assign({ channel: 'evogent:mcpapp' }, message), '*');
  }
  function measureHeight() {
    var body = document.body;
    var html = document.documentElement;
    return Math.max(
      body ? body.scrollHeight : 0,
      body ? body.offsetHeight : 0,
      html ? html.scrollHeight : 0,
      html ? html.offsetHeight : 0
    );
  }
  function postHeight() {
    post({ type: 'height', height: measureHeight() });
  }
  window.evogentAction = function (actionId, payload) {
    if (typeof actionId === 'string' && actionId.trim()) {
      post({ type: 'action', actionId: actionId, payload: payload && typeof payload === 'object' ? payload : {} });
    }
  };
  document.addEventListener('click', function (event) {
    var target = event.target && event.target.closest ? event.target.closest('[data-evogent-action],[data-action-id]') : null;
    if (!target) return;
    var actionId = target.getAttribute('data-evogent-action') || target.getAttribute('data-action-id');
    if (!actionId) return;
    event.preventDefault();
    post({ type: 'action', actionId: actionId, payload: { text: target.textContent || '' } });
  });
  window.addEventListener('load', postHeight);
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(postHeight).observe(document.documentElement);
  }
  setTimeout(postHeight, 0);
  setTimeout(postHeight, 250);
})();
`;

function scriptTag(): string {
  return `<script>${frameBridgeScript.replace(/<\/script/gi, '<\\/script')}</script>`;
}

function buildSrcDoc(html: string): string {
  const bridge = scriptTag();
  if (/<html[\s>]/i.test(html)) {
    if (/<\/body>/i.test(html)) {
      return html.replace(/<\/body>/i, `${bridge}</body>`);
    }
    return `${html}${bridge}`;
  }

  return [
    '<!doctype html>',
    '<html>',
    '<head>',
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    '<base target="_blank" />',
    '<style>',
    'html{color-scheme:dark light;}',
    'body{margin:0;background:transparent;color:inherit;font:14px/1.5 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;}',
    '*{box-sizing:border-box;max-width:100%;}',
    'a{color:inherit;}',
    'button,[role="button"]{font:inherit;}',
    '</style>',
    '</head>',
    '<body>',
    html,
    bridge,
    '</body>',
    '</html>',
  ].join('');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function MCPAppFrame({
  html,
  onAction,
}: {
  html: string;
  onAction?: (event: MCPAppActionEvent) => void | Promise<void>;
}) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [height, setHeight] = useState(180);
  const srcDoc = useMemo(() => buildSrcDoc(html), [html]);

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      if (!iframeRef.current || event.source !== iframeRef.current.contentWindow) {
        return;
      }

      if (!isRecord(event.data) || event.data.channel !== 'evogent:mcpapp') {
        return;
      }

      const type = typeof event.data.type === 'string' ? event.data.type : '';
      if (!mcpAppMessageTypes.has(type)) {
        return;
      }

      if (type === 'height') {
        const nextHeight = typeof event.data.height === 'number' && Number.isFinite(event.data.height)
          ? Math.ceil(event.data.height)
          : null;
        if (nextHeight !== null) {
          setHeight(Math.min(2400, Math.max(120, nextHeight)));
        }
        return;
      }

      const actionId = typeof event.data.actionId === 'string' ? event.data.actionId.trim() : '';
      if (!actionId) {
        return;
      }

      void onAction?.({
        actionId,
        source: 'mcpapp',
        payload: isRecord(event.data.payload) ? event.data.payload : undefined,
      });
    }

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [onAction]);

  return (
    <div data-testid="mcp-app-frame" className="overflow-hidden rounded-lg border border-zinc-300 bg-white/70 dark:border-zinc-800 dark:bg-zinc-950/50">
      <div className="border-b border-zinc-200 px-3 py-1.5 text-[11px] font-medium uppercase tracking-[0.14em] text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
        sandboxed agent UI
      </div>
      <iframe
        ref={iframeRef}
        title="Sandboxed agent UI"
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        srcDoc={srcDoc}
        style={{ height }}
        className="block w-full border-0 bg-transparent"
      />
    </div>
  );
}

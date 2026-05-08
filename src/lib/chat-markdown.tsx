import { normalizeAgentChatText } from '@/lib/chat-text';
import { splitSearchHighlightParts } from '@/lib/search-utils';
import { Fragment, type ReactNode } from 'react';

export function renderHighlightedSearchText(text: string, searchQuery: string | null): ReactNode {
  if (!searchQuery) {
    return text;
  }

  const parts = splitSearchHighlightParts(text, searchQuery);
  if (parts.length === 0 || !parts.some((part) => part.isMatch)) {
    return text;
  }

  return (
    <>
      {parts.map((part, index) => part.isMatch ? (
        <span
          key={`${index}-${part.text}`}
          data-search-highlight="true"
          className="search-match rounded bg-amber-400/20 px-0.5 text-amber-100"
        >
          {part.text}
        </span>
      ) : (
        <span key={`${index}-${part.text}`}>{part.text}</span>
      ))}
    </>
  );
}

export function resolveSafeExternalUrl(raw: string): string | null {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.toString();
    }
    return null;
  } catch {
    return null;
  }
}

export function renderInlineChatMarkdown(text: string, keyPrefix: string, searchQuery: string | null = null): ReactNode[] {
  const tokenPattern = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<]+)/g;
  const emphasisPattern = /(\*\*[^*\n]+\*\*|\*[^*\n]+\*)/g;
  const nodes: ReactNode[] = [];
  let lastIndex = 0;

  const pushEmphasisNodes = (segment: string, segmentKeyPrefix: string) => {
    let emphasisLastIndex = 0;
    let emphasisMatch: RegExpExecArray | null;
    emphasisPattern.lastIndex = 0;

    while ((emphasisMatch = emphasisPattern.exec(segment)) !== null) {
      const start = emphasisMatch.index;
      if (start > emphasisLastIndex) {
        nodes.push(renderHighlightedSearchText(segment.slice(emphasisLastIndex, start), searchQuery));
      }

      const token = emphasisMatch[0];
      if (token.startsWith('**') && token.endsWith('**')) {
        nodes.push(
          <strong key={`${segmentKeyPrefix}-strong-${start}`}>
            {renderHighlightedSearchText(token.slice(2, -2), searchQuery)}
          </strong>,
        );
      } else if (token.startsWith('*') && token.endsWith('*')) {
        nodes.push(
          <em key={`${segmentKeyPrefix}-em-${start}`}>
            {renderHighlightedSearchText(token.slice(1, -1), searchQuery)}
          </em>,
        );
      } else {
        nodes.push(renderHighlightedSearchText(token, searchQuery));
      }

      emphasisLastIndex = start + token.length;
    }

    if (emphasisLastIndex < segment.length) {
      nodes.push(renderHighlightedSearchText(segment.slice(emphasisLastIndex), searchQuery));
    }
  };

  let match: RegExpExecArray | null;
  while ((match = tokenPattern.exec(text)) !== null) {
    const start = match.index;
    if (start > lastIndex) {
      pushEmphasisNodes(text.slice(lastIndex, start), `${keyPrefix}-plain-${start}`);
    }

    const markdownLinkText = match[1];
    const markdownLinkUrl = match[2];
    const bareUrl = match[3];
    const url = markdownLinkUrl || bareUrl;
    const safeUrl = url ? resolveSafeExternalUrl(url) : null;
    if (safeUrl) {
      const linkLabel = markdownLinkText || safeUrl.replace(/^https?:\/\//, '');
      nodes.push(
        <a
          key={`${keyPrefix}-link-${start}`}
          href={safeUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="text-sky-400 hover:underline break-all"
        >
          {renderHighlightedSearchText(linkLabel, searchQuery)}
        </a>,
      );
    } else {
      pushEmphasisNodes(match[0], `${keyPrefix}-invalid-link-${start}`);
    }

    lastIndex = start + match[0].length;
  }

  if (lastIndex < text.length) {
    pushEmphasisNodes(text.slice(lastIndex), `${keyPrefix}-tail`);
  }

  return nodes;
}

export function renderChatMarkdown(text: string, searchQuery: string | null = null): ReactNode {
  const lines = normalizeAgentChatText(text).split('\n');
  const isMarkdownTableContentLine = (line: string) => line.includes('|')
    && !/^(#{1,4})\s+/.test(line)
    && !/^\s*[-*]\s+/.test(line);
  const isMarkdownTableSeparator = (line: string) => /[|│┼┤├]/u.test(line) && /^[\s|│┼┤├─\-:]+$/u.test(line);
  const isMarkdownTableFenceStart = (line: string) => /^```[\w-]*\s*$/.test(line);
  const isMarkdownTableFenceEnd = (line: string) => /^```\s*$/.test(line);
  const parseMarkdownTableRow = (line: string) => {
    const trimmedLine = line.trim();
    const withoutLeadingPipe = trimmedLine.startsWith('|') ? trimmedLine.slice(1) : trimmedLine;
    const withoutEdgePipes = withoutLeadingPipe.endsWith('|') ? withoutLeadingPipe.slice(0, -1) : withoutLeadingPipe;
    return withoutEdgePipes.split('|').map((cell) => cell.trim());
  };
  const blocks: Array<
    | { type: 'line'; line: string; lineIndex: number }
    | { type: 'table'; tableLines: string[]; startLineIndex: number }
  > = [];

  for (let lineIndex = 0; lineIndex < lines.length;) {
    const currentLine = lines[lineIndex];
    const nextLine = lines[lineIndex + 1];
    const startsMarkdownTable = isMarkdownTableContentLine(currentLine)
      && typeof nextLine === 'string'
      && isMarkdownTableSeparator(nextLine);

    if (!startsMarkdownTable) {
      blocks.push({ type: 'line', line: lines[lineIndex], lineIndex });
      lineIndex += 1;
      continue;
    }

    const tableLines = [currentLine, nextLine];
    const startLineIndex = lineIndex;
    lineIndex += 2;
    while (lineIndex < lines.length && isMarkdownTableContentLine(lines[lineIndex])) {
      tableLines.push(lines[lineIndex]);
      lineIndex += 1;
    }
    blocks.push({ type: 'table', tableLines, startLineIndex });
  }

  const hiddenFenceLineIndexes = new Set<number>();
  for (const block of blocks) {
    if (block.type !== 'table') {
      continue;
    }

    const previousLineIndex = block.startLineIndex - 1;
    const nextLineIndex = block.startLineIndex + block.tableLines.length;
    if (isMarkdownTableFenceStart(lines[previousLineIndex] ?? '') && isMarkdownTableFenceEnd(lines[nextLineIndex] ?? '')) {
      hiddenFenceLineIndexes.add(previousLineIndex);
      hiddenFenceLineIndexes.add(nextLineIndex);
    }
  }

  return (
    <>
      {blocks.filter((block) => block.type === 'table' || !hiddenFenceLineIndexes.has(block.lineIndex)).map((block) => {
        if (block.type === 'table') {
          const headerCells = parseMarkdownTableRow(block.tableLines[0]);
          const bodyRows = block.tableLines
            .slice(2)
            .map(parseMarkdownTableRow);
          const columnCount = Math.max(
            headerCells.length,
            ...bodyRows.map((row) => row.length),
          );
          const normalizedHeaderCells = Array.from(
            { length: columnCount },
            (_, columnIndex) => headerCells[columnIndex] ?? '',
          );
          const normalizedBodyRows = bodyRows.map((row) => Array.from(
            { length: columnCount },
            (_, columnIndex) => row[columnIndex] ?? '',
          ));

          return (
            <div key={`chat-table-${block.startLineIndex}`} className="max-w-full overflow-x-auto">
              <table className="min-w-full border-collapse">
                <thead>
                  <tr>
                    {normalizedHeaderCells.map((cell, cellIndex) => (
                      <th
                        key={`chat-table-${block.startLineIndex}-header-${cellIndex}`}
                        className="border border-zinc-700 px-2 py-1 text-left text-sm whitespace-nowrap"
                      >
                        {renderInlineChatMarkdown(cell, `chat-table-${block.startLineIndex}-header-${cellIndex}`, searchQuery)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {normalizedBodyRows.map((row, rowIndex) => (
                    <tr key={`chat-table-${block.startLineIndex}-row-${rowIndex}`}>
                      {row.map((cell, cellIndex) => (
                        <td
                          key={`chat-table-${block.startLineIndex}-row-${rowIndex}-cell-${cellIndex}`}
                          className="border border-zinc-700 px-2 py-1 text-sm"
                        >
                          {renderInlineChatMarkdown(cell, `chat-table-${block.startLineIndex}-row-${rowIndex}-cell-${cellIndex}`, searchQuery)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }

        const headingMatch = block.line.match(/^(#{1,4})\s+(.+)$/);
        const bulletMatch = !headingMatch && block.line.match(/^\s*[-*]\s+(.+)$/);
        const normalizedLine = headingMatch ? headingMatch[2] : bulletMatch ? bulletMatch[1] : block.line;
        return (
          <Fragment key={`chat-line-${block.lineIndex}`}>
            {headingMatch ? (
              <span className={`block font-semibold ${headingMatch[1].length <= 2 ? 'mt-3 mb-1 text-[15px]' : 'mt-2 mb-0.5 text-[13px]'} text-zinc-50`}>
                {renderInlineChatMarkdown(normalizedLine, `chat-line-${block.lineIndex}`, searchQuery)}
              </span>
            ) : bulletMatch ? (
              <span className="block pl-3">• {renderInlineChatMarkdown(normalizedLine, `chat-line-${block.lineIndex}`, searchQuery)}</span>
            ) : (
              renderInlineChatMarkdown(normalizedLine, `chat-line-${block.lineIndex}`, searchQuery)
            )}
            {block.lineIndex < lines.length - 1 && !headingMatch && <br />}
          </Fragment>
        );
      })}
    </>
  );
}

// Verification protocol test
export interface ApplyInput {
  diff?: string | null;
  proposedValue?: string | null;
  sectionName?: string | null;
}

export type ApplyMethod = 'diff' | 'section-replace' | 'section-append' | 'none';

export interface ApplyResult {
  content: string;
  changed: boolean;
  method: ApplyMethod;
}

interface ReplaceSectionResult {
  content: string;
  changed: boolean;
  appended: boolean;
}

interface UnifiedDiffHunk {
  oldStart: number | null;
  oldCount: number | null;
  lines: string[];
}

export function applySuggestionProgrammatic(content: string, input: ApplyInput): ApplyResult {
  const normalizedContent = content.replace(/\r\n/g, '\n');
  const diff = typeof input.diff === 'string' ? input.diff : '';
  const proposedValue = typeof input.proposedValue === 'string' ? input.proposedValue : '';
  const sectionName = typeof input.sectionName === 'string' ? input.sectionName : '';

  if (diff.trim()) {
    const result = applyUnifiedDiff(normalizedContent, diff);
    if (result.changed) {
      return { ...result, method: 'diff' };
    }
  }

  if (sectionName.trim() && proposedValue.trim()) {
    const result = replaceSectionContent(normalizedContent, sectionName, proposedValue);
    if (result.changed) {
      return {
        content: result.content,
        changed: true,
        method: result.appended ? 'section-append' : 'section-replace',
      };
    }
  }

  if (proposedValue.trim()) {
    const headerMatch = proposedValue.match(/^##\s+(.+)/m);
    if (headerMatch?.[1]) {
      const result = replaceSectionContent(normalizedContent, headerMatch[1].trim(), proposedValue);
      if (result.changed) {
        return {
          content: result.content,
          changed: true,
          method: result.appended ? 'section-append' : 'section-replace',
        };
      }
    }
  }

  return { content: normalizedContent, changed: false, method: 'none' };
}

function parseUnifiedDiffHunks(diff: string): UnifiedDiffHunk[] {
  const hunks: UnifiedDiffHunk[] = [];
  let currentHunk: UnifiedDiffHunk | null = null;

  for (const line of diff.replace(/\r\n/g, '\n').split('\n')) {
    if (line.startsWith('---') || line.startsWith('+++')) {
      continue;
    }

    const headerMatch = line.match(/^@@\s*-(\d+)(?:,(\d+))?\s+\+\d+(?:,(\d+))?\s*@@(?:.*)?$/);
    if (headerMatch) {
      currentHunk = {
        oldStart: Number(headerMatch[1]),
        oldCount: headerMatch[2] ? Number(headerMatch[2]) : 1,
        lines: [],
      };
      hunks.push(currentHunk);
      continue;
    }

    if (line.startsWith('@@')) {
      currentHunk = {
        oldStart: null,
        oldCount: null,
        lines: [],
      };
      hunks.push(currentHunk);
      continue;
    }

    if (currentHunk) {
      currentHunk.lines.push(line);
    }
  }

  return hunks;
}

function buildHunkSequences(lines: string[]): { oldLines: string[]; newLines: string[]; hasContextLine: boolean } {
  const oldLines: string[] = [];
  const newLines: string[] = [];
  let hasContextLine = false;

  for (const line of lines) {
    if (line.startsWith('\\')) {
      continue;
    }

    if (line.startsWith('+')) {
      newLines.push(line.slice(1));
      continue;
    }

    if (line.startsWith(' ')) {
      hasContextLine = true;
      const text = line.slice(1);
      oldLines.push(text);
      newLines.push(text);
      continue;
    }

    if (line.startsWith('-')) {
      oldLines.push(line.slice(1));
    }
  }

  return { oldLines, newLines, hasContextLine };
}

function findContiguousSequence(lines: string[], sequence: string[]): number {
  if (sequence.length === 0) {
    return 0;
  }

  for (let start = 0; start <= lines.length - sequence.length; start += 1) {
    let matches = true;
    for (let offset = 0; offset < sequence.length; offset += 1) {
      if (lines[start + offset] !== sequence[offset]) {
        matches = false;
        break;
      }
    }

    if (matches) {
      return start;
    }
  }

  return -1;
}

export function applyUnifiedDiff(content: string, diff: string): { content: string; changed: boolean } {
  const normalizedContent = content.replace(/\r\n/g, '\n');
  const hunks = parseUnifiedDiffHunks(diff);
  if (hunks.length === 0) {
    return { content, changed: false };
  }

  let contentLines = normalizedContent.split('\n');
  let lineOffset = 0;
  let changed = false;

  for (const hunk of hunks) {
    const { oldLines, newLines, hasContextLine } = buildHunkSequences(hunk.lines);
    if (oldLines.length === 0 && newLines.length === 0) {
      continue;
    }

    const windowStart = hunk.oldStart === null
      ? 0
      : Math.max(0, Math.min(contentLines.length, hunk.oldStart - 1 + lineOffset));
    const windowCount = hunk.oldStart === null
      ? contentLines.length
      : Math.max(hunk.oldCount ?? oldLines.length, 0);
    const windowEnd = hunk.oldStart === null
      ? contentLines.length
      : Math.max(windowStart, Math.min(contentLines.length, windowStart + windowCount));
    const windowLines = contentLines.slice(windowStart, windowEnd);

    let replacementLines: string[];

    if (oldLines.length === 0) {
      replacementLines = newLines;
    } else {
      const matchStart = findContiguousSequence(windowLines, oldLines);

      if (matchStart >= 0) {
        replacementLines = [
          ...windowLines.slice(0, matchStart),
          ...newLines,
          ...windowLines.slice(matchStart + oldLines.length),
        ];
      } else if (hunk.oldStart !== null && !hasContextLine) {
        replacementLines = newLines;
      } else {
        return { content, changed: false };
      }
    }

    const nextLines = [
      ...contentLines.slice(0, windowStart),
      ...replacementLines,
      ...contentLines.slice(windowEnd),
    ];

    if (!changed) {
      changed = nextLines.join('\n') !== contentLines.join('\n');
    }

    lineOffset += replacementLines.length - windowLines.length;
    contentLines = nextLines;
  }

  const updatedContent = contentLines.join('\n');
  return {
    content: updatedContent,
    changed: changed && updatedContent !== normalizedContent,
  };
}

export function replaceSectionContent(content: string, sectionName: string, proposedValue: string): ReplaceSectionResult {
  const normalizedContent = content.replace(/\r\n/g, '\n');
  const lines = normalizedContent.split('\n');
  const escaped = sectionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^##\\s+${escaped}\\s*$`, 'i');
  const sectionStart = lines.findIndex((line) => pattern.test(line.trim()));

  if (sectionStart < 0) {
    let cleanValue = proposedValue.trim();
    const firstLine = cleanValue.split('\n')[0]?.trim() ?? '';
    if (!/^##\s+/.test(firstLine)) {
      cleanValue = `## ${sectionName}\n\n${cleanValue}`;
    }
    const separator = normalizedContent.endsWith('\n') ? '\n' : '\n\n';
    const appendedContent = `${normalizedContent}${separator}${cleanValue}\n`;
    return {
      content: appendedContent,
      changed: appendedContent !== normalizedContent,
      appended: true,
    };
  }

  let sectionEnd = lines.length;
  for (let index = sectionStart + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index].trim())) {
      sectionEnd = index;
      break;
    }
  }

  let cleanValue = proposedValue.trim();
  const valueLines = cleanValue.split('\n');
  if (!pattern.test(valueLines[0]?.trim() ?? '')) {
    cleanValue = `${lines[sectionStart]}\n\n${cleanValue}`;
  }

  const replacementLines = cleanValue.split('\n');
  const newLines = [
    ...lines.slice(0, sectionStart),
    ...replacementLines,
    ...lines.slice(sectionEnd),
  ];
  const nextContent = newLines.join('\n');

  return {
    content: nextContent,
    changed: nextContent !== normalizedContent,
    appended: false,
  };
}

function hasOwn(target, key) {
  return Boolean(target && Object.prototype.hasOwnProperty.call(target, key));
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function decodeJsonStringFragment(fragment) {
  if (typeof fragment !== 'string' || !fragment) return '';

  let candidate = fragment;
  while (candidate.length > 0) {
    try {
      return JSON.parse(`"${candidate}"`);
    } catch {
      candidate = candidate.slice(0, -1);
    }
  }

  return '';
}

function extractPartialJsonStringField(serialized, fieldNames) {
  if (typeof serialized !== 'string' || !serialized) {
    return null;
  }

  for (const fieldName of fieldNames) {
    const pattern = new RegExp(`"${fieldName}"\\s*:\\s*"([^"]*)`, 'i');
    const match = serialized.match(pattern);
    if (!match?.[1]) {
      continue;
    }

    const decoded = decodeJsonStringFragment(match[1]);
    if (decoded) {
      return decoded;
    }

    return match[1];
  }

  return null;
}

function normalizeToolName(toolName) {
  return typeof toolName === 'string' ? toolName.trim() : '';
}

function normalizeStringTarget(candidate) {
  if (typeof candidate !== 'string') return null;
  const trimmed = candidate.trim().replace(/^['"]+|['"]+$/g, '');
  return trimmed || null;
}

function normalizeInlineTarget(candidate) {
  const normalized = normalizeStringTarget(candidate);
  return normalized ? normalized.replace(/\s+/g, ' ') : null;
}

function getFilenameFromPath(candidate) {
  const trimmed = normalizeStringTarget(candidate);
  if (!trimmed) return null;

  const normalized = trimmed.replace(/[\\/]+$/, '');
  const segments = normalized.split(/[\\/]/);
  const base = segments[segments.length - 1] || '';
  return base || normalized || null;
}

function findStringInInput(input, fieldNames, normalize = normalizeStringTarget, depth = 5) {
  if (depth < 0 || input === null || input === undefined) {
    return null;
  }

  if (typeof input === 'string') {
    return normalize(input);
  }

  if (Array.isArray(input)) {
    for (const entry of input) {
      const nested = findStringInInput(entry, fieldNames, normalize, depth - 1);
      if (nested) return nested;
    }
    return null;
  }

  if (!isRecord(input)) {
    return null;
  }

  for (const key of fieldNames) {
    if (!hasOwn(input, key)) continue;
    const value = normalize(input[key]);
    if (value) return value;
  }

  for (const value of Object.values(input)) {
    const nested = findStringInInput(value, fieldNames, normalize, depth - 1);
    if (nested) return nested;
  }

  return null;
}

function findStringFromPartialJson(partialInputJson, fieldNames, normalize = normalizeStringTarget) {
  const value = extractPartialJsonStringField(partialInputJson, fieldNames);
  return normalize(value);
}

function findFileTargetInInput(input) {
  return findStringInInput(input, [
    'file_path',
    'filePath',
    'path',
    'filename',
    'file_name',
  ]);
}

function findFileTargetFromPartialJson(partialInputJson) {
  return findStringFromPartialJson(partialInputJson, [
    'file_path',
    'filePath',
    'path',
    'filename',
    'file_name',
  ]);
}

function findUrlTargetInInput(input) {
  return findStringInInput(input, ['url', 'uri', 'href']);
}

function findUrlTargetFromPartialJson(partialInputJson) {
  return findStringFromPartialJson(partialInputJson, ['url', 'uri', 'href']);
}

function findCommandTargetInInput(input) {
  return findStringInInput(input, ['command', 'cmd', 'command_string', 'commandLine', 'script'], normalizeInlineTarget);
}

function findCommandTargetFromPartialJson(partialInputJson) {
  return findStringFromPartialJson(
    partialInputJson,
    ['command', 'cmd', 'command_string', 'commandLine', 'script'],
    normalizeInlineTarget,
  );
}

function buildToolProgress(activity, tool, target = null) {
  return target
    ? { activity, tool, target }
    : { activity, tool };
}

function resolveToolProgress(toolName, {
  input = null,
  partialInputJson = '',
} = {}) {
  const normalizedToolName = normalizeToolName(toolName);
  if (!normalizedToolName) {
    return null;
  }

  switch (normalizedToolName.toLowerCase()) {
    case 'websearch':
      return { activity: 'Searching the web...', tool: normalizedToolName };
    case 'webfetch': {
      const target = findUrlTargetInInput(input) || findUrlTargetFromPartialJson(partialInputJson);
      return buildToolProgress('Reading a webpage...', normalizedToolName, target);
    }
    case 'read': {
      const target = findFileTargetInInput(input) || findFileTargetFromPartialJson(partialInputJson);
      const filename = getFilenameFromPath(target);
      return buildToolProgress(
        filename ? `Reading ${filename}...` : 'Reading a file...',
        normalizedToolName,
        target,
      );
    }
    case 'bash': {
      const target = findCommandTargetInInput(input) || findCommandTargetFromPartialJson(partialInputJson);
      return buildToolProgress('Running a command...', normalizedToolName, target);
    }
    case 'grep':
    case 'glob':
      return { activity: 'Searching files...', tool: normalizedToolName };
    case 'write':
    case 'edit': {
      const target = findFileTargetInInput(input) || findFileTargetFromPartialJson(partialInputJson);
      const filename = getFilenameFromPath(target);
      return buildToolProgress(
        filename ? `Writing ${filename}...` : 'Writing a file...',
        normalizedToolName,
        target,
      );
    }
    default:
      return { activity: 'Working...', tool: normalizedToolName };
  }
}

function extractChatProgressFromEvent(rawEvent, toolUseBlocks) {
  if (!isRecord(rawEvent)) return null;

  if (rawEvent.type === 'stream_event') {
    const streamEvent = isRecord(rawEvent.event) ? rawEvent.event : null;
    if (!streamEvent || typeof streamEvent.type !== 'string') {
      return null;
    }

    if (streamEvent.type === 'content_block_start') {
      const contentBlock = isRecord(streamEvent.content_block) ? streamEvent.content_block : null;
      if (!contentBlock) {
        return null;
      }

      if (contentBlock.type === 'tool_use') {
        const blockIndex = Number.isInteger(streamEvent.index) ? streamEvent.index : null;
        const toolName = normalizeToolName(contentBlock.name);
        if (blockIndex !== null) {
          const current = toolUseBlocks.get(blockIndex) || {};
          toolUseBlocks.set(blockIndex, {
            ...current,
            toolName,
            partialInputJson: typeof current.partialInputJson === 'string' ? current.partialInputJson : '',
          });
        }
        return resolveToolProgress(toolName);
      }

      if (contentBlock.type === 'thinking' || contentBlock.type === 'text') {
        return {
          activity: 'Thinking...',
          tool: 'Thinking',
        };
      }

      return null;
    }

    if (streamEvent.type === 'content_block_delta') {
      const delta = isRecord(streamEvent.delta) ? streamEvent.delta : null;
      if (!delta || typeof delta.type !== 'string') {
        return null;
      }

      if (delta.type === 'thinking_delta' || delta.type === 'text_delta') {
        return {
          activity: 'Thinking...',
          tool: 'Thinking',
        };
      }

      if (delta.type !== 'input_json_delta') {
        return null;
      }

      const blockIndex = Number.isInteger(streamEvent.index) ? streamEvent.index : null;
      if (blockIndex === null) {
        return null;
      }

      const blockState = toolUseBlocks.get(blockIndex);
      if (!blockState) {
        return null;
      }

      const updatedState = {
        ...blockState,
        partialInputJson: `${typeof blockState.partialInputJson === 'string' ? blockState.partialInputJson : ''}${typeof delta.partial_json === 'string' ? delta.partial_json : ''}`,
      };
      toolUseBlocks.set(blockIndex, updatedState);

      return resolveToolProgress(updatedState.toolName, {
        partialInputJson: updatedState.partialInputJson,
      });
    }

    return null;
  }

  if (rawEvent.type !== 'assistant') {
    return null;
  }

  const message = isRecord(rawEvent.message) ? rawEvent.message : null;
  const content = Array.isArray(message?.content) ? message.content : [];

  for (const entry of content) {
    if (!isRecord(entry)) continue;

    if (entry.type === 'tool_use') {
      return resolveToolProgress(entry.name, {
        input: entry.input ?? null,
      });
    }

    if (entry.type === 'text' || entry.type === 'thinking') {
      return {
        activity: 'Thinking...',
        tool: 'Thinking',
      };
    }
  }

  return null;
}

module.exports = {
  extractChatProgressFromEvent,
  resolveToolProgress,
};

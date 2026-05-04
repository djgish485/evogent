function hasOwn(target, key) {
  return Boolean(target && Object.prototype.hasOwnProperty.call(target, key));
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isChatOutputPath(value) {
  return typeof value === 'string' && /(?:^|[\\/])chat-output\.jsonl(?:$|["'\s])/i.test(value);
}

function collectStringValues(value, depth = 5, results = []) {
  if (depth < 0 || value === null || value === undefined) {
    return results;
  }

  if (typeof value === 'string') {
    results.push(value);
    return results;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      collectStringValues(entry, depth - 1, results);
    }
    return results;
  }

  if (!isRecord(value)) {
    return results;
  }

  for (const entry of Object.values(value)) {
    collectStringValues(entry, depth - 1, results);
  }

  return results;
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

function normalizeNestedChatEscapes(value, nested) {
  if (!nested || typeof value !== 'string' || !value) {
    return value;
  }

  return value
    .replace(/\\r\\n/g, '\r\n')
    .replace(/\\n/g, '\n')
    .replace(/\\"/g, '"');
}

function extractChatFieldFromSerializedPayload(serialized, fieldName) {
  if (typeof serialized !== 'string' || !serialized) return null;

  const fieldPattern = new RegExp(
    `(?:\\\\"${fieldName}\\\\"|"${fieldName}")\\s*:\\s*(?:\\\\"|")([\\s\\S]*?)(?:(?:\\\\"|")|$)`,
    'i',
  );
  const fieldMatch = serialized.match(fieldPattern);
  if (!fieldMatch) {
    return null;
  }

  const decoded = normalizeNestedChatEscapes(
    decodeJsonStringFragment(fieldMatch[1] || ''),
    serialized.includes(`\\\"${fieldName}\\\"`),
  );
  return decoded.trim() ? decoded : null;
}

function collectChatPayloadCandidates(serialized) {
  if (typeof serialized !== 'string' || !serialized) {
    return [];
  }

  const typePattern = /(?:\\"type\\"|"type")\s*:\s*(?:\\"|")chat(?:\\"|")/gi;
  const markerIndexes = [];
  let match = typePattern.exec(serialized);

  while (match) {
    if (typeof match.index === 'number') {
      markerIndexes.push(match.index);
    }
    match = typePattern.exec(serialized);
  }

  if (markerIndexes.length === 0) {
    return [];
  }

  return markerIndexes
    .map((start, index) => {
      const nextStart = markerIndexes[index + 1];
      const candidate = serialized.slice(start, nextStart);
      const text = extractChatFieldFromSerializedPayload(candidate, 'text');
      if (!text) {
        return null;
      }

      return {
        text,
        inReplyTo: extractChatFieldFromSerializedPayload(candidate, 'inReplyTo'),
      };
    })
    .filter(Boolean);
}

function selectChatPayloadCandidate(candidates, expectedInReplyTo) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return null;
  }

  if (typeof expectedInReplyTo === 'string' && expectedInReplyTo.trim()) {
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      const candidate = candidates[index];
      if (candidate?.inReplyTo === expectedInReplyTo) {
        return candidate;
      }
    }

    const hasConflictingReplyTarget = candidates.some((candidate) => (
      typeof candidate?.inReplyTo === 'string'
      && candidate.inReplyTo
      && candidate.inReplyTo !== expectedInReplyTo
    ));

    if (hasConflictingReplyTarget) {
      return null;
    }
  }

  return candidates[candidates.length - 1] || null;
}

function extractChatPayloadFromSerializedPayload(serialized, expectedInReplyTo) {
  const candidates = collectChatPayloadCandidates(serialized);
  return selectChatPayloadCandidate(candidates, expectedInReplyTo);
}

function extractChatTextFromToolInput(toolName, input, expectedInReplyTo) {
  if (!isRecord(input)) return null;

  const stringValues = collectStringValues(input);
  const mentionsChatOutput = stringValues.some((value) => isChatOutputPath(value));

  for (const value of stringValues) {
    const mentionsChatPayload = value.includes('"type":"chat"') || value.includes('\\"type\\":\\"chat\\"');
    if (!mentionsChatPayload && !mentionsChatOutput && !(toolName === 'Bash' && isChatOutputPath(value))) {
      continue;
    }

    const payload = extractChatPayloadFromSerializedPayload(value, expectedInReplyTo);
    if (payload?.text) {
      return payload.text;
    }
  }

  return null;
}

function extractChatTextFromPartialToolInput(partialJson, expectedInReplyTo) {
  if (typeof partialJson !== 'string' || !partialJson) return null;

  const hasChatPayloadMarker = partialJson.includes('"type":"chat"') || partialJson.includes('\\"type\\":\\"chat\\"');
  if (!hasChatPayloadMarker) {
    return null;
  }

  return extractChatPayloadFromSerializedPayload(partialJson, expectedInReplyTo)?.text ?? null;
}

function extractStreamingChatTextFromEvent(rawEvent, toolUseBlocks, expectedInReplyTo = null) {
  if (!isRecord(rawEvent)) return null;

  if (rawEvent.type === 'stream_event') {
    const streamEvent = isRecord(rawEvent.event) ? rawEvent.event : null;
    if (!streamEvent) return null;

    if (streamEvent.type === 'content_block_start') {
      const contentBlock = isRecord(streamEvent.content_block) ? streamEvent.content_block : null;
      if (!contentBlock || contentBlock.type !== 'tool_use') {
        return null;
      }

      const blockIndex = Number.isInteger(streamEvent.index) ? streamEvent.index : null;
      if (blockIndex === null) {
        return null;
      }

      toolUseBlocks.set(blockIndex, {
        toolName: typeof contentBlock.name === 'string' ? contentBlock.name : '',
        partialInputJson: '',
      });
      return null;
    }

    if (streamEvent.type === 'content_block_delta') {
      const blockIndex = Number.isInteger(streamEvent.index) ? streamEvent.index : null;
      const delta = isRecord(streamEvent.delta) ? streamEvent.delta : null;
      if (blockIndex === null || !delta || delta.type !== 'input_json_delta') {
        return null;
      }

      const blockState = toolUseBlocks.get(blockIndex);
      if (!blockState) {
        return null;
      }

      const partialJson = typeof delta.partial_json === 'string' ? delta.partial_json : '';
      if (!partialJson) {
        return null;
      }

      blockState.partialInputJson += partialJson;
      return extractChatTextFromPartialToolInput(blockState.partialInputJson, expectedInReplyTo);
    }

    if (streamEvent.type === 'content_block_stop') {
      const blockIndex = Number.isInteger(streamEvent.index) ? streamEvent.index : null;
      if (blockIndex !== null) {
        toolUseBlocks.delete(blockIndex);
      }
    }

    return null;
  }

  if (rawEvent.type !== 'assistant') {
    return null;
  }

  const message = isRecord(rawEvent.message) ? rawEvent.message : null;
  const content = Array.isArray(message && hasOwn(message, 'content') ? message.content : null)
    ? message.content
    : [];

  for (const entry of content) {
    if (!isRecord(entry) || entry.type !== 'tool_use') continue;
    const toolName = typeof entry.name === 'string' ? entry.name : '';
    const text = extractChatTextFromToolInput(toolName, isRecord(entry.input) ? entry.input : null, expectedInReplyTo);
    if (text) {
      return text;
    }
  }

  return null;
}

function summarizeStreamingChatEvent(rawEvent) {
  if (!isRecord(rawEvent)) return null;

  if (rawEvent.type === 'stream_event') {
    const streamEvent = isRecord(rawEvent.event) ? rawEvent.event : null;
    if (!streamEvent || typeof streamEvent.type !== 'string') {
      return null;
    }

    if (streamEvent.type === 'content_block_start') {
      const contentBlock = isRecord(streamEvent.content_block) ? streamEvent.content_block : null;
      if (contentBlock?.type !== 'tool_use') {
        return null;
      }

      const toolName = typeof contentBlock.name === 'string' ? contentBlock.name : 'unknown';
      const index = Number.isInteger(streamEvent.index) ? streamEvent.index : '?';
      return `stream_event content_block_start tool=${toolName} index=${index}`;
    }

    if (streamEvent.type === 'content_block_delta') {
      const delta = isRecord(streamEvent.delta) ? streamEvent.delta : null;
      if (delta?.type !== 'input_json_delta') {
        return null;
      }

      const partialJson = typeof delta.partial_json === 'string' ? delta.partial_json : '';
      const index = Number.isInteger(streamEvent.index) ? streamEvent.index : '?';
      return `stream_event content_block_delta index=${index} chars=${partialJson.length}`;
    }

    if (streamEvent.type === 'content_block_stop') {
      const index = Number.isInteger(streamEvent.index) ? streamEvent.index : '?';
      return `stream_event content_block_stop index=${index}`;
    }

    return null;
  }

  if (rawEvent.type !== 'assistant') {
    return null;
  }

  const message = isRecord(rawEvent.message) ? rawEvent.message : null;
  const content = Array.isArray(message?.content) ? message.content : [];
  const toolNames = content
    .filter((entry) => isRecord(entry) && entry.type === 'tool_use')
    .map((entry) => (typeof entry.name === 'string' ? entry.name : 'unknown'));

  if (toolNames.length === 0) {
    return null;
  }

  return `assistant tool_use tools=${toolNames.join(',')}`;
}

module.exports = {
  extractStreamingChatTextFromEvent,
  summarizeStreamingChatEvent,
};

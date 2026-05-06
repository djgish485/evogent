const CLAUDE_PRICE_PER_MILLION = {
  'claude-sonnet-4-6': { input: 3.00, output: 15.00, cache_create: 3.75, cache_read: 0.30 },
  'claude-opus-4-7': { input: 15.00, output: 75.00, cache_create: 18.75, cache_read: 1.50 },
  'claude-opus-4-7[1m]': { input: 30.00, output: 150.00, cache_create: 37.50, cache_read: 3.00 },
};

function tokenCount(value) {
  return Number.isFinite(value) && Number(value) > 0
    ? Math.floor(Number(value))
    : 0;
}

function estimateClaudeCostUsd({
  model,
  input_tokens,
  output_tokens,
  cache_read,
  cache_create,
} = {}) {
  const normalizedModel = typeof model === 'string' && model.trim() ? model.trim() : null;
  const p = normalizedModel ? CLAUDE_PRICE_PER_MILLION[normalizedModel] : null;
  if (!p) return 0;

  return (
    tokenCount(input_tokens) * p.input
    + tokenCount(output_tokens) * p.output
    + tokenCount(cache_create) * p.cache_create
    + tokenCount(cache_read) * p.cache_read
  ) / 1_000_000;
}

module.exports = {
  CLAUDE_PRICE_PER_MILLION,
  estimateClaudeCostUsd,
};

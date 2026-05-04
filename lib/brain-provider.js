const { readBrainConfig } = require('./brain-config');
const { createClaudeProvider } = require('./providers/claude-provider');
const { createCodexProvider } = require('./providers/codex-provider');

function normalizeProviderName(providerName) {
  const normalized = typeof providerName === 'string'
    ? providerName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '')
    : '';

  return normalized === 'codex' || normalized === 'codexcli'
    ? 'codex'
    : 'claude';
}

function resolveBrainProviderByName(deps, configPath, providerName) {
  const brainConfig = readBrainConfig(configPath);
  if (normalizeProviderName(providerName) === 'codex') {
    return createCodexProvider(deps, brainConfig);
  }

  return createClaudeProvider(deps, brainConfig);
}

function resolveBrainProvider(deps, configPath) {
  const brainConfig = readBrainConfig(configPath);
  return resolveBrainProviderByName(deps, configPath, brainConfig.provider);
}

module.exports = {
  resolveBrainProvider,
  resolveBrainProviderByName,
};

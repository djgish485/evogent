const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_BRAIN_PROVIDER = 'claude';
const DEFAULT_CLAUDE_REASONING_EFFORT = 'high';
const DEFAULT_CODEX_REASONING_EFFORT = 'medium';
const DEFAULT_CODE_FIX_REASONING_EFFORT = 'high';
const DEFAULT_CODEX_MODEL = 'gpt-5.5';
const DEFAULT_USAGE_LEVEL = 'medium';
const DEFAULT_AUTOMATIC_CURATION_ENABLED = true;
const DEFAULT_BACKGROUND_SOURCE_BROWSING_ENABLED = true;
const DEFAULT_CONFIG_CONTENT = `# Evogent Config

## Agent Name
Evogent

## Interests

## Brain Provider
Claude Code

## Codex Model
gpt-5.5

## Codex Reasoning Effort
Medium

## Code-Fix Reasoning Effort
High

## Usage Level
Medium

## Automatic Curation
On

## Background Source Browsing
On

## Curation Schedule
<!-- Source caches refresh ahead of visible curation; Medium cache defaults are twitter 30m, Hacker News 60m, Substack 120m, YouTube 120m. -->
- Minimum interval: 90 minutes
- Maximum interval: 4 hours
`;

function extractMarkdownSection(content, heading) {
  if (typeof content !== 'string' || !content.trim()) {
    return null;
  }

  const lines = content.split(/\r?\n/);
  const startIndex = lines.findIndex((line) => new RegExp(`^##\\s+${heading}\\s*$`, 'i').test(line.trim()));
  if (startIndex === -1) {
    return null;
  }

  const sectionLines = [];
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^##\s+/.test(line.trim())) {
      break;
    }
    sectionLines.push(line);
  }

  return sectionLines.join('\n').trim() || null;
}

function normalizeBrainProvider(value) {
  const normalized = typeof value === 'string'
    ? value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '')
    : '';

  if (normalized === 'codex' || normalized === 'codexcli') {
    return 'codex';
  }

  if (normalized === 'claude' || normalized === 'claudecode' || normalized === 'claudecodecli') {
    return 'claude';
  }

  return DEFAULT_BRAIN_PROVIDER;
}

function normalizeUsageLevel(value) {
  const normalized = typeof value === 'string'
    ? value.trim().toLowerCase()
    : '';

  if (normalized === 'low' || normalized === 'medium' || normalized === 'high') {
    return normalized;
  }

  return null;
}

function deriveCodexReasoningEffortFromUsageLevel(value) {
  return normalizeUsageLevel(value) || DEFAULT_USAGE_LEVEL;
}

function parseConfigUsageLevel(content) {
  const usageSection = extractMarkdownSection(content, 'Usage Level');
  const usageMatch = usageSection?.match(/\b(low|medium|high)\b/i)?.[1] ?? '';
  return normalizeUsageLevel(usageMatch) || DEFAULT_USAGE_LEVEL;
}

function normalizeCodexReasoningEffort(value, fallback = DEFAULT_CODEX_REASONING_EFFORT) {
  const normalized = typeof value === 'string'
    ? value.trim().toLowerCase()
    : '';

  if (normalized === 'low' || normalized === 'medium' || normalized === 'high' || normalized === 'xhigh') {
    return normalized;
  }

  return normalizeCodexReasoningEffort(fallback, DEFAULT_CODEX_REASONING_EFFORT);
}

function normalizeClaudeReasoningEffort(value) {
  const normalized = typeof value === 'string'
    ? value.trim().toLowerCase()
    : '';

  if (normalized === 'low' || normalized === 'medium' || normalized === 'high' || normalized === 'xhigh' || normalized === 'max') {
    return normalized;
  }

  return DEFAULT_CLAUDE_REASONING_EFFORT;
}

function normalizeCodeFixReasoningEffort(value) {
  const normalized = typeof value === 'string'
    ? value.trim().toLowerCase()
    : '';

  if (
    normalized === 'low'
    || normalized === 'medium'
    || normalized === 'high'
    || normalized === 'xhigh'
    || normalized === 'max'
  ) {
    return normalized;
  }

  return DEFAULT_CODE_FIX_REASONING_EFFORT;
}

function resolveCodeFixReasoningEffortForProvider(value, provider) {
  const normalized = normalizeCodeFixReasoningEffort(value);
  if (provider === 'codex') {
    // Codex does not accept 'max'; fall back to xhigh.
    return normalized === 'max' ? 'xhigh' : normalized;
  }
  // Claude accepts the full set.
  return normalized;
}

function formatCodeFixReasoningEffort(value) {
  const normalized = normalizeCodeFixReasoningEffort(value);
  if (normalized === 'low') {
    return 'Low';
  }
  if (normalized === 'medium') {
    return 'Medium';
  }
  if (normalized === 'xhigh') {
    return 'XHigh';
  }
  if (normalized === 'max') {
    return 'Max';
  }
  return 'High';
}

function normalizeCodexModel(value) {
  const normalized = typeof value === 'string'
    ? value.trim()
    : '';

  return normalized || DEFAULT_CODEX_MODEL;
}

function getBrainProviderDisplayName(provider) {
  return provider === 'codex' ? 'Codex CLI' : 'Claude Code';
}

function getBrainProviderBinary(provider) {
  return provider === 'codex' ? 'codex' : 'claude';
}

function formatCodexReasoningEffort(value) {
  const normalized = normalizeCodexReasoningEffort(value);
  if (normalized === 'low') {
    return 'Low';
  }

  if (normalized === 'high') {
    return 'High';
  }

  return normalized === 'xhigh' ? 'XHigh' : 'Medium';
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function upsertMarkdownSection(content, heading, body) {
  const normalizedHeading = typeof heading === 'string' ? heading.trim() : '';
  const normalizedBody = typeof body === 'string' ? body.trim() : '';
  const fallbackContent = typeof content === 'string' && content.trim()
    ? content
    : DEFAULT_CONFIG_CONTENT;
  const baseContent = fallbackContent.replace(/\r\n/g, '\n').trimEnd();

  if (!normalizedHeading) {
    return `${baseContent}\n`;
  }

  const sectionPattern = new RegExp(
    `(^|\\n)##\\s+${escapeRegExp(normalizedHeading)}\\s*\\n([\\s\\S]*?)(?=\\n##\\s+|$)`,
    'i',
  );
  const sectionText = `## ${normalizedHeading}\n${normalizedBody}\n`;

  if (sectionPattern.test(baseContent)) {
    return `${baseContent.replace(sectionPattern, (_match, prefix) => `${prefix}${sectionText}`)}`.trimEnd() + '\n';
  }

  return `${baseContent}\n\n${sectionText}`.trimEnd() + '\n';
}

function updateBrainConfigContent(content, updates = {}) {
  const currentConfig = parseBrainConfig(content);
  const provider = Object.prototype.hasOwnProperty.call(updates, 'provider')
    ? normalizeBrainProvider(updates.provider)
    : currentConfig.provider;
  const codexModel = Object.prototype.hasOwnProperty.call(updates, 'codexModel')
    ? normalizeCodexModel(updates.codexModel)
    : currentConfig.codexModel;
  const codexReasoningEffort = Object.prototype.hasOwnProperty.call(updates, 'codexReasoningEffort')
    ? normalizeCodexReasoningEffort(updates.codexReasoningEffort)
    : currentConfig.codexReasoningEffort;

  let nextContent = typeof content === 'string' && content.trim()
    ? content
    : DEFAULT_CONFIG_CONTENT;

  nextContent = upsertMarkdownSection(nextContent, 'Brain Provider', getBrainProviderDisplayName(provider));
  nextContent = upsertMarkdownSection(nextContent, 'Codex Model', codexModel);
  nextContent = upsertMarkdownSection(nextContent, 'Codex Reasoning Effort', formatCodexReasoningEffort(codexReasoningEffort));

  return nextContent;
}

function updateCodeFixReasoningEffortConfigContent(content, value) {
  const formatted = formatCodeFixReasoningEffort(value);
  return upsertMarkdownSection(content, 'Code-Fix Reasoning Effort', formatted);
}

function resolveCodeFixReasoningEffortForBrainProvider(content, provider, updates = {}) {
  const currentConfig = parseBrainConfig(content);
  const normalizedProvider = normalizeBrainProvider(provider);

  if (normalizedProvider === 'codex') {
    const codexReasoningEffort = Object.prototype.hasOwnProperty.call(updates, 'codexReasoningEffort')
      ? updates.codexReasoningEffort
      : currentConfig.codexReasoningEffort;
    return normalizeCodexReasoningEffort(codexReasoningEffort);
  }

  const claudeReasoningEffort = Object.prototype.hasOwnProperty.call(updates, 'claudeReasoningEffort')
    ? updates.claudeReasoningEffort
    : currentConfig.claudeReasoningEffort;
  return normalizeClaudeReasoningEffort(claudeReasoningEffort);
}

function parseBrainConfig(content) {
  const providerSection = extractMarkdownSection(content, 'Brain Provider');
  const modelSection = extractMarkdownSection(content, 'Codex Model');
  const reasoningSection = extractMarkdownSection(content, 'Codex Reasoning Effort');
  const claudeReasoningSection = extractMarkdownSection(content, 'Claude Reasoning Effort');
  const codeFixReasoningSection = extractMarkdownSection(content, 'Code-Fix Reasoning Effort');
  const providerMatch = providerSection?.match(/\b(claude(?:\s+code)?|codex(?:\s+cli)?)\b/i)?.[1] ?? '';
  const reasoningMatch = reasoningSection?.match(/\b(low|medium|high|xhigh)\b/i)?.[1] ?? '';
  const claudeReasoningMatch = claudeReasoningSection?.match(/\b(low|medium|high|xhigh|max)\b/i)?.[1] ?? '';
  const codeFixReasoningMatch = codeFixReasoningSection?.match(/\b(low|medium|high|xhigh|max)\b/i)?.[1] ?? '';
  const provider = normalizeBrainProvider(providerMatch);
  const usageLevel = parseConfigUsageLevel(content);
  const derivedCodexReasoningEffort = deriveCodexReasoningEffortFromUsageLevel(usageLevel);

  return {
    provider,
    providerDisplayName: getBrainProviderDisplayName(provider),
    providerBinary: getBrainProviderBinary(provider),
    claudeReasoningEffort: normalizeClaudeReasoningEffort(claudeReasoningMatch),
    codexModel: normalizeCodexModel(modelSection),
    codexReasoningEffort: normalizeCodexReasoningEffort(reasoningMatch, derivedCodexReasoningEffort),
    codeFixReasoningEffort: normalizeCodeFixReasoningEffort(codeFixReasoningMatch),
  };
}

function normalizeAutomaticCurationEnabled(value) {
  const normalized = typeof value === 'string'
    ? value.trim().toLowerCase()
    : '';

  if ([
    'on',
    'enabled',
    'enable',
    'true',
    'yes',
  ].includes(normalized)) {
    return true;
  }

  if ([
    'off',
    'disabled',
    'disable',
    'false',
    'no',
  ].includes(normalized)) {
    return false;
  }

  return DEFAULT_AUTOMATIC_CURATION_ENABLED;
}

function normalizeBackgroundSourceBrowsingEnabled(value) {
  const normalized = typeof value === 'string'
    ? value.trim().toLowerCase()
    : '';

  if ([
    'on',
    'enabled',
    'enable',
    'true',
    'yes',
  ].includes(normalized)) {
    return true;
  }

  if ([
    'off',
    'disabled',
    'disable',
    'false',
    'no',
  ].includes(normalized)) {
    return false;
  }

  return DEFAULT_BACKGROUND_SOURCE_BROWSING_ENABLED;
}

function parseAutomaticCurationEnabled(content) {
  const section = extractMarkdownSection(content, 'Automatic Curation');
  if (!section) {
    return DEFAULT_AUTOMATIC_CURATION_ENABLED;
  }

  const firstMeaningfulLine = section
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[-*]\s*/, ''))
    .find(Boolean);

  return normalizeAutomaticCurationEnabled(firstMeaningfulLine);
}

function parseBackgroundSourceBrowsingEnabled(content) {
  const section = extractMarkdownSection(content, 'Background Source Browsing');
  if (!section) {
    return DEFAULT_BACKGROUND_SOURCE_BROWSING_ENABLED;
  }

  const firstMeaningfulLine = section
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[-*]\s*/, ''))
    .find(Boolean);

  return normalizeBackgroundSourceBrowsingEnabled(firstMeaningfulLine);
}

function readBrainConfig(configPath = path.join(process.cwd(), 'data', 'config.md')) {
  try {
    return parseBrainConfig(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return parseBrainConfig('');
  }
}

function readCodeFixReasoningEffort(configPath = path.join(process.cwd(), 'data', 'config.md')) {
  try {
    return parseBrainConfig(fs.readFileSync(configPath, 'utf8')).codeFixReasoningEffort;
  } catch {
    return DEFAULT_CODE_FIX_REASONING_EFFORT;
  }
}

function readAutomaticCurationEnabled(configPath = path.join(process.cwd(), 'data', 'config.md')) {
  try {
    return parseAutomaticCurationEnabled(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return DEFAULT_AUTOMATIC_CURATION_ENABLED;
  }
}

function readBackgroundSourceBrowsingEnabled(configPath = path.join(process.cwd(), 'data', 'config.md')) {
  try {
    return parseBackgroundSourceBrowsingEnabled(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return DEFAULT_BACKGROUND_SOURCE_BROWSING_ENABLED;
  }
}

module.exports = {
  DEFAULT_BACKGROUND_SOURCE_BROWSING_ENABLED,
  DEFAULT_AUTOMATIC_CURATION_ENABLED,
  DEFAULT_CONFIG_CONTENT,
  DEFAULT_BRAIN_PROVIDER,
  DEFAULT_CLAUDE_REASONING_EFFORT,
  DEFAULT_CODEX_MODEL,
  DEFAULT_CODEX_REASONING_EFFORT,
  DEFAULT_CODE_FIX_REASONING_EFFORT,
  deriveCodexReasoningEffortFromUsageLevel,
  extractMarkdownSection,
  formatCodexReasoningEffort,
  formatCodeFixReasoningEffort,
  getBrainProviderBinary,
  getBrainProviderDisplayName,
  normalizeBrainProvider,
  normalizeClaudeReasoningEffort,
  normalizeCodexModel,
  normalizeCodexReasoningEffort,
  normalizeUsageLevel,
  normalizeCodeFixReasoningEffort,
  normalizeAutomaticCurationEnabled,
  normalizeBackgroundSourceBrowsingEnabled,
  parseBrainConfig,
  parseAutomaticCurationEnabled,
  parseBackgroundSourceBrowsingEnabled,
  readAutomaticCurationEnabled,
  readBackgroundSourceBrowsingEnabled,
  readBrainConfig,
  readCodeFixReasoningEffort,
  resolveCodeFixReasoningEffortForProvider,
  resolveCodeFixReasoningEffortForBrainProvider,
  updateBrainConfigContent,
  updateCodeFixReasoningEffortConfigContent,
  upsertMarkdownSection,
};

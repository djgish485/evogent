const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_GATEWAY_URL = 'ws://127.0.0.1:18789';
const OPENCLAW_UNREACHABLE_MESSAGE = 'OpenClaw unreachable -- check ~/.openclaw/openclaw.json';
const OPENCLAW_CONFIG_PATH = path.join(os.homedir(), '.openclaw', 'openclaw.json');
const SETTINGS_HEADING = 'OpenClaw';

let cachedOpenClawConfig = null;
let cachedOpenClawConfigMtimeMs = null;

function getDataPath(fileName) {
  return path.join(process.cwd(), 'data', fileName);
}

function normalizeOptionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function readJsonFile(filePath) {
  const stat = fs.statSync(filePath);
  if (cachedOpenClawConfig && cachedOpenClawConfigMtimeMs === stat.mtimeMs) {
    return cachedOpenClawConfig;
  }

  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  cachedOpenClawConfig = parsed && typeof parsed === 'object' ? parsed : {};
  cachedOpenClawConfigMtimeMs = stat.mtimeMs;
  return cachedOpenClawConfig;
}

function readEvogentConfigContent() {
  try {
    return fs.readFileSync(getDataPath('config.md'), 'utf8');
  } catch {
    return '';
  }
}

function extractMarkdownSection(content, heading) {
  if (typeof content !== 'string' || !content.trim()) return '';
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const startIndex = lines.findIndex((line) => line.trim().toLowerCase() === `## ${heading}`.toLowerCase());
  if (startIndex === -1) return '';

  const section = [];
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] || '';
    if (line.trim().startsWith('## ')) break;
    section.push(line);
  }
  return section.join('\n').trim();
}

function readSettingLine(section, key) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(?:^|\\n)[ \\t]*(?:[-*][ \\t]*)?${escapedKey}[ \\t]*[:=][ \\t]*([^\\n]*)`, 'i');
  const match = section.match(pattern);
  return normalizeOptionalString(match?.[1] || '');
}

function readOpenClawSettings(content = readEvogentConfigContent()) {
  const section = extractMarkdownSection(content, SETTINGS_HEADING);
  return {
    gatewayUrl: readSettingLine(section, 'openclaw.gatewayUrl'),
    token: readSettingLine(section, 'openclaw.token'),
    defaultSessionKey: readSettingLine(section, 'openclaw.defaultSessionKey'),
  };
}

function upsertMarkdownSection(content, heading, body) {
  const base = (typeof content === 'string' && content.trim() ? content : '# Evogent Config\n')
    .replace(/\r\n/g, '\n')
    .trimEnd();
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(^|\\n)##\\s+${escapedHeading}\\s*\\n[\\s\\S]*?(?=\\n##\\s+|$)`, 'i');
  const replacement = `## ${heading}\n${body.trim()}\n`;
  if (pattern.test(base)) {
    return `${base.replace(pattern, (_match, prefix) => `${prefix}${replacement}`)}`.trimEnd() + '\n';
  }
  return `${base}\n\n${replacement}`.trimEnd() + '\n';
}

function updateOpenClawSettings(updates) {
  const configPath = getDataPath('config.md');
  const currentContent = readEvogentConfigContent();
  const currentSettings = readOpenClawSettings(currentContent);
  const nextSettings = {
    gatewayUrl: Object.prototype.hasOwnProperty.call(updates, 'gatewayUrl')
      ? normalizeOptionalString(updates.gatewayUrl)
      : currentSettings.gatewayUrl,
    token: Object.prototype.hasOwnProperty.call(updates, 'token')
      ? normalizeOptionalString(updates.token)
      : currentSettings.token,
    defaultSessionKey: Object.prototype.hasOwnProperty.call(updates, 'defaultSessionKey')
      ? normalizeOptionalString(updates.defaultSessionKey)
      : currentSettings.defaultSessionKey,
  };
  const body = [
    '<!-- Optional overrides for Evogent to mirror local OpenClaw chat sessions. Leave gatewayUrl and token blank for auto-discovery from ~/.openclaw/openclaw.json. -->',
    `openclaw.gatewayUrl: ${nextSettings.gatewayUrl}`,
    `openclaw.token: ${nextSettings.token}`,
    `openclaw.defaultSessionKey: ${nextSettings.defaultSessionKey}`,
  ].join('\n');
  const nextContent = upsertMarkdownSection(currentContent, SETTINGS_HEADING, body);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, nextContent, 'utf8');
  return nextSettings;
}

function readOpenClawFileConfig() {
  try {
    return readJsonFile(OPENCLAW_CONFIG_PATH);
  } catch {
    return {};
  }
}

function parseGatewayPort(gateway) {
  const rawPort = gateway?.port || gateway?.listenPort || gateway?.wsPort;
  const port = Number(rawPort);
  return Number.isInteger(port) && port > 0 ? port : 18789;
}

function resolveGatewayBindHost(gateway) {
  const rawHost = normalizeOptionalString(gateway?.host || gateway?.hostname);
  if (rawHost) return rawHost;

  const bind = normalizeOptionalString(gateway?.bind);
  const customBindHost = normalizeOptionalString(gateway?.customBindHost);
  if (bind === 'custom' && customBindHost) return customBindHost;
  if (bind === 'localhost' || bind === '127.0.0.1' || bind === '::1') return bind;

  return '127.0.0.1';
}

function resolveDiscoveredGatewayUrl(openClawConfig) {
  const gateway = openClawConfig && typeof openClawConfig === 'object' ? openClawConfig.gateway : null;
  if (!gateway || typeof gateway !== 'object') {
    return DEFAULT_GATEWAY_URL;
  }

  const explicitUrl = normalizeOptionalString(gateway.url || gateway.gatewayUrl || gateway.wsUrl);
  if (explicitUrl) return explicitUrl;

  const port = parseGatewayPort(gateway);
  const host = resolveGatewayBindHost(gateway);
  return `ws://${host}:${port}`;
}

function isLoopbackGatewayUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'ws:'
      && ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(parsed.hostname);
  } catch {
    return false;
  }
}

function resolveOpenClawConnectionConfig() {
  const settings = readOpenClawSettings();
  const openClawConfig = readOpenClawFileConfig();
  const gatewayUrl = settings.gatewayUrl || resolveDiscoveredGatewayUrl(openClawConfig);
  const token = settings.token || normalizeOptionalString(openClawConfig.gateway?.auth?.token);
  if (!isLoopbackGatewayUrl(gatewayUrl)) {
    throw new Error('Remote OpenClaw gateways are planned for a follow-up; v1 only supports loopback ws://127.0.0.1.');
  }

  return {
    gatewayUrl,
    token,
    defaultSessionKey: settings.defaultSessionKey,
    source: {
      gatewayUrl: settings.gatewayUrl ? 'settings' : 'auto',
      token: settings.token ? 'settings' : 'auto',
    },
  };
}

function getOpenClawSettingsView() {
  const settings = readOpenClawSettings();
  return {
    gatewayUrl: settings.gatewayUrl,
    tokenConfigured: Boolean(settings.token),
    defaultSessionKey: settings.defaultSessionKey,
  };
}

module.exports = {
  DEFAULT_GATEWAY_URL,
  OPENCLAW_CONFIG_PATH,
  OPENCLAW_UNREACHABLE_MESSAGE,
  getOpenClawSettingsView,
  readOpenClawSettings,
  resolveOpenClawConnectionConfig,
  updateOpenClawSettings,
};

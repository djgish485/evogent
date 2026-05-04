'use strict';

const fs = require('node:fs');
const path = require('node:path');
const matter = require('gray-matter');

function readPromptAddon(repoDir, relativePath) {
  const baseDir = path.resolve(repoDir || process.cwd());
  const addonPath = path.join(baseDir, relativePath);
  if (!fs.existsSync(addonPath)) {
    return { exists: false, path: addonPath, data: {}, body: '' };
  }

  try {
    const parsed = matter(fs.readFileSync(addonPath, 'utf8'));
    const data = parsed.data && typeof parsed.data === 'object' && !Array.isArray(parsed.data)
      ? parsed.data
      : {};
    return {
      exists: true,
      path: addonPath,
      data,
      body: String(parsed.content || '').trim(),
    };
  } catch (error) {
    const message = error instanceof Error && error.message.trim()
      ? error.message.trim()
      : String(error);
    console.error(`[prompt-addon] Failed to parse ${addonPath}: ${message}`);
    throw new Error(`Failed to parse prompt addon ${addonPath}: ${message}`);
  }
}

function renderPromptAddonBody(body, variables = {}) {
  return String(body || '').replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (match, key) => {
    const value = variables[key];
    return value === undefined || value === null ? match : String(value);
  }).trim();
}

module.exports = {
  readPromptAddon,
  renderPromptAddonBody,
};

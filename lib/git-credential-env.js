'use strict';

const os = require('node:os');
const path = require('node:path');

function normalizeString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function resolveHome(env = process.env) {
  const explicitHome = normalizeString(env.HOME);
  if (explicitHome) {
    return explicitHome;
  }

  try {
    const userInfoHome = normalizeString(os.userInfo().homedir);
    if (userInfoHome) {
      return userInfoHome;
    }
  } catch {
    // Fall through to conservative defaults.
  }

  try {
    const osHome = normalizeString(os.homedir());
    if (osHome) {
      return osHome;
    }
  } catch {
    // Fall through to uid-specific default.
  }

  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    return '/root';
  }

  return '';
}

function getGitCredentialEnv(env = process.env) {
  const home = resolveHome(env);
  const xdgConfigHome = normalizeString(env.XDG_CONFIG_HOME)
    || (home ? path.join(home, '.config') : '');
  const ghConfigDir = normalizeString(env.GH_CONFIG_DIR)
    || (xdgConfigHome ? path.join(xdgConfigHome, 'gh') : '');

  return {
    ...(home ? { HOME: home } : {}),
    ...(xdgConfigHome ? { XDG_CONFIG_HOME: xdgConfigHome } : {}),
    ...(ghConfigDir ? { GH_CONFIG_DIR: ghConfigDir } : {}),
    GIT_TERMINAL_PROMPT: '0',
  };
}

function applyGitCredentialEnv(baseEnv = process.env, overrides = {}) {
  const merged = {
    ...baseEnv,
    ...overrides,
  };

  return {
    ...merged,
    ...getGitCredentialEnv(merged),
  };
}

function getGitCredentialEnvForLaunch(baseEnv = process.env, explicitEnv = {}) {
  const merged = {
    ...baseEnv,
    ...explicitEnv,
  };

  return {
    ...explicitEnv,
    ...getGitCredentialEnv(merged),
  };
}

module.exports = {
  applyGitCredentialEnv,
  getGitCredentialEnv,
  getGitCredentialEnvForLaunch,
  resolveHome,
};

const PHONE_PROFILE_NAMES = new Set(['phone', 'android', 'pixel']);

function normalizeBoolean(value) {
  return value === '1' || value === 'true';
}

function getRuntimeProfile(env = process.env) {
  const raw = env.EVOGENT_RUNTIME_PROFILE || env.MEDIA_AGENT_RUNTIME_PROFILE || 'default';
  return String(raw).trim().toLowerCase() || 'default';
}

function isPhoneRuntime(env = process.env) {
  return PHONE_PROFILE_NAMES.has(getRuntimeProfile(env));
}

function areBackgroundJobsDisabled(env = process.env) {
  return isPhoneRuntime(env) || normalizeBoolean(env.MEDIA_AGENT_DISABLE_BACKGROUND_JOBS);
}

function getAdaptiveHeartbeatMode(env = process.env) {
  const explicit = String(env.EVOGENT_ADAPTIVE_HEARTBEAT_MODE || '').trim().toLowerCase();
  if (explicit === 'direct' || explicit === 'signal' || explicit === 'off') {
    return explicit;
  }
  if (isPhoneRuntime(env)) return 'signal';
  if (areBackgroundJobsDisabled(env)) return 'off';
  return 'direct';
}

function getListenHost(env = process.env) {
  const explicit = env.LISTEN_HOST || env.HOST;
  return typeof explicit === 'string' && explicit.trim() ? explicit.trim() : '127.0.0.1';
}

module.exports = {
  areBackgroundJobsDisabled,
  getAdaptiveHeartbeatMode,
  getListenHost,
  getRuntimeProfile,
  isPhoneRuntime,
};

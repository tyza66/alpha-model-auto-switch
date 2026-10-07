/**
 * Sidecar state persistence for the auto-switch plugin.
 *
 * Stores the runtime configuration and per-session switch state in a JSON
 * file at $DSH_HOME/profiles/<profile>/.alpha-model-auto-switch.json.
 * The host reads this file on every phase boundary, so changes take effect
 * without a profile restart.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

/** Sidecar file name. */
const SIDECAR_FILENAME = '.alpha-model-auto-switch.json';

/**
 * Resolve the sidecar file path for a given profile.
 * @param {string} profile - Profile name.
 * @returns {string} Absolute path to the sidecar file.
 */
function sidecarPath(profile) {
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  return join(dshHome, 'profiles', profile, SIDECAR_FILENAME);
}

/**
 * Read the sidecar state for a profile.
 * @param {string} profile - Profile name.
 * @returns {object} Parsed state, or default state if file doesn't exist.
 */
export function readState(profile) {
  const defaults = {
    enabled: true,
    models: [],
    maxConsecutiveFailures: 5,
    cooldownMs: 60000,
    quotaCooldownMs: 14400000,
    maxCooldownMs: 86400000,
    autoRecover: true,
    maxSwitchesPerSession: 10,
    notifyOnSwitch: true,
    failoverOnRateLimit: true,
    failoverOnTimeout: true,
    failoverOnServerError: true,
    failoverOnTransportError: true,
    failoverOnStreamInterrupted: true,
    failoverOnEmptyResponse: false,
    failoverOnQuota: true,
    sessions: {},
  };

  try {
    const path = sidecarPath(profile);
    if (!existsSync(path)) return defaults;
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw);
    return { ...defaults, ...parsed };
  } catch {
    return defaults;
  }
}

/**
 * Write the sidecar state for a profile.
 * @param {string} profile - Profile name.
 * @param {object} state - State to persist.
 * @returns {{ path: string, changed: boolean }} Result with file path and whether anything changed.
 */
export function writeState(profile, state) {
  const path = sidecarPath(profile);
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });

  const next = JSON.stringify(state, null, 2);
  let changed = true;
  try {
    if (existsSync(path)) {
      const current = readFileSync(path, 'utf8');
      changed = current !== next;
    }
  } catch {
    // File unreadable; treat as changed.
  }

  writeFileSync(path, next, 'utf8');
  return { path, changed };
}

/**
 * Read the enabled flag from the sidecar.
 * @param {string} profile - Profile name.
 * @returns {boolean} Whether auto-switch is enabled.
 */
export function readEnabled(profile) {
  return readState(profile).enabled !== false;
}

/**
 * Write the enabled flag to the sidecar.
 * @param {string} profile - Profile name.
 * @param {boolean} enabled - New enabled state.
 * @returns {{ path: string, changed: boolean }} Result.
 */
export function writeEnabled(profile, enabled) {
  const state = readState(profile);
  state.enabled = enabled;
  return writeState(profile, state);
}

/**
 * Get or create session state.
 * @param {string} profile - Profile name.
 * @param {string} sessionId - Session identifier.
 * @returns {object} Session state.
 */
export function getSessionState(profile, sessionId) {
  const state = readState(profile);
  if (!state.sessions[sessionId]) {
    state.sessions[sessionId] = {
      switchCount: 0,
      lastSwitchAt: 0,
      failedModels: [],
      failureCounts: {},
      currentModel: null,
    };
  }
  return state.sessions[sessionId];
}

/**
 * Update session state and persist.
 * @param {string} profile - Profile name.
 * @param {string} sessionId - Session identifier.
 * @param {object} updates - Partial session state to merge.
 * @returns {object} Updated session state.
 */
export function updateSessionState(profile, sessionId, updates) {
  const state = readState(profile);
  if (!state.sessions[sessionId]) {
    state.sessions[sessionId] = {
      switchCount: 0,
      lastSwitchAt: 0,
      failedModels: [],
      failureCounts: {},
      currentModel: null,
    };
  }
  Object.assign(state.sessions[sessionId], updates);
  writeState(profile, state);
  return state.sessions[sessionId];
}

/**
 * Record a model failure for a session.
 * @param {string} profile - Profile name.
 * @param {string} sessionId - Session identifier.
 * @param {string} provider - Provider route.
 * @param {string} model - Model id.
 * @param {string} code - Error code.
 * @returns {object} Updated session state with failure count.
 */
export function recordFailure(profile, sessionId, provider, model, code) {
  const key = `${provider}/${model}`;
  const session = getSessionState(profile, sessionId);
  session.failureCounts[key] = (session.failureCounts[key] || 0) + 1;
  return updateSessionState(profile, sessionId, {
    failureCounts: session.failureCounts,
  });
}

/**
 * Reset failure count for a model after success.
 * @param {string} profile - Profile name.
 * @param {string} sessionId - Session identifier.
 * @param {string} provider - Provider route.
 * @param {string} model - Model id.
 */
export function resetFailure(profile, sessionId, provider, model) {
  const key = `${provider}/${model}`;
  const session = getSessionState(profile, sessionId);
  if (session.failureCounts[key]) {
    delete session.failureCounts[key];
    updateSessionState(profile, sessionId, {
      failureCounts: session.failureCounts,
    });
  }
}

/**
 * Record a model switch.
 * @param {string} profile - Profile name.
 * @param {string} sessionId - Session identifier.
 * @param {string} fromProvider - Previous provider.
 * @param {string} fromModel - Previous model.
 * @param {string} toProvider - New provider.
 * @param {string} toModel - New model.
 * @returns {object} Updated session state.
 */
export function recordSwitch(profile, sessionId, fromProvider, fromModel, toProvider, toModel) {
  const session = getSessionState(profile, sessionId);
  session.switchCount++;
  session.lastSwitchAt = Date.now();
  session.currentModel = `${toProvider}/${toModel}`;
  if (!session.failedModels.includes(`${fromProvider}/${fromModel}`)) {
    session.failedModels.push(`${fromProvider}/${fromModel}`);
  }
  return updateSessionState(profile, sessionId, {
    switchCount: session.switchCount,
    lastSwitchAt: session.lastSwitchAt,
    failedModels: session.failedModels,
    currentModel: session.currentModel,
  });
}

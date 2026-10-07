/**
 * @tyza66/alpha-model-auto-switch — automatic model failover for Alpha.
 *
 * Watches every LLM stream call through the `llm/stream` waterfall. When the
 * current model becomes severely unavailable (consecutive failures with
 * fatal error codes, or immediate-switch codes like AUTH/QUOTA), the plugin
 * automatically selects another model from the same provider and continues
 * the task without breaking execution.
 *
 * The plugin rides alongside the default web-app bundle. It does not modify
 * the retry policy; instead, it observes the terminal outcome of each stream
 * call and decides whether to switch models based on the accumulated failure
 * count and error codes.
 *
 * State is persisted in a sidecar JSON at
 *   $DSH_HOME/profiles/<profile>/.alpha-model-auto-switch.json
 * so changes take effect at the next turn boundary without a profile restart.
 *
 * @module @tyza66/alpha-model-auto-switch
 */
import z from '@mutantcat/schemastery';
import { createUserMessage } from '@mutantcat/dsh-llm';
import { readFileSync } from 'node:fs';
import {
  readState,
  readEnabled,
  writeEnabled,
  getSessionState,
  updateSessionState,
  recordFailure,
  resetFailure,
  recordSwitch,
} from './patch-state.js';

/**
 * This bundle's own version, read once at module load from the package.json
 * that ships next to this file.
 */
const BUNDLE_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version ?? null;
  } catch {
    return null;
  }
})();

/** Stable Cordis plugin name. */
const name = 'model-auto-switch';

/** Service dependencies the apply step needs before registering hooks. */
const inject = [
  'agents',
  'webServer',
  'llm',
];

/** Plugin configuration schema. */
const Config = z.object({
  /** Enable/disable the auto-switch mechanism globally. */
  enabled: z.boolean().default(true),
  /** Number of consecutive failures before triggering a model switch. */
  failureThreshold: z.number().step(1).min(1).max(100).default(3),
  /** Error codes that count toward the failure threshold. */
  fatalErrorCodes: z.array(z.string()).default([
    'AUTH',
    'INVALID_CREDENTIAL',
    'QUOTA',
    'CONTEXT_WINDOW_EXCEEDED',
    'UNSUPPORTED_REASONING_EFFORT',
    'NO_ADAPTER',
    'INVALID_MODEL_INFO',
    'INVALID_ADAPTER',
    'REGISTRATION_DISPOSED',
  ]),
  /** Error codes that immediately trigger a switch (no threshold needed). */
  immediateSwitchCodes: z.array(z.string()).default([
    'AUTH',
    'INVALID_CREDENTIAL',
    'QUOTA',
    'NO_ADAPTER',
  ]),
  /** Maximum number of model switches per session before giving up. */
  maxSwitchesPerSession: z.number().step(1).min(1).max(100).default(10),
  /** Cooldown period in milliseconds between switches. */
  switchCooldownMs: z.number().step(1).min(0).max(600_000).default(5000),
  /** Whether to inject a user-visible notice when switching models. */
  notifyOnSwitch: z.boolean().default(true),
  /** Whether to exclude the current model from future selections. */
  excludeFailedModels: z.boolean().default(true),
});

/**
 * Create a user-visible notice message for a model switch.
 * @param {string} fromProvider - Previous provider.
 * @param {string} fromModel - Previous model.
 * @param {string} toProvider - New provider.
 * @param {string} toModel - New model.
 * @param {string} reason - Human-readable reason for the switch.
 * @returns {object} User message payload.
 */
function createSwitchNotice(fromProvider, fromModel, toProvider, toModel, reason) {
  const from = fromProvider === toProvider ? fromModel : `${fromProvider}/${fromModel}`;
  const to = toProvider === toProvider ? toModel : `${toProvider}/${toModel}`;
  return createUserMessage({
    content: [{
      type: 'text',
      text: `[model auto-switch: ${from} → ${to}. Reason: ${reason}]`,
    }],
    source: {
      kind: 'plugin',
      plugin: 'model-auto-switch',
      form: 'notice',
      summary: `${from} → ${to}`,
    },
  });
}

/**
 * Check if an error code should trigger an immediate switch.
 * @param {string} code - Error code from the failure.
 * @param {string[]} immediateCodes - Configured immediate-switch codes.
 * @returns {boolean}
 */
function isImmediateSwitchCode(code, immediateCodes) {
  return immediateCodes.includes(code);
}

/**
 * Check if an error code is a fatal error that counts toward the threshold.
 * @param {string} code - Error code from the failure.
 * @param {string[]} fatalCodes - Configured fatal error codes.
 * @returns {boolean}
 */
function isFatalErrorCode(code, fatalCodes) {
  return fatalCodes.includes(code);
}

/**
 * Select the next model from the same provider, excluding failed models.
 * @param {string} provider - Provider route.
 * @param {string} currentModel - Current model id.
 * @param {string[]} failedModels - List of failed model keys (provider/model).
 * @param {object} llm - LLM service.
 * @returns {Promise<{ model: string, name: string } | null>} Selected model or null.
 */
async function selectNextModel(provider, currentModel, failedModels, llm) {
  try {
    const models = await llm.listModels(provider);
    const available = models.filter((m) => {
      const key = `${provider}/${m.id}`;
      return m.id !== currentModel && !failedModels.includes(key);
    });
    if (available.length === 0) return null;
    // Prefer models with similar names (e.g., same family)
    const currentLower = currentModel.toLowerCase();
    const scored = available.map((m) => {
      const nameLower = m.id.toLowerCase();
      let score = 0;
      if (nameLower.includes(currentLower) || currentLower.includes(nameLower)) score += 10;
      // Prefer models with similar context windows
      return { model: m, score };
    });
    scored.sort((a, b) => b.score - a.score);
    return { model: scored[0].model.id, name: scored[0].model.name };
  } catch {
    return null;
  }
}

/**
 * Get the current profile name from the environment.
 * @returns {string} Profile name.
 */
function getProfile() {
  return process.env.DSH_PROFILE ?? 'default';
}

/**
 * Read the current snapshot for the settings panel.
 * @returns {object} Snapshot object.
 */
function readSnapshot() {
  const profile = getProfile();
  const state = readState(profile);
  return {
    enabled: state.enabled,
    version: BUNDLE_VERSION,
    failureThreshold: state.failureThreshold,
    maxSwitchesPerSession: state.maxSwitchesPerSession,
  };
}

/**
 * Apply the plugin.
 * @param {object} ctx - Cordis context.
 * @param {object} config - Plugin configuration.
 */
function apply(ctx, config) {
  const logger = ctx.logger;
  const profile = getProfile();

  // Per-session runtime state (not persisted, just for tracking)
  const sessionRuntime = new Map();

  /**
   * Get or create runtime state for a session.
   * @param {string} sessionId - Session identifier.
   * @returns {object} Runtime state.
   */
  function getRuntime(sessionId) {
    if (!sessionRuntime.has(sessionId)) {
      sessionRuntime.set(sessionId, {
        lastFailureAt: 0,
        consecutiveFailures: 0,
      });
    }
    return sessionRuntime.get(sessionId);
  }

  /**
   * Handle a failed LLM stream call.
   * @param {string} sessionId - Session identifier.
   * @param {string} provider - Provider route.
   * @param {string} model - Model id.
   * @param {string} code - Error code.
   * @param {string} message - Error message.
   */
  async function handleFailure(sessionId, provider, model, code, message) {
    const state = readState(profile);
    if (!state.enabled) return;

    const key = `${provider}/${model}`;
    const runtime = getRuntime(sessionId);
    const now = Date.now();

    // Check cooldown
    if (now - runtime.lastFailureAt < state.switchCooldownMs) {
      runtime.consecutiveFailures++;
      return;
    }

    runtime.lastFailureAt = now;
    runtime.consecutiveFailures++;

    // Record failure in sidecar
    recordFailure(profile, sessionId, provider, model, code);

    // Check if we should switch
    const shouldSwitchImmediately = isImmediateSwitchCode(code, state.immediateSwitchCodes);
    const isFatal = isFatalErrorCode(code, state.fatalErrorCodes);
    const thresholdReached = runtime.consecutiveFailures >= state.failureThreshold;

    if (!shouldSwitchImmediately && !(isFatal && thresholdReached)) {
      return;
    }

    // Get session state
    const sessionState = getSessionState(profile, sessionId);
    if (sessionState.switchCount >= state.maxSwitchesPerSession) {
      logger?.warn?.(`alpha-model-auto-switch: max switches reached for session ${sessionId}, not switching`);
      return;
    }

    // Select next model
    const nextModel = await selectNextModel(provider, model, sessionState.failedModels, ctx.llm);
    if (!nextModel) {
      logger?.warn?.(`alpha-model-auto-switch: no alternative model available for provider ${provider}`);
      return;
    }

    // Find the agent for this session
    const agents = ctx.agents.list();
    const agent = agents.find((a) => a.session?.id === sessionId);
    if (!agent) {
      logger?.warn?.(`alpha-model-auto-switch: no agent found for session ${sessionId}`);
      return;
    }

    // Get the session controller to switch models
    const sessionApi = ctx.get('sessionController');
    if (!sessionApi) {
      logger?.warn?.(`alpha-model-auto-switch: sessionController not available`);
      return;
    }

    try {
      // Record the switch
      recordSwitch(profile, sessionId, provider, model, provider, nextModel.model);

      // Switch the model
      sessionApi.selectForNextRequest(agent, {
        provider,
        model: nextModel.model,
      });

      // Inject notice if enabled
      if (state.notifyOnSwitch) {
        const notice = createSwitchNotice(provider, model, provider, nextModel.model, message || code);
        agent.session.append('user/message', notice);
      }

      // Reset runtime failure count
      runtime.consecutiveFailures = 0;

      logger?.info?.(`alpha-model-auto-switch: switched ${provider}/${model} → ${provider}/${nextModel.model} for session ${sessionId}`);
    } catch (error) {
      logger?.error?.(`alpha-model-auto-switch: failed to switch model: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Handle a successful LLM stream call.
   * @param {string} sessionId - Session identifier.
   * @param {string} provider - Provider route.
   * @param {string} model - Model id.
   */
  function handleSuccess(sessionId, provider, model) {
    const runtime = getRuntime(sessionId);
    runtime.consecutiveFailures = 0;
    resetFailure(profile, sessionId, provider, model);
  }

  // Register the llm/stream waterfall listener
  ctx.effect(() => {
    const disposer = ctx.on('llm/stream', async (options, next) => {
      const sessionId = options.sessionId;
      const provider = options.provider;
      const model = options.model;

      // Call the next handler in the waterfall
      const stream = await next();

      // Wrap the stream to observe the outcome
      return (async function* () {
        try {
          for await (const chunk of stream) {
            // Check for terminal error
            if (chunk.type === 'finish' && chunk.reason.kind === 'error') {
              const code = chunk.reason.failure.code;
              const message = chunk.reason.failure.message;
              if (sessionId) {
                await handleFailure(sessionId, provider, model, code, message);
              }
            }
            yield chunk;
          }
          // Stream completed successfully
          if (sessionId) {
            handleSuccess(sessionId, provider, model);
          }
        } catch (error) {
          // Stream threw an error
          if (sessionId) {
            const code = error instanceof Error && 'code' in error ? String(error.code) : 'UNKNOWN';
            const message = error instanceof Error ? error.message : String(error);
            await handleFailure(sessionId, provider, model, code, message);
          }
          throw error;
        }
      })();
    }, { prepend: true });
    return disposer;
  }, 'alpha-model-auto-switch: llm/stream watcher');

  // Register webserver routes for the settings panel
  const STATE_PATH = '/api/model-auto-switch/state';
  const ENABLED_PATH = '/api/model-auto-switch/enabled';

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: STATE_PATH,
    handler: async (req, res) => {
      if (req.method !== 'GET') {
        res.writeHead(405, { allow: 'GET' });
        res.end();
        return;
      }
      const snapshot = readSnapshot();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(snapshot));
    }
  }), 'alpha-model-auto-switch: GET /api/model-auto-switch/state');

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ENABLED_PATH,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' });
        res.end();
        return;
      }
      const body = await readJsonBody(req, res);
      if (body === null) return;
      if (typeof body?.enabled !== 'boolean') {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'enabled must be a boolean' }));
        return;
      }
      const result = writeEnabled(profile, body.enabled);
      logger?.info?.(`alpha-model-auto-switch: ${body.enabled ? 'enabled' : 'disabled'}`);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        ...readSnapshot(),
        path: result.path,
        changed: result.changed
      }));
    }
  }), 'alpha-model-auto-switch: POST /api/model-auto-switch/enabled');
}

/**
 * Read a JSON body from a request.
 * @param {object} req - HTTP request.
 * @param {object} res - HTTP response.
 * @returns {Promise<object|null>} Parsed body or null on error.
 */
function readJsonBody(req, res) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => {
      try {
        resolve(JSON.parse(data));
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid JSON' }));
        resolve(null);
      }
    });
    req.on('error', () => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'read error' }));
      resolve(null);
    });
  });
}

export { Config, apply, inject, name };

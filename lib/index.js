/**
 * @tyza66/alpha-model-auto-switch — automatic model failover for Alpha.
 *
 * Watches every LLM stream call through the `llm/stream` waterfall. When the
 * current model becomes severely unavailable, the plugin automatically selects
 * another model from the same provider and continues the task without breaking
 * execution.
 *
 * Key features:
 * - "Wall" vs "blip" detection: quota/usage window failures switch immediately,
 *   while transient failures (5xx, timeout, transport) use a threshold.
 * - Half-open probe: after cooldown, a provider is admitted as a probe, not
 *   fully healthy. Success clears the ledger; failure re-parks with escalation.
 * - Per-class failover switches: each error category has its own toggle.
 * - Provider health management: tracks consecutive failures, cooldown state.
 * - Log scrubbing: credentials and tokens are automatically masked.
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

//#region failure classification
/**
 * Failure classes that justify leaving the current provider, each owned by one
 * config toggle. Codes follow the provider-neutral harness set.
 */
const FAILOVER_CODE_TOGGLES = {
  RATE_LIMIT: 'failoverOnRateLimit',
  SERVER: 'failoverOnServerError',
  TIMEOUT: 'failoverOnTimeout',
  TRANSPORT: 'failoverOnTransportError',
  STREAM_CLOSED: 'failoverOnStreamInterrupted',
  EMPTY_RESPONSE: 'failoverOnEmptyResponse',
  QUOTA: 'failoverOnQuota',
};

/**
 * Check if a failure code is eligible for failover.
 * @param {string} code - Error code from the failure.
 * @param {object} config - Resolved plugin config.
 * @returns {boolean}
 */
function isFailoverEligible(code, config) {
  const toggle = FAILOVER_CODE_TOGGLES[code];
  return toggle !== undefined && config[toggle] === true;
}

/**
 * Check if a failure code is a permanent error that should never trigger failover.
 * @param {string} code - Error code from the failure.
 * @returns {boolean}
 */
function isPermanentError(code) {
  return ['AUTH', 'INVALID_CREDENTIAL', 'INVALID_REQUEST', 'UNKNOWN_MODEL',
    'UNSUPPORTED_REASONING_EFFORT', 'CONTEXT_WINDOW_EXCEEDED', 'ABORTED'].includes(code);
}
//#endregion

//#region wall detection
/**
 * A "wall" is a failure that will keep failing until a reset: an exhausted
 * quota, a metered usage window, a billing hard limit. Unlike a blip it is not
 * worth retrying at the same provider, so a wall switches on the FIRST failure
 * and parks the provider until the reset the provider itself published.
 */
const WALL_CODES = new Set(['QUOTA']);
/** A published reset at least this far out is a wall; anything shorter is a blip. */
const WALL_MIN_RESET_MS = 60 * 1000;
/** Reset hints beyond this are not believed. */
const MAX_TRUSTED_RESET_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Prose markers of account-level exhaustion.
 */
const WALL_MESSAGE_MARKERS = [
  'usage limit for your plan',
  'premium credits exhausted',
  'insufficient credits',
  'insufficient balance',
  'insufficient quota',
  'credit balance is too low',
  'billing hard limit',
  'out of credits',
];

/** "…resets at 2026-09-25T03:38:40Z" */
const RESET_STAMP_PATTERN = /resets? at (\d{4}-\d{2}-\d{2}T[\d:.]+Z)/i;
/** "…retry again in 30 seconds" / "in 2 minutes" / "in 1 hour". */
const RESET_PROSE_PATTERN = /(?:retry|try)\s+again\s+in\s+(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|seconds|m|min|mins|minutes|h|hr|hrs|hours)\b/i;
const PROSE_UNIT_MS = {
  ms: 1,
  s: 1000, sec: 1000, secs: 1000, seconds: 1000,
  m: 60_000, min: 60_000, mins: 60_000, minutes: 60_000,
  h: 3_600_000, hr: 3_600_000, hrs: 3_600_000, hours: 3_600_000,
};

/**
 * Resolve the reset plan for a failure.
 * @param {object} failure - The LlmFailure object.
 * @param {number} nowMs - Current time in milliseconds.
 * @returns {{ wall: boolean, parkMs?: number, source: string }}
 */
function resolveResetPlan(failure, nowMs) {
  const message = typeof failure?.message === 'string' ? failure.message : '';
  const lower = message.toLowerCase();
  const code = typeof failure?.code === 'string' ? failure.code : '';
  const published = failure?.providerRetryAfterMs;
  const publishedMs = typeof published === 'number' && Number.isFinite(published) && published > 0 ? published : undefined;

  let stampedMs;
  const stamp = message.match(RESET_STAMP_PATTERN)?.[1];
  if (stamp !== undefined) {
    const parsed = Date.parse(stamp);
    if (!Number.isNaN(parsed)) stampedMs = parsed - nowMs;
  }

  let proseMs;
  const prose = message.match(RESET_PROSE_PATTERN);
  if (prose !== null) proseMs = Number(prose[1]) * (PROSE_UNIT_MS[prose[2].toLowerCase()] ?? 0);

  const rawReset = publishedMs ?? stampedMs ?? proseMs;
  const resetMs = rawReset !== undefined && Number.isFinite(rawReset) && rawReset > 0 && rawReset <= MAX_TRUSTED_RESET_MS ? rawReset : undefined;

  const namedWindow = WALL_MESSAGE_MARKERS.some((marker) => lower.includes(marker));

  if (resetMs !== undefined && resetMs >= WALL_MIN_RESET_MS) {
    return { wall: true, parkMs: resetMs, source: publishedMs !== undefined ? 'provider-retry-after' : (stampedMs !== undefined ? 'reset-stamp' : 'retry-after-prose') };
  }
  if (WALL_CODES.has(code)) return { wall: true, source: 'quota-code' };
  if (namedWindow) return { wall: true, source: 'message-marker' };
  return { wall: false, parkMs: resetMs, source: resetMs !== undefined ? 'short-reset' : 'transient' };
}
//#endregion

//#region log scrubbing
/**
 * Truncate provider error text for logs and actively mask anything that could
 * carry a credential.
 * @param {string} message - The message to scrub.
 * @returns {string}
 */
function scrubLog(message) {
  const text = typeof message === 'string' ? message : String(message ?? '');
  const scrubbed = text
    .replace(/\/\/[^@\s/]+@/g, '//***@')
    .replace(/(bearer\s+)\S+/gi, '$1***')
    .replace(/((?:api[-_]?key|access[-_]?token|token|key)=)[^&\s]+/gi, '$1***')
    .replace(/((?:x-)?api[-_]?key["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1***');
  return scrubbed.length > 200 ? scrubbed.slice(0, 197) + '...' : scrubbed;
}
//#endregion

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
  /** Model pool for failover (order = priority). */
  models: z.array(z.object({
    provider: z.string(),
    model: z.string(),
  })).default([]),
  /** Number of consecutive failures before triggering a model switch (for blip errors). */
  maxConsecutiveFailures: z.number().step(1).min(1).max(100).default(5),
  /** Cooldown period in milliseconds for blip errors. */
  cooldownMs: z.number().step(1).min(1000).max(86_400_000).default(60_000),
  /** Cooldown period in milliseconds for wall errors (quota/usage window). */
  quotaCooldownMs: z.number().step(1).min(1000).max(86_400_000).default(14_400_000),
  /** Maximum cooldown period in milliseconds (escalation cap). */
  maxCooldownMs: z.number().step(1).min(1000).max(86_400_000).default(86_400_000),
  /** Whether to automatically recover providers after cooldown. */
  autoRecover: z.boolean().default(true),
  /** Maximum number of model switches per session before giving up. */
  maxSwitchesPerSession: z.number().step(1).min(1).max(100).default(10),
  /** Whether to inject a user-visible notice when switching models. */
  notifyOnSwitch: z.boolean().default(true),
  /** Failover on HTTP 429 (rate limit). */
  failoverOnRateLimit: z.boolean().default(true),
  /** Failover on timeout errors. */
  failoverOnTimeout: z.boolean().default(true),
  /** Failover on HTTP 5xx (server error). */
  failoverOnServerError: z.boolean().default(true),
  /** Failover on transport errors (DNS, connection reset, proxy). */
  failoverOnTransportError: z.boolean().default(true),
  /** Failover on SSE stream interruption. */
  failoverOnStreamInterrupted: z.boolean().default(true),
  /** Failover on empty response. */
  failoverOnEmptyResponse: z.boolean().default(false),
  /** Failover on quota/usage window (wall). */
  failoverOnQuota: z.boolean().default(true),
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
  const to = toProvider === fromProvider ? toModel : `${toProvider}/${toModel}`;
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
    maxConsecutiveFailures: state.maxConsecutiveFailures,
    maxSwitchesPerSession: state.maxSwitchesPerSession,
  };
}

//#region provider health management
/**
 * Provider health state.
 * @typedef {object} ProviderHealth
 * @property {number} failures - Consecutive failure count.
 * @property {number|undefined} unavailableUntil - Timestamp when cooldown expires.
 * @property {boolean} halfOpen - Whether provider is in half-open probe state.
 * @property {number} parks - Number of times this provider has been parked.
 * @property {string|undefined} lastCause - Why it was parked ('wall' | 'failures').
 */

/**
 * Create a new provider health state.
 * @returns {ProviderHealth}
 */
function createProviderHealth() {
  return {
    failures: 0,
    unavailableUntil: undefined,
    halfOpen: false,
    parks: 0,
    lastCause: undefined,
  };
}

/**
 * Check if a provider is unavailable (in cooldown).
 * @param {ProviderHealth} state - Provider health state.
 * @param {number} now - Current time in milliseconds.
 * @returns {boolean}
 */
function isProviderUnavailable(state, now) {
  if (state?.unavailableUntil === undefined) return false;
  if (now >= state.unavailableUntil) {
    state.unavailableUntil = undefined;
    state.halfOpen = true;
    state.failures = 0;
    return false;
  }
  return true;
}

/**
 * Check if a provider is in half-open state.
 * @param {ProviderHealth} state - Provider health state.
 * @returns {boolean}
 */
function isProviderHalfOpen(state) {
  return state?.halfOpen === true;
}

/**
 * Calculate escalated cooldown for a provider.
 * @param {ProviderHealth} state - Provider health state.
 * @param {object} config - Plugin config.
 * @returns {number} Cooldown in milliseconds.
 */
function escalatedCooldownMs(state, config) {
  const base = state.lastCause === 'wall' ? config.quotaCooldownMs : config.cooldownMs;
  const escalated = base * 2 ** Math.max(0, state.parks);
  return Math.min(escalated, config.maxCooldownMs);
}

/**
 * Mark a provider as unavailable (parked).
 * @param {ProviderHealth} state - Provider health state.
 * @param {string} cause - Why it's parked ('wall' | 'failures').
 * @param {number|undefined} parkMs - Custom cooldown in ms, or undefined to use escalation.
 * @param {object} config - Plugin config.
 * @param {number} now - Current time in milliseconds.
 * @returns {number} Applied cooldown in ms.
 */
function markProviderUnavailable(state, cause, parkMs, config, now) {
  state.failures = 0;
  state.halfOpen = false;
  state.parks += 1;
  state.lastCause = cause;
  const ms = parkMs !== undefined
    ? Math.min(parkMs, config.maxCooldownMs)
    : escalatedCooldownMs(state, config);
  state.unavailableUntil = config.autoRecover && ms > 0 ? now + ms : Number.POSITIVE_INFINITY;
  return ms;
}

/**
 * Mark a provider as healthy (recovered).
 * @param {ProviderHealth} state - Provider health state.
 */
function markProviderHealthy(state) {
  state.failures = 0;
  state.unavailableUntil = undefined;
  state.halfOpen = false;
  state.parks = 0;
  state.lastCause = undefined;
}

/**
 * Format duration for logs.
 * @param {number} ms - Duration in milliseconds.
 * @returns {string}
 */
function formatDuration(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h${rest}m`;
}
//#endregion

/**
 * Apply the plugin.
 * @param {object} ctx - Cordis context.
 * @param {object} config - Plugin configuration.
 */
function apply(ctx, config) {
  const logger = ctx.logger;
  const profile = getProfile();

  // Provider health ledger (in-memory, not persisted)
  const providerHealth = new Map();

  /**
   * Get or create provider health state.
   * @param {string} provider - Provider route.
   * @returns {ProviderHealth}
   */
  function getProviderHealth(provider) {
    if (!providerHealth.has(provider)) {
      providerHealth.set(provider, createProviderHealth());
    }
    return providerHealth.get(provider);
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

    const now = Date.now();

    // Check if this is a permanent error (never failover)
    if (isPermanentError(code)) {
      logger?.warn?.(`alpha-model-auto-switch: permanent error ${code} for ${provider}/${model}, not failing over`);
      return;
    }

    // Check if this error is eligible for failover
    if (!isFailoverEligible(code, state)) {
      logger?.info?.(`alpha-model-auto-switch: error ${code} is not eligible for failover`);
      return;
    }

    // Get provider health state
    const health = getProviderHealth(provider);

    // Check if provider is in cooldown
    if (isProviderUnavailable(health, now)) {
      logger?.info?.(`alpha-model-auto-switch: provider ${provider} is in cooldown, not switching`);
      return;
    }

    // Resolve wall vs blip
    const failure = { code, message, providerRetryAfterMs: undefined };
    const resetPlan = resolveResetPlan(failure, now);

    // Increment failure count
    health.failures += 1;

    // Check if we should switch
    const shouldSwitch = resetPlan.wall || health.failures >= state.maxConsecutiveFailures;
    if (!shouldSwitch) {
      logger?.info?.(`alpha-model-auto-switch: ${provider}/${model} failure ${health.failures}/${state.maxConsecutiveFailures} (${code})`);
      return;
    }

    // Get session state for switch count
    const sessionState = getSessionState(profile, sessionId);
    if (sessionState.switchCount >= state.maxSwitchesPerSession) {
      logger?.warn?.(`alpha-model-auto-switch: max switches reached for session ${sessionId}, not switching`);
      return;
    }

    // Select next model from the same provider
    const nextModel = await selectNextModel(provider, model, sessionState.failedModels, ctx.llm);
    if (!nextModel) {
      logger?.warn?.(`alpha-model-auto-switch: no alternative model available for provider ${provider}`);
      return;
    }

    try {
      recordSwitch(profile, sessionId, provider, model, provider, nextModel.model);

      await ctx.sessionController.selectModel({
        sessionId,
        provider,
        model: nextModel.model,
      });

      // Park the provider
      const cause = resetPlan.wall ? 'wall' : 'failures';
      const cooldownMs = markProviderUnavailable(health, cause, resetPlan.parkMs, state, now);

      // Inject notice if enabled
      if (state.notifyOnSwitch) {
        const agents = ctx.agents.list();
        const agent = agents.find((a) => a.session?.id === sessionId);
        if (agent) {
          const notice = createSwitchNotice(provider, model, provider, nextModel.model, message || code);
          agent.session.append('user/message', notice);
        }
      }

      logger?.info?.(`alpha-model-auto-switch: switched ${provider}/${model} → ${provider}/${nextModel.model} for session ${sessionId} (${cause}, cooldown: ${formatDuration(cooldownMs)})`);

    } catch (error) {
      logger?.error?.(`alpha-model-auto-switch: failed to switch model: ${scrubLog(error instanceof Error ? error.message : String(error))}`);
    }
  }

  /**
   * Handle a successful LLM stream call.
   * @param {string} sessionId - Session identifier.
   * @param {string} provider - Provider route.
   * @param {string} model - Model id.
   */
  function handleSuccess(sessionId, provider, model) {
    const health = getProviderHealth(provider);
    const wasDegraded = health.failures > 0 || health.unavailableUntil !== undefined || health.halfOpen;
    markProviderHealthy(health);
    if (wasDegraded) {
      logger?.info?.(`alpha-model-auto-switch: provider ${provider} recovered and rejoined the model pool`);
    }
    resetFailure(profile, sessionId, provider, model);
  }

  // Register the llm/stream waterfall listener
  ctx.effect(() => {
    const disposer = ctx.on('llm/stream', (options, next) => {
      const sessionId = options.sessionId;
      const provider = options.provider;
      const model = options.model;

      // Call the next handler in the waterfall
      const stream = next();

      // Wrap the stream to observe the outcome
      return (async function* () {
        try {
          for await (const chunk of stream) {
            // Check for terminal error
            if (chunk.type === 'finish' && chunk.reason.kind === 'error') {
              const code = chunk.reason.failure.code;
              const message = chunk.reason.failure.message;
              if (sessionId) {
                // Fire-and-forget: don't block the stream consumer
                handleFailure(sessionId, provider, model, code, message).catch((err) => {
                  logger?.error?.(`alpha-model-auto-switch: handleFailure error: ${err instanceof Error ? err.message : String(err)}`);
                });
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
            handleFailure(sessionId, provider, model, code, message).catch((err) => {
              logger?.error?.(`alpha-model-auto-switch: handleFailure error: ${err instanceof Error ? err.message : String(err)}`);
            });
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

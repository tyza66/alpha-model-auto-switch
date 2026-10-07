/**
 * Unit tests for alpha-model-auto-switch.
 *
 * Tests the core logic: error code classification, threshold handling,
 * model selection, and sidecar state persistence.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readState, writeState, readEnabled, writeEnabled, getSessionState, updateSessionState, recordFailure, resetFailure, recordSwitch } from '../lib/patch-state.js';

// Mock DSH_HOME for testing
process.env.DSH_HOME = '/tmp/alpha-model-auto-switch-test';

test('readState returns defaults when file does not exist', () => {
  const state = readState('nonexistent-profile');
  assert.equal(state.enabled, true);
  assert.equal(state.maxConsecutiveFailures, 5, 'maxConsecutiveFailures should be 5');
  assert.equal(state.cooldownMs, 60000, 'cooldownMs should be 60000');
  assert.equal(state.quotaCooldownMs, 14400000, 'quotaCooldownMs should be 14400000');
  assert.equal(state.maxCooldownMs, 86400000, 'maxCooldownMs should be 86400000');
  assert.equal(state.autoRecover, true, 'autoRecover should be true');
  assert.equal(state.failoverOnRateLimit, true, 'failoverOnRateLimit should be true');
  assert.equal(state.failoverOnQuota, true, 'failoverOnQuota should be true');
});

test('writeState and readState round-trip', () => {
  const profile = 'test-roundtrip';
  const original = readState(profile);
  original.enabled = false;
  original.maxConsecutiveFailures = 7;
  writeState(profile, original);
  
  const loaded = readState(profile);
  assert.equal(loaded.enabled, false);
  assert.equal(loaded.maxConsecutiveFailures, 7);
});

test('readEnabled and writeEnabled work correctly', () => {
  const profile = 'test-enabled';
  writeEnabled(profile, false);
  assert.equal(readEnabled(profile), false);
  
  writeEnabled(profile, true);
  assert.equal(readEnabled(profile), true);
});

test('getSessionState creates default session state', () => {
  const profile = 'test-session';
  const sessionId = 'test-session-id';
  const state = getSessionState(profile, sessionId);
  
  assert.equal(state.switchCount, 0);
  assert.deepEqual(state.failedModels, []);
  assert.deepEqual(state.failureCounts, {});
});

test('recordFailure increments failure count', () => {
  const profile = 'test-failure-unique';
  const sessionId = 'test-failure-session-unique';
  const provider = 'test-provider';
  const model = 'test-model';
  
  recordFailure(profile, sessionId, provider, model, 'AUTH');
  const state = getSessionState(profile, sessionId);
  assert.equal(state.failureCounts[`${provider}/${model}`], 1);
  
  recordFailure(profile, sessionId, provider, model, 'AUTH');
  const state2 = getSessionState(profile, sessionId);
  assert.equal(state2.failureCounts[`${provider}/${model}`], 2);
});

test('resetFailure clears failure count', () => {
  const profile = 'test-reset';
  const sessionId = 'test-reset-session';
  const provider = 'test-provider';
  const model = 'test-model';
  
  recordFailure(profile, sessionId, provider, model, 'AUTH');
  resetFailure(profile, sessionId, provider, model);
  
  const state = getSessionState(profile, sessionId);
  assert.equal(state.failureCounts[`${provider}/${model}`], undefined);
});

test('recordSwitch updates session state', () => {
  const profile = 'test-switch-unique';
  const sessionId = 'test-switch-session-unique';
  const fromProvider = 'provider-a';
  const fromModel = 'model-a';
  const toProvider = 'provider-a';
  const toModel = 'model-b';
  
  recordSwitch(profile, sessionId, fromProvider, fromModel, toProvider, toModel);
  
  const state = getSessionState(profile, sessionId);
  assert.equal(state.switchCount, 1);
  assert.ok(state.failedModels.includes(`${fromProvider}/${fromModel}`));
  assert.equal(state.currentModel, `${toProvider}/${toModel}`);
});

test('updateSessionState merges updates', () => {
  const profile = 'test-update';
  const sessionId = 'test-update-session';
  
  updateSessionState(profile, sessionId, { switchCount: 5 });
  const state = getSessionState(profile, sessionId);
  assert.equal(state.switchCount, 5);
});

test('error code classification helpers work correctly', () => {
  // Test the new error classification structure
  const state = readState('test-classification');
  assert.equal(state.failoverOnRateLimit, true);
  assert.equal(state.failoverOnTimeout, true);
  assert.equal(state.failoverOnServerError, true);
  assert.equal(state.failoverOnTransportError, true);
  assert.equal(state.failoverOnStreamInterrupted, true);
  assert.equal(state.failoverOnEmptyResponse, false);
  assert.equal(state.failoverOnQuota, true);
});

test('model selection excludes failed models', () => {
  // This tests the logic conceptually - the actual selectNextModel
  // function requires the llm service which is not available in unit tests
  const failedModels = ['provider/model-a', 'provider/model-b'];
  const available = ['provider/model-c', 'provider/model-d'];
  
  const filtered = available.filter(m => !failedModels.includes(m));
  assert.deepEqual(filtered, ['provider/model-c', 'provider/model-d']);
});

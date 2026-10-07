/**
 * Type definitions for @tyza66/alpha-model-auto-switch.
 */

import type { Context } from '@mutantcat/cordis';
import type { z } from '@mutantcat/schemastery';

/** Plugin configuration schema. */
export interface ModelAutoSwitchConfig {
  /** Enable/disable the auto-switch mechanism globally. */
  enabled: boolean;
  /** Number of consecutive failures before triggering a model switch. */
  failureThreshold: number;
  /** Error codes that count toward the failure threshold. */
  fatalErrorCodes: string[];
  /** Error codes that immediately trigger a switch (no threshold needed). */
  immediateSwitchCodes: string[];
  /** Maximum number of model switches per session before giving up. */
  maxSwitchesPerSession: number;
  /** Cooldown period in milliseconds between switches. */
  switchCooldownMs: number;
  /** Whether to inject a user-visible notice when switching models. */
  notifyOnSwitch: boolean;
  /** Whether to exclude the current model from future selections. */
  excludeFailedModels: boolean;
}

/** Session state persisted in the sidecar. */
export interface SessionState {
  /** Number of model switches performed in this session. */
  switchCount: number;
  /** Timestamp of the last switch. */
  lastSwitchAt: number;
  /** List of failed model keys (provider/model). */
  failedModels: string[];
  /** Failure counts per model key. */
  failureCounts: Record<string, number>;
  /** Current model key. */
  currentModel: string | null;
}

/** Sidecar state shape. */
export interface SidecarState {
  /** Whether auto-switch is enabled. */
  enabled: boolean;
  /** Failure threshold. */
  failureThreshold: number;
  /** Fatal error codes. */
  fatalErrorCodes: string[];
  /** Immediate switch codes. */
  immediateSwitchCodes: string[];
  /** Max switches per session. */
  maxSwitchesPerSession: number;
  /** Switch cooldown in ms. */
  switchCooldownMs: number;
  /** Whether to notify on switch. */
  notifyOnSwitch: boolean;
  /** Whether to exclude failed models. */
  excludeFailedModels: boolean;
  /** Per-session state. */
  sessions: Record<string, SessionState>;
}

/** Snapshot returned by the state API. */
export interface StateSnapshot {
  /** Whether auto-switch is enabled. */
  enabled: boolean;
  /** Bundle version. */
  version: string | null;
  /** Failure threshold. */
  failureThreshold: number;
  /** Max switches per session. */
  maxSwitchesPerSession: number;
}

/** Plugin apply function. */
export function apply(ctx: Context, config: ModelAutoSwitchConfig): void;

/** Plugin inject dependencies. */
export const inject: string[];

/** Plugin name. */
export const name: string;

/** Config schema. */
export const Config: z.ZodType<ModelAutoSwitchConfig>;

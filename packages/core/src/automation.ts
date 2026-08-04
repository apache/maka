import type { BackendKind } from './session.js';
import type { CollaborationMode } from './collaboration.js';
import type { OrchestrationMode } from './orchestration.js';
import type { ThinkingLevel } from './model-thinking.js';

const UTF8 = new TextEncoder();

// Preserve the embedded model schema's code-unit limits while giving every
// boundary an explicit UTF-8 ceiling. TextEncoder needs at most three bytes per
// JavaScript code unit, including replacement encoding for lone surrogates.
export const AUTOMATION_NAME_MAX_CODE_UNITS = 100;
export const AUTOMATION_NAME_MAX_BYTES = 300;
export const AUTOMATION_PROMPT_MAX_CODE_UNITS = 2_000;
export const AUTOMATION_PROMPT_MAX_BYTES = 6_000;
export const AUTOMATION_CRON_EXPRESSION_MAX_CODE_UNITS = 100;
export const AUTOMATION_CRON_EXPRESSION_MAX_BYTES = 300;
export const AUTOMATION_LAST_ERROR_MAX_CODE_UNITS = 2_000;
export const AUTOMATION_LAST_ERROR_MAX_BYTES = 6_000;

export interface AutomationTextLimit {
  readonly maxCodeUnits: number;
  readonly maxBytes: number;
}

export const AUTOMATION_NAME_LIMIT: AutomationTextLimit = Object.freeze({
  maxCodeUnits: AUTOMATION_NAME_MAX_CODE_UNITS,
  maxBytes: AUTOMATION_NAME_MAX_BYTES,
});
export const AUTOMATION_PROMPT_LIMIT: AutomationTextLimit = Object.freeze({
  maxCodeUnits: AUTOMATION_PROMPT_MAX_CODE_UNITS,
  maxBytes: AUTOMATION_PROMPT_MAX_BYTES,
});
export const AUTOMATION_CRON_EXPRESSION_LIMIT: AutomationTextLimit = Object.freeze({
  maxCodeUnits: AUTOMATION_CRON_EXPRESSION_MAX_CODE_UNITS,
  maxBytes: AUTOMATION_CRON_EXPRESSION_MAX_BYTES,
});
export const AUTOMATION_LAST_ERROR_LIMIT: AutomationTextLimit = Object.freeze({
  maxCodeUnits: AUTOMATION_LAST_ERROR_MAX_CODE_UNITS,
  maxBytes: AUTOMATION_LAST_ERROR_MAX_BYTES,
});

export function isAutomationTextWithinLimit(
  value: unknown,
  limit: AutomationTextLimit,
  options: { readonly nonblank?: boolean } = {},
): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= limit.maxCodeUnits &&
    UTF8.encode(value).byteLength <= limit.maxBytes &&
    (options.nonblank !== true || value.trim().length > 0)
  );
}

export function truncateAutomationText(value: string, limit: AutomationTextLimit): string {
  if (value.length <= limit.maxCodeUnits && UTF8.encode(value).byteLength <= limit.maxBytes) {
    return value;
  }
  let result = '';
  let bytes = 0;
  for (const character of value) {
    const nextBytes = UTF8.encode(character).byteLength;
    if (
      result.length + character.length > limit.maxCodeUnits ||
      bytes + nextBytes > limit.maxBytes
    ) {
      break;
    }
    result += character;
    bytes += nextBytes;
  }
  return result;
}

export type AutomationKind = 'heartbeat' | 'cron';
export type AutomationStatus = 'active' | 'paused' | 'completed' | 'expired';

export type AutomationSchedule =
  | { type: 'cron'; expression: string }
  | { type: 'interval'; seconds: number }
  | { type: 'once'; delaySeconds: number };

/** Frozen execution settings used by durable cron fires after their creator changes. */
export interface AutomationExecutionTemplate {
  readonly cwd: string;
  readonly projectId?: string | null;
  readonly backend: BackendKind;
  readonly llmConnectionSlug: string;
  readonly model: string;
  readonly thinkingLevel?: ThinkingLevel;
  readonly collaborationMode: CollaborationMode;
  readonly orchestrationMode: OrchestrationMode;
}

export interface AutomationDefinition {
  id: string;
  kind: AutomationKind;
  name: string;
  status: AutomationStatus;
  prompt: string;
  sessionId: string;
  schedule: AutomationSchedule;
  createdAt: number;
  updatedAt: number;
  nextFireAt: number | null;
  lastFireAt: number | null;
  lastRunId: string | null;
  fireCount: number;
  maxFires: number | null;
  expiresAt: number | null;
  lastError: string | null;
  consecutiveFailures: number;
  /** Cron definitions are globally visible and survive the creating Client. */
  durable?: boolean;
  deferredFireCount?: number;
  /** Present for Host-created cron definitions; legacy definitions acquire it before firing. */
  execution?: AutomationExecutionTemplate;
}

/** Durable execution intent removed atomically when its canonical Run settles. */
export interface AutomationPendingFire {
  readonly id: string;
  readonly automationId: string;
  readonly automationKind: AutomationKind;
  readonly automationName: string;
  readonly prompt: string;
  readonly scheduledFor: number;
  readonly targetSessionId: string;
  readonly turnId: string;
  readonly runId: string;
  readonly userMessageId: string;
  readonly status: 'admitted' | 'running';
  readonly admittedAt: number;
  readonly updatedAt: number;
  readonly startedAt?: number;
  readonly execution?: AutomationExecutionTemplate;
}

export interface AutomationAuthoritySnapshot {
  readonly revision: number;
  readonly automations: readonly AutomationDefinition[];
  readonly pendingFires: readonly AutomationPendingFire[];
}

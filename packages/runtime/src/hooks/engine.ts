import type {
  HookCompletedAudit,
  PreToolUseHookInput,
  ResolvedHookDefinition,
} from '@maka/core/hooks';
import {
  createHookCommandRunner,
  type HookCommandResult,
  type HookCommandRunner,
} from './command-runner.js';
import { hookMatcherMatches } from './matcher.js';

const DEFAULT_CONCURRENCY = 8;
const MAX_DENIAL_REASON_CHARS = 4_000;
const MAX_AUDIT_MESSAGE_CHARS = 4_000;

export interface HookDispatchResult {
  denied: boolean;
  reason?: string;
  audits: HookCompletedAudit[];
  auditWriteFailures: string[];
}

export interface PreToolUseHookDispatcher {
  prepareTurn(turnId: string): void;
  runPreToolUse(
    input: PreToolUseHookInput,
    abortSignal: AbortSignal,
    context: HookDispatchRuntimeContext,
  ): Promise<HookDispatchResult>;
}

export interface HookDispatchRuntimeContext {
  invocationId: string;
}

export interface PreToolUseHookDispatcherInput {
  loadSnapshot(turnId: string): Promise<readonly ResolvedHookDefinition[]>;
  recordAudit?: (
    input: PreToolUseHookInput,
    audit: HookCompletedAudit,
    context: HookDispatchRuntimeContext,
  ) => Promise<void>;
  commandRunner?: HookCommandRunner;
  now?: () => number;
  concurrency?: number;
}

export function createPreToolUseHookDispatcher(
  input: PreToolUseHookDispatcherInput,
): PreToolUseHookDispatcher {
  const commandRunner = input.commandRunner ?? createHookCommandRunner();
  const now = input.now ?? Date.now;
  const concurrency = input.concurrency ?? DEFAULT_CONCURRENCY;
  const snapshots = new Map<string, Promise<readonly ResolvedHookDefinition[]>>();

  const snapshotForTurn = (turnId: string): Promise<readonly ResolvedHookDefinition[]> => {
    let snapshot = snapshots.get(turnId);
    if (!snapshot) {
      snapshot = input.loadSnapshot(turnId);
      snapshots.set(turnId, snapshot);
      while (snapshots.size > 8) snapshots.delete(snapshots.keys().next().value!);
    }
    return snapshot;
  };

  return {
    prepareTurn(turnId) {
      void snapshotForTurn(turnId).catch(() => {});
    },
    async runPreToolUse(hookInput, abortSignal, context) {
      const definitions = await snapshotForTurn(hookInput.turn_id);
      const matching = definitions.filter((definition) =>
        hookMatcherMatches(definition.matcher, hookInput.tool_name),
      );
      const audits = await mapConcurrent(matching, concurrency, async (definition) => {
        if (!definition.trusted) {
          return auditFor(definition, hookInput, 'skipped_untrusted', 0, 'Review required');
        }
        const startedAt = now();
        const result = await commandRunner.run(definition, hookInput, abortSignal);
        return auditFromCommandResult(
          definition,
          hookInput,
          result,
          Math.max(0, now() - startedAt),
        );
      });
      const auditWriteFailures: string[] = [];
      if (input.recordAudit) {
        for (const audit of audits) {
          try {
            await input.recordAudit(hookInput, audit, context);
          } catch (error) {
            auditWriteFailures.push(errorMessage(error));
          }
        }
      }
      const denials = audits.filter((audit) => audit.status === 'denied');
      return {
        denied: denials.length > 0,
        ...(denials.length > 0
          ? {
              reason: boundText(
                denials
                  .map((audit) => audit.message || `Hook ${audit.handlerId} denied this tool call.`)
                  .join('\n'),
                MAX_DENIAL_REASON_CHARS,
              ),
            }
          : {}),
        audits,
        auditWriteFailures,
      };
    },
  };
}

function auditFromCommandResult(
  definition: ResolvedHookDefinition,
  input: PreToolUseHookInput,
  result: HookCommandResult,
  durationMs: number,
): HookCompletedAudit {
  if (result.aborted) {
    return auditFor(definition, input, 'failed', durationMs, 'Hook aborted with the Turn');
  }
  if (result.timedOut) {
    return auditFor(definition, input, 'failed', durationMs, 'Hook timed out');
  }
  if (result.spawnError) {
    return auditFor(definition, input, 'failed', durationMs, result.spawnError);
  }
  if (result.exitCode === 2) {
    return auditFor(
      definition,
      input,
      'denied',
      durationMs,
      result.stderr.trim() || `Hook ${definition.id} denied this tool call.`,
    );
  }
  if (result.exitCode !== 0) {
    return auditFor(
      definition,
      input,
      'failed',
      durationMs,
      `Hook exited with code ${String(result.exitCode)}`,
    );
  }
  const stdout = result.stdout.trim();
  if (!stdout) return auditFor(definition, input, 'allowed', durationMs);
  try {
    const decision = parseStructuredDecision(stdout);
    return auditFor(
      definition,
      input,
      decision.decision === 'deny' ? 'denied' : 'allowed',
      durationMs,
      decision.reason,
    );
  } catch (error) {
    return auditFor(definition, input, 'failed', durationMs, errorMessage(error));
  }
}

function parseStructuredDecision(stdout: string): { decision: 'allow' | 'deny'; reason?: string } {
  const root = exactRecord(JSON.parse(stdout), ['hookSpecificOutput'], 'Hook output');
  const output = exactRecord(
    root.hookSpecificOutput,
    ['hookEventName', 'permissionDecision', 'permissionDecisionReason'],
    'hookSpecificOutput',
  );
  if (output.hookEventName !== 'PreToolUse') {
    throw new Error('hookSpecificOutput.hookEventName must be PreToolUse');
  }
  if (output.permissionDecision !== 'allow' && output.permissionDecision !== 'deny') {
    throw new Error('hookSpecificOutput.permissionDecision must be allow or deny');
  }
  if (
    output.permissionDecisionReason !== undefined &&
    typeof output.permissionDecisionReason !== 'string'
  ) {
    throw new Error('hookSpecificOutput.permissionDecisionReason must be a string');
  }
  return {
    decision: output.permissionDecision,
    ...(output.permissionDecisionReason
      ? { reason: boundText(output.permissionDecisionReason, MAX_AUDIT_MESSAGE_CHARS) }
      : {}),
  };
}

function auditFor(
  definition: ResolvedHookDefinition,
  input: PreToolUseHookInput,
  status: HookCompletedAudit['status'],
  durationMs: number,
  message?: string,
): HookCompletedAudit {
  return {
    eventName: 'PreToolUse',
    handlerId: definition.id,
    definitionHash: definition.definitionHash,
    source: definition.source,
    toolUseId: input.tool_use_id,
    toolName: input.tool_name,
    status,
    durationMs,
    ...(message ? { message: boundText(message, MAX_AUDIT_MESSAGE_CHARS) } : {}),
  };
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  worker: (value: T) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error('Hook concurrency must be a positive integer');
  }
  const results = new Array<R>(values.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (next < values.length) {
        const index = next;
        next += 1;
        results[index] = await worker(values[index]!);
      }
    }),
  );
  return results;
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(keys);
  const unknown = Object.keys(record).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`${label} contains unknown field: ${unknown}`);
  return record;
}

function boundText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

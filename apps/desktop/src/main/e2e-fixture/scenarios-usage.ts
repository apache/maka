import type { SessionHeader, StoredMessage } from '@maka/core/session';
import {
  MODEL_CALL_ATTEMPT_SCHEMA_VERSION,
  type ModelCallAttempt,
} from '@maka/core/model-call-attempt';
import type { PersistedToolInvocationRecord } from '@maka/storage';
import {
  resolveStorageRoot,
  tryAcquireInteractiveRootOwner,
} from '@maka/storage/root-authority';
import { openInteractiveUsageStoresForWrite } from '@maka/storage/usage-stores';
import { header } from './seed-helpers.js';

// Settings → 使用统计 fixture. The Usage screen reads the Host-owned SQLite
// stores (canonical model-call ledger + telemetry tool invocations), so this
// scenario seeds those directly instead of writing transcript `token_usage` /
// `tool_call` messages that no scanner aggregates anymore. Session headers stay
// so the request log's "open session" affordance has a target.
//
// The shape intentionally spreads across:
//   - 3 providers (zai-live / relay-fallback / needs-reauth) → 供应商统计
//   - 5 models (glm / claude / gpt families) → 模型统计
//   - reported / partial / missing usage and priced / unpriced cost bases
//   - 8 tool invocations mixing success / error / aborted → 工具统计

interface ModelCallSpec {
  sessionId: string;
  turnId: string;
  connectionSlug: string;
  providerId: string;
  modelId: string;
  minutesAgo: number;
  latencyMs: number;
  usage:
    | { kind: 'reported'; input: number; output: number; cacheRead?: number; cacheMiss?: number; cacheWrite?: number; reasoning?: number }
    | { kind: 'partial'; input: number; cacheMiss?: number }
    | { kind: 'missing' };
  costUsd?: number;
  status?: 'completed' | 'failed';
  errorClass?: string;
}

interface ToolInvocationSpec {
  sessionId: string;
  turnId: string;
  toolCallId: string;
  toolName: string;
  providerId: string;
  modelId: string;
  minutesAgo: number;
  durationMs: number;
  status: 'success' | 'error' | 'aborted';
  bytesIn: number;
  bytesOut: number;
  errorClass?: string;
}

const MODEL_CALLS: readonly ModelCallSpec[] = [
  {
    sessionId: 'e2e-fixture-usage-glm',
    turnId: 'usage-glm-1',
    connectionSlug: 'zai-live',
    providerId: 'zai-live',
    modelId: 'glm-5.1',
    minutesAgo: 45,
    latencyMs: 3_120,
    usage: { kind: 'reported', input: 4_820, output: 1_240, cacheRead: 3_200, cacheMiss: 1_620, cacheWrite: 640, reasoning: 210 },
    costUsd: 0.0186,
  },
  {
    sessionId: 'e2e-fixture-usage-glm',
    turnId: 'usage-glm-2',
    connectionSlug: 'zai-live',
    providerId: 'zai-live',
    modelId: 'glm-5.1-air',
    minutesAgo: 38,
    latencyMs: 1_940,
    usage: { kind: 'partial', input: 2_110, cacheMiss: 2_110 },
  },
  {
    sessionId: 'e2e-fixture-usage-claude',
    turnId: 'usage-claude-1',
    connectionSlug: 'relay-fallback',
    providerId: 'relay-fallback',
    modelId: 'claude-sonnet-4.5',
    minutesAgo: 30,
    latencyMs: 5_410,
    usage: { kind: 'reported', input: 6_400, output: 2_050, cacheRead: 5_100, cacheWrite: 1_300, reasoning: 880 },
    costUsd: 0.0642,
  },
  {
    sessionId: 'e2e-fixture-usage-claude',
    turnId: 'usage-claude-2',
    connectionSlug: 'relay-fallback',
    providerId: 'relay-fallback',
    modelId: 'claude-haiku-4.5',
    minutesAgo: 24,
    latencyMs: 820,
    usage: { kind: 'missing' },
    status: 'failed',
    errorClass: 'RateLimitExceeded',
  },
  {
    sessionId: 'e2e-fixture-usage-gpt',
    turnId: 'usage-gpt-1',
    connectionSlug: 'needs-reauth',
    providerId: 'needs-reauth',
    modelId: 'gpt-5.1-mini',
    minutesAgo: 18,
    latencyMs: 2_740,
    usage: { kind: 'reported', input: 3_300, output: 900, cacheRead: 1_200 },
    costUsd: 0.0125,
  },
];

const TOOL_INVOCATIONS: readonly ToolInvocationSpec[] = [
  { sessionId: 'e2e-fixture-usage-glm', turnId: 'usage-glm-1', toolCallId: 'usage-glm-1-bash', toolName: 'Bash', providerId: 'zai-live', modelId: 'glm-5.1', minutesAgo: 45, durationMs: 8_240, status: 'success', bytesIn: 640, bytesOut: 12_800 },
  { sessionId: 'e2e-fixture-usage-glm', turnId: 'usage-glm-1', toolCallId: 'usage-glm-1-read', toolName: 'Read', providerId: 'zai-live', modelId: 'glm-5.1', minutesAgo: 45, durationMs: 1_120, status: 'success', bytesIn: 2_048, bytesOut: 4_096 },
  { sessionId: 'e2e-fixture-usage-glm', turnId: 'usage-glm-1', toolCallId: 'usage-glm-1-grep', toolName: 'Grep', providerId: 'zai-live', modelId: 'glm-5.1', minutesAgo: 45, durationMs: 640, status: 'success', bytesIn: 128, bytesOut: 512 },
  { sessionId: 'e2e-fixture-usage-glm', turnId: 'usage-glm-2', toolCallId: 'usage-glm-2-edit', toolName: 'Edit', providerId: 'zai-live', modelId: 'glm-5.1-air', minutesAgo: 38, durationMs: 980, status: 'success', bytesIn: 3_200, bytesOut: 6_400 },
  { sessionId: 'e2e-fixture-usage-glm', turnId: 'usage-glm-2', toolCallId: 'usage-glm-2-write', toolName: 'Write', providerId: 'zai-live', modelId: 'glm-5.1-air', minutesAgo: 38, durationMs: 1_460, status: 'error', bytesIn: 1_024, bytesOut: 0, errorClass: 'WriteToolFailed' },
  { sessionId: 'e2e-fixture-usage-claude', turnId: 'usage-claude-1', toolCallId: 'usage-claude-1-search', toolName: 'WebSearch', providerId: 'relay-fallback', modelId: 'claude-sonnet-4.5', minutesAgo: 30, durationMs: 3_050, status: 'aborted', bytesIn: 0, bytesOut: 0 },
  { sessionId: 'e2e-fixture-usage-claude', turnId: 'usage-claude-1', toolCallId: 'usage-claude-1-read', toolName: 'Read', providerId: 'relay-fallback', modelId: 'claude-sonnet-4.5', minutesAgo: 30, durationMs: 900, status: 'success', bytesIn: 4_096, bytesOut: 8_192 },
  { sessionId: 'e2e-fixture-usage-gpt', turnId: 'usage-gpt-1', toolCallId: 'usage-gpt-1-bash', toolName: 'Bash', providerId: 'needs-reauth', modelId: 'gpt-5.1-mini', minutesAgo: 18, durationMs: 6_400, status: 'success', bytesIn: 512, bytesOut: 9_600 },
];

function usageSession(
  now: number,
  input: { id: string; name: string; connection: string; model: string; minutesAgo: number },
): SessionHeader {
  return header({
    id: input.id,
    name: input.name,
    connection: input.connection,
    model: input.model,
    now,
    lastMessageAt: now - input.minutesAgo * 60_000,
  });
}

function sessionMessages(
  now: number,
  sessionId: string,
  modelId: string,
  minutesAgo: number,
): StoredMessage[] {
  const turnTs = now - minutesAgo * 60_000;
  return [
    {
      type: 'user',
      id: `${sessionId}-user`,
      turnId: `${sessionId}-turn`,
      ts: turnTs - 30_000,
      text: '继续这轮工作，并汇总一次用量。',
    },
    {
      type: 'assistant',
      id: `${sessionId}-assistant`,
      turnId: `${sessionId}-turn`,
      ts: turnTs,
      text: '这一轮的模型请求与工具调用已完成，用量已并入统计。',
      modelId,
    },
  ];
}

export function usageStatsSessions(
  now: number,
): Array<{ header: SessionHeader; messages: StoredMessage[] }> {
  return [
    {
      header: usageSession(now, {
        id: 'e2e-fixture-usage-glm',
        name: '用量样本 · GLM 工作区',
        connection: 'zai-live',
        model: 'glm-5.1',
        minutesAgo: 40,
      }),
      messages: sessionMessages(now, 'e2e-fixture-usage-glm', 'glm-5.1', 40),
    },
    {
      header: usageSession(now, {
        id: 'e2e-fixture-usage-claude',
        name: '用量样本 · Claude 中继',
        connection: 'relay-fallback',
        model: 'claude-sonnet-4.5',
        minutesAgo: 28,
      }),
      messages: sessionMessages(now, 'e2e-fixture-usage-claude', 'claude-sonnet-4.5', 28),
    },
    {
      header: usageSession(now, {
        id: 'e2e-fixture-usage-gpt',
        name: '用量样本 · GPT 备用',
        connection: 'needs-reauth',
        model: 'gpt-5.1-mini',
        minutesAgo: 16,
      }),
      messages: sessionMessages(now, 'e2e-fixture-usage-gpt', 'gpt-5.1-mini', 16),
    },
  ];
}

/** Seeds the Host-owned Usage stores the settings screen actually reads. */
export async function seedUsageStatsFixture(workspaceRoot: string, now: number): Promise<void> {
  const capability = await resolveStorageRoot({ path: workspaceRoot, kind: 'interactive' });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  if (!owner) {
    throw new Error('e2e fixture could not acquire the interactive Usage write lease');
  }
  const stores = await openInteractiveUsageStoresForWrite(owner.lease);
  try {
    await Promise.all([
      ...MODEL_CALLS.map((spec) => stores.modelCalls.recordModelCallAttempt(modelCallAttempt(now, spec))),
      ...TOOL_INVOCATIONS.map((spec) =>
        stores.telemetry.recordToolInvocation(toolInvocationRecord(now, spec)),
      ),
    ]);
  } finally {
    await stores.close().catch(() => undefined);
    await owner.close();
  }
}

function modelCallAttempt(now: number, spec: ModelCallSpec): ModelCallAttempt {
  const completedAt = now - spec.minutesAgo * 60_000;
  const reported = spec.usage.kind === 'reported' ? spec.usage : undefined;
  const partial = spec.usage.kind === 'partial' ? spec.usage : undefined;
  return {
    schemaVersion: MODEL_CALL_ATTEMPT_SCHEMA_VERSION,
    logicalCallId: `${spec.turnId}-call`,
    attemptId: `${spec.turnId}-attempt`,
    traceId: `${spec.turnId}-trace`,
    sessionId: spec.sessionId,
    runId: `${spec.sessionId}-run`,
    turnId: spec.turnId,
    step: 0,
    attempt: 0,
    callKind: 'main',
    connectionSlug: spec.connectionSlug,
    providerId: spec.providerId,
    modelId: spec.modelId,
    startedAt: completedAt - spec.latencyMs,
    completedAt,
    latencyMs: spec.latencyMs,
    status: spec.status ?? 'completed',
    ...(spec.errorClass !== undefined ? { errorClass: spec.errorClass } : {}),
    usageBasis: spec.usage.kind,
    ...(reported !== undefined
      ? {
          inputTokens: reported.input,
          outputTokens: reported.output,
          ...(reported.cacheRead !== undefined ? { cacheReadInputTokens: reported.cacheRead } : {}),
          ...(reported.cacheMiss !== undefined ? { cacheMissInputTokens: reported.cacheMiss } : {}),
          ...(reported.cacheWrite !== undefined ? { cacheWriteInputTokens: reported.cacheWrite } : {}),
          ...(reported.reasoning !== undefined ? { reasoningTokens: reported.reasoning } : {}),
        }
      : {}),
    ...(partial !== undefined
      ? {
          inputTokens: partial.input,
          ...(partial.cacheMiss !== undefined ? { cacheMissInputTokens: partial.cacheMiss } : {}),
        }
      : {}),
    costBasis: spec.costUsd === undefined ? 'unpriced' : 'priced',
    ...(spec.costUsd !== undefined ? { costUsd: spec.costUsd } : {}),
  };
}

function toolInvocationRecord(now: number, spec: ToolInvocationSpec): PersistedToolInvocationRecord {
  const ts = now - spec.minutesAgo * 60_000;
  return {
    id: spec.toolCallId,
    sessionId: spec.sessionId,
    turnId: spec.turnId,
    toolCallId: spec.toolCallId,
    toolName: spec.toolName,
    providerId: spec.providerId,
    modelId: spec.modelId,
    durationMs: spec.durationMs,
    status: spec.status,
    ...(spec.errorClass !== undefined ? { errorClass: spec.errorClass } : {}),
    bytesIn: spec.bytesIn,
    bytesOut: spec.bytesOut,
    date: new Date(ts).toISOString().slice(0, 10),
    ts,
    startedAt: ts - spec.durationMs,
  };
}

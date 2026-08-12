import { isSessionInlineRun, type AgentRunStore } from '@maka/core/agent-run';
import {
  validateHistoryCompactCheckpointShape,
  type HistoryCompactCheckpoint,
} from './history-compact-checkpoint.js';

export type ContextDiagnosticsUnavailableReason = 'no_completed_request' | 'trace_unavailable';

export interface ContextDiagnosticsSegment {
  kind: 'system_instructions' | 'tool_definitions' | 'messages' | 'other';
  bytes: number;
  estimatedTokens: number;
}

export interface ContextDiagnosticsCompaction {
  kind: 'history';
  phase: 'pre_turn' | 'mid_turn';
  eventCount: number;
  turnCount: number;
  estimatedTokens: number;
}

export type ContextDiagnostics =
  | {
      status: 'unavailable';
      reason: ContextDiagnosticsUnavailableReason;
    }
  | {
      status: 'available';
      providerId: string;
      modelId: string;
      completedAt: number;
      inputTokens?: number;
      contextWindow?: number;
      segments: ContextDiagnosticsSegment[];
      compaction?: ContextDiagnosticsCompaction;
    };

export async function readLatestContextDiagnostics(
  runStore: Pick<AgentRunStore, 'listSessionRuns' | 'readEvents'>,
  sessionId: string,
): Promise<ContextDiagnostics> {
  try {
    // ponytail: command-time O(session ledger); add a completed-attempt projection if measured.
    const runs = (await runStore.listSessionRuns(sessionId)).filter(isSessionInlineRun);
    let latestCompleted: { ts: number; attempt: AttemptCandidate | undefined } | undefined;
    const checkpoints: CheckpointCandidate[] = [];
    for (const run of runs) {
      const events = await runStore.readEvents(sessionId, run.runId);
      for (const event of events) {
        const checkpoint = event.data?.checkpoint;
        if (
          event.type === 'history_compact_checkpoint_recorded' &&
          validateHistoryCompactCheckpointShape(checkpoint, sessionId)
        ) {
          checkpoints.push({ eventId: event.id, ts: event.ts, checkpoint });
          continue;
        }
        if (event.type !== 'provider_request_attempt_recorded') continue;
        if (event.data?.status !== 'completed') continue;
        const completed = { ts: event.ts, attempt: attemptCandidate(event.data) };
        if (!latestCompleted || completed.ts >= latestCompleted.ts) {
          latestCompleted = completed;
        }
      }
    }
    if (!latestCompleted) return { status: 'unavailable', reason: 'no_completed_request' };
    if (!latestCompleted.attempt) return { status: 'unavailable', reason: 'trace_unavailable' };
    const latest = latestCompleted.attempt;
    const checkpoint = checkpoints
      .filter((candidate) => candidate.ts <= latest.startedAt)
      .sort(
        (left, right) => right.ts - left.ts || right.eventId.localeCompare(left.eventId),
      )[0]?.checkpoint;
    return {
      status: 'available',
      providerId: latest.providerId,
      modelId: latest.modelId,
      completedAt: latest.completedAt,
      ...(latest.inputTokens !== undefined ? { inputTokens: latest.inputTokens } : {}),
      ...(latest.contextWindow !== undefined ? { contextWindow: latest.contextWindow } : {}),
      segments: latest.segments,
      ...(checkpoint
        ? {
            compaction: {
              kind: 'history',
              phase: checkpoint.phase === 'mid_turn' ? 'mid_turn' : 'pre_turn',
              eventCount: checkpoint.coverage.eventCount,
              turnCount: checkpoint.coverage.turnCount,
              estimatedTokens: checkpoint.estimatedTokens,
            } satisfies ContextDiagnosticsCompaction,
          }
        : {}),
    };
  } catch {
    return { status: 'unavailable', reason: 'trace_unavailable' };
  }
}

interface AttemptCandidate {
  providerId: string;
  modelId: string;
  startedAt: number;
  completedAt: number;
  inputTokens?: number;
  contextWindow?: number;
  segments: ContextDiagnosticsSegment[];
}

interface CheckpointCandidate {
  eventId: string;
  ts: number;
  checkpoint: HistoryCompactCheckpoint;
}

function attemptCandidate(data: Record<string, unknown> | undefined): AttemptCandidate | undefined {
  if (
    data?.status !== 'completed' ||
    typeof data.providerId !== 'string' ||
    typeof data.modelId !== 'string' ||
    !isNonNegativeNumber(data.startedAt) ||
    !isNonNegativeNumber(data.completedAt) ||
    !Array.isArray(data.segments) ||
    (data.inputTokens !== undefined && !isNonNegativeInteger(data.inputTokens)) ||
    (data.contextWindow !== undefined && !isPositiveInteger(data.contextWindow))
  ) {
    return undefined;
  }
  const segments = contextSegmentEstimates(data.segments);
  if (!segments) return undefined;
  return {
    providerId: data.providerId,
    modelId: data.modelId,
    startedAt: data.startedAt,
    completedAt: data.completedAt,
    ...(data.inputTokens !== undefined ? { inputTokens: data.inputTokens as number } : {}),
    ...(data.contextWindow !== undefined ? { contextWindow: data.contextWindow as number } : {}),
    segments,
  };
}

function contextSegmentEstimates(segments: unknown[]): ContextDiagnosticsSegment[] | undefined {
  const bytes = new Map<ContextDiagnosticsSegment['kind'], number>();
  for (const segment of segments) {
    if (!segment || typeof segment !== 'object') return undefined;
    const value = segment as Record<string, unknown>;
    const kind = contextSegmentKind(value.kind);
    if (!kind || !isNonNegativeInteger(value.bytes)) return undefined;
    bytes.set(kind, (bytes.get(kind) ?? 0) + value.bytes);
  }
  const order: ContextDiagnosticsSegment['kind'][] = [
    'system_instructions',
    'tool_definitions',
    'messages',
    'other',
  ];
  return order.flatMap((kind) => {
    const value = bytes.get(kind) ?? 0;
    return value > 0 ? [{ kind, bytes: value, estimatedTokens: Math.ceil(value / 4) }] : [];
  });
}

function contextSegmentKind(value: unknown): ContextDiagnosticsSegment['kind'] | undefined {
  if (value === 'system_prompt') return 'system_instructions';
  if (value === 'tool_schema') return 'tool_definitions';
  if (value === 'message') return 'messages';
  if (value === 'provider_options') return 'other';
  return undefined;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0;
}

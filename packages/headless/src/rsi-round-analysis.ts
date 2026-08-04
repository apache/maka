import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import type { FixedPromptTaskWalEvent } from './fixed-prompt-wal-types.js';

const DEFAULT_MAX_TOOL_FAILURE_CLUSTERS = 10;
const DEFAULT_MAX_TOOL_FAILURE_JSONL_BYTES = 1_000_000;
const DEFAULT_MAX_TOOL_FAILURE_JSONL_LINES = 10_000;
const DEFAULT_MAX_TOOL_FAILURE_EVENTS_PER_TASK = 1_000;
const DEFAULT_MAX_TOOL_FAILURE_ARGS_KEYS = 8;

export type RsiTaskOutcome =
  | 'pass'
  | 'fail'
  | 'unscored'
  | 'infra'
  | 'budget'
  | 'plumbing'
  | 'missing';

export interface RsiTaskTransition {
  taskId: string;
  from: RsiTaskOutcome;
  to: RsiTaskOutcome;
}

export interface RsiErrorClassCount {
  errorClass: string;
  count: number;
}

export interface RsiToolFailureCluster {
  name: string;
  count: number;
  taskIds: string[];
  errorClass?: string;
  argsPreview?: string;
}

export type RsiTraceUnavailableSource = 'runtime' | 'trace';

export type RsiTraceUnavailableReason =
  | 'missing_path'
  | 'missing_file'
  | 'invalid_jsonl'
  | 'input_limit_exceeded'
  | 'unreadable';

export type RsiAnalysisSignal =
  | {
      id: string;
      kind: 'transition';
      taskIds: string[];
      basis: 'last_kept' | 'previous_candidate';
      transition: RsiTaskTransition;
    }
  | {
      id: string;
      kind: 'coverage_regression';
      taskIds: string[];
    }
  | {
      id: string;
      kind: 'error_class';
      taskIds: string[];
      errorClass: string;
      count: number;
    }
  | {
      id: string;
      kind: 'tool_failure_cluster';
      taskIds: string[];
      cluster: RsiToolFailureCluster;
    }
  | {
      id: string;
      kind: 'trace_unavailable';
      taskIds: string[];
      source: RsiTraceUnavailableSource;
      reason: RsiTraceUnavailableReason;
    };

export interface RsiRoundAnalysis {
  heldInTaskSetHash: string;
  transitionVsLastKept: RsiTaskTransition[];
  transitionVsPreviousCandidate: RsiTaskTransition[];
  coverageRegressionTaskIds: string[];
  errorClassDistribution: RsiErrorClassCount[];
  toolFailureClusters: RsiToolFailureCluster[];
  signals: RsiAnalysisSignal[];
}

export interface AnalyzeRsiRoundInput {
  heldInTaskIds: readonly string[];
  lastKeptEvents: readonly FixedPromptTaskWalEvent[];
  previousCandidateEvents?: readonly FixedPromptTaskWalEvent[];
  candidateEvents: readonly FixedPromptTaskWalEvent[];
  limits?: {
    maxToolFailureClusters?: number;
  };
}

interface RsiErrorClassGroup extends RsiErrorClassCount {
  taskIds: string[];
}

interface RsiTraceUnavailableGroup {
  taskIds: string[];
  source: RsiTraceUnavailableSource;
  reason: RsiTraceUnavailableReason;
}

interface NormalizedToolFailureLimits {
  maxClusters: number;
  maxJsonlBytes: number;
  maxJsonlLines: number;
  maxEventsPerTask: number;
  maxArgsKeys: number;
}

interface ToolFailureClusterResult {
  clusters: RsiToolFailureCluster[];
  traceUnavailable: RsiTraceUnavailableGroup[];
}

type BoundedJsonlResult =
  | { ok: true; events: unknown[] }
  | { ok: false; reason: RsiTraceUnavailableReason };

type FunctionCallsByIdResult =
  | { ok: true; value: Map<string, { name: string; argsPreview: string }> }
  | { ok: false; reason: RsiTraceUnavailableReason };

export async function analyzeRsiRound(input: AnalyzeRsiRoundInput): Promise<RsiRoundAnalysis> {
  const heldInTaskIds = sortedUnique(input.heldInTaskIds);
  const lastKeptByTask = eventsByHeldInTask(input.lastKeptEvents, heldInTaskIds);
  const candidateByTask = eventsByHeldInTask(input.candidateEvents, heldInTaskIds);
  const transitionVsLastKept = taskTransitions(heldInTaskIds, lastKeptByTask, candidateByTask);
  const transitionVsPreviousCandidate = input.previousCandidateEvents
    ? taskTransitions(
        heldInTaskIds,
        eventsByHeldInTask(input.previousCandidateEvents, heldInTaskIds),
        candidateByTask,
      )
    : [];
  const coverageRegressionTaskIds = heldInTaskIds.filter(
    (taskId) => isCovered(lastKeptByTask.get(taskId)) && !isCovered(candidateByTask.get(taskId)),
  );
  const errorGroups = safeErrorClassGroups(heldInTaskIds, candidateByTask);
  const toolFailures = await toolFailureClusters(
    heldInTaskIds,
    candidateByTask,
    normalizeToolFailureLimits(input.limits),
  );
  return {
    heldInTaskSetHash: heldInTaskSetHash(heldInTaskIds),
    transitionVsLastKept,
    transitionVsPreviousCandidate,
    coverageRegressionTaskIds,
    errorClassDistribution: errorGroups.map(({ taskIds: _taskIds, ...group }) => group),
    toolFailureClusters: toolFailures.clusters,
    signals: analysisSignals({
      transitionVsLastKept,
      transitionVsPreviousCandidate,
      coverageRegressionTaskIds,
      errorGroups,
      toolFailureClusters: toolFailures.clusters,
      traceUnavailable: toolFailures.traceUnavailable,
    }),
  };
}

export function heldInTaskSetHash(taskIds: readonly string[]): string {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(sortedUnique(taskIds)))
    .digest('hex')}`;
}

function taskTransitions(
  heldInTaskIds: readonly string[],
  previous: ReadonlyMap<string, FixedPromptTaskWalEvent>,
  current: ReadonlyMap<string, FixedPromptTaskWalEvent>,
): RsiTaskTransition[] {
  return heldInTaskIds.flatMap((taskId) => {
    const from = taskOutcome(previous.get(taskId));
    const to = taskOutcome(current.get(taskId));
    return from === to ? [] : [{ taskId, from, to }];
  });
}

function taskOutcome(event: FixedPromptTaskWalEvent | undefined): RsiTaskOutcome {
  if (!event) return 'missing';
  if (event.type === 'task_infra_failed') return 'infra';
  if (event.type === 'task_plumbing_failed') return 'plumbing';
  // A budget exhaustion the verifier graded carries a real score, so it reads
  // as that score. `budget` is for the ones that ran out with no verdict —
  // otherwise a graded pass would be attributed to the prompt as a flip away
  // from passing.
  if (event.type === 'task_budget_exhausted' && !(event.eligible && event.scored)) return 'budget';
  if (!event.eligible || !event.scored) return 'unscored';
  return event.passed ? 'pass' : 'fail';
}

/** Coverage is whether the round produced a score for the task, so it asks the
 * event's own fields rather than its type. A verifier-graded budget exhaustion
 * is covered: the score exists, and calling it a coverage regression would
 * charge the candidate prompt for evidence that is on disk. */
function isCovered(event: FixedPromptTaskWalEvent | undefined): boolean {
  return event !== undefined && event.eligible && event.scored;
}

function safeErrorClassGroups(
  heldInTaskIds: readonly string[],
  events: ReadonlyMap<string, FixedPromptTaskWalEvent>,
): RsiErrorClassGroup[] {
  const groups = new Map<string, RsiErrorClassGroup>();
  for (const taskId of heldInTaskIds) {
    const errorClass = events.get(taskId)?.errorClass;
    if (!errorClass) continue;
    const safeErrorClass = promptSafeToken(errorClass, 'unknown_error');
    const current = groups.get(safeErrorClass) ?? {
      errorClass: safeErrorClass,
      count: 0,
      taskIds: [],
    };
    current.count += 1;
    current.taskIds.push(taskId);
    groups.set(safeErrorClass, current);
  }
  return [...groups.values()]
    .map((group) => ({ ...group, taskIds: [...group.taskIds].sort(compareStrings) }))
    .sort((a, b) => b.count - a.count || compareStrings(a.errorClass, b.errorClass));
}

function analysisSignals(input: {
  transitionVsLastKept: readonly RsiTaskTransition[];
  transitionVsPreviousCandidate: readonly RsiTaskTransition[];
  coverageRegressionTaskIds: readonly string[];
  errorGroups: readonly RsiErrorClassGroup[];
  toolFailureClusters: readonly RsiToolFailureCluster[];
  traceUnavailable: readonly RsiTraceUnavailableGroup[];
}): RsiAnalysisSignal[] {
  const transitionTaskIds = new Set([
    ...input.transitionVsLastKept.map((transition) => transition.taskId),
    ...input.transitionVsPreviousCandidate.map((transition) => transition.taskId),
  ]);
  const toolFailureEvidenceClusters = input.toolFailureClusters.filter((cluster) =>
    cluster.taskIds.every((taskId) => !transitionTaskIds.has(taskId)),
  );
  return [
    ...input.transitionVsLastKept.map((transition) => transitionSignal('last_kept', transition)),
    ...input.transitionVsPreviousCandidate.map((transition) =>
      transitionSignal('previous_candidate', transition),
    ),
    ...(input.coverageRegressionTaskIds.length > 0
      ? [
          withSignalId({
            kind: 'coverage_regression' as const,
            taskIds: [...input.coverageRegressionTaskIds],
          }),
        ]
      : []),
    ...input.errorGroups.map(({ errorClass, count, taskIds }) =>
      withSignalId({
        kind: 'error_class' as const,
        taskIds: [...taskIds],
        errorClass,
        count,
      }),
    ),
    ...toolFailureEvidenceClusters.map((cluster) =>
      withSignalId({
        kind: 'tool_failure_cluster' as const,
        taskIds: cluster.taskIds,
        cluster,
      }),
    ),
    ...input.traceUnavailable.map((unavailable) =>
      withSignalId({
        kind: 'trace_unavailable' as const,
        taskIds: unavailable.taskIds,
        source: unavailable.source,
        reason: unavailable.reason,
      }),
    ),
  ];
}

function transitionSignal(
  basis: 'last_kept' | 'previous_candidate',
  transition: RsiTaskTransition,
): RsiAnalysisSignal {
  return withSignalId({
    kind: 'transition' as const,
    taskIds: [transition.taskId],
    basis,
    transition,
  });
}

function withSignalId<T extends Omit<RsiAnalysisSignal, 'id'>>(signal: T): T & { id: string } {
  return {
    id: `rsi-sig:${createHash('sha256').update(JSON.stringify(signal)).digest('hex').slice(0, 16)}`,
    ...signal,
  };
}

function eventsByHeldInTask(
  events: readonly FixedPromptTaskWalEvent[],
  heldInTaskIds: readonly string[],
): Map<string, FixedPromptTaskWalEvent> {
  const heldIn = new Set(heldInTaskIds);
  const byTask = new Map<string, FixedPromptTaskWalEvent>();
  for (const event of events) {
    if (heldIn.has(event.taskId)) byTask.set(event.taskId, event);
  }
  return byTask;
}

async function toolFailureClusters(
  heldInTaskIds: readonly string[],
  events: ReadonlyMap<string, FixedPromptTaskWalEvent>,
  limits: NormalizedToolFailureLimits,
): Promise<ToolFailureClusterResult> {
  const clusters = new Map<string, RsiToolFailureCluster & { taskIdSet: Set<string> }>();
  const traceUnavailable = new Map<string, RsiTraceUnavailableGroup & { taskIdSet: Set<string> }>();
  if (limits.maxClusters === 0) return { clusters: [], traceUnavailable: [] };
  for (const taskId of heldInTaskIds) {
    const event = events.get(taskId);
    if (!event || !hasRuntimePath(event)) continue;
    if (event.type === 'task_completed' && event.eligible && event.scored && event.passed) continue;
    if (!hasTracePath(event)) {
      addTraceUnavailable(traceUnavailable, taskId, 'trace', 'missing_path');
      continue;
    }
    const traceEvents = await readBoundedJsonl(event.traceEventsPath, limits);
    if (!traceEvents.ok) {
      addTraceUnavailable(traceUnavailable, taskId, 'trace', traceEvents.reason);
      continue;
    }
    const callsById = await functionCallsById(event.runtimeEventsPath, limits);
    if (!callsById.ok) addTraceUnavailable(traceUnavailable, taskId, 'runtime', callsById.reason);
    const calls = callsById.ok
      ? callsById.value
      : new Map<string, { name: string; argsPreview: string }>();
    let failureEvents = 0;
    for (const traceEvent of traceEvents.events) {
      if (failureEvents >= limits.maxEventsPerTask) break;
      const failure = toolFailureDigest(traceEvent, calls);
      if (!failure) continue;
      failureEvents += 1;
      const key = [failure.name, failure.errorClass ?? '', failure.argsPreview ?? ''].join('\0');
      const current = clusters.get(key) ?? {
        ...failure,
        count: 0,
        taskIds: [],
        taskIdSet: new Set<string>(),
      };
      current.count += 1;
      current.taskIdSet.add(taskId);
      clusters.set(key, current);
    }
  }

  return {
    clusters: [...clusters.values()]
      .map(({ taskIdSet, ...cluster }) => ({
        ...cluster,
        taskIds: [...taskIdSet].sort(compareStrings),
      }))
      .sort(compareToolFailureClusters)
      .slice(0, limits.maxClusters),
    traceUnavailable: [...traceUnavailable.values()]
      .map(({ taskIdSet, ...group }) => ({
        ...group,
        taskIds: [...taskIdSet].sort(compareStrings),
      }))
      .sort(compareTraceUnavailable),
  };
}

async function functionCallsById(
  path: string,
  limits: NormalizedToolFailureLimits,
): Promise<FunctionCallsByIdResult> {
  const runtimeEvents = await readProjectedJsonl(path, limits, isFunctionCallEvent);
  if (!runtimeEvents.ok) return runtimeEvents;
  const calls = new Map<string, { name: string; argsPreview: string }>();
  for (const event of runtimeEvents.events) {
    if (!isRecord(event) || !isRecord(event.content)) continue;
    const content = event.content;
    if (
      content.kind !== 'function_call' ||
      typeof content.id !== 'string' ||
      typeof content.name !== 'string'
    )
      continue;
    calls.set(content.id, {
      name: promptSafeToken(content.name, 'unknown_tool'),
      argsPreview: argsPreview(content.args, limits.maxArgsKeys),
    });
  }
  return { ok: true, value: calls };
}

async function readProjectedJsonl(
  path: string,
  limits: NormalizedToolFailureLimits,
  keepEvent: (event: unknown) => boolean,
): Promise<BoundedJsonlResult> {
  const events: unknown[] = [];
  let keptBytes = 0;
  const stream = createReadStream(path, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (line.trim().length === 0) continue;
      let event: unknown;
      try {
        event = JSON.parse(line) as unknown;
      } catch {
        return { ok: false, reason: 'invalid_jsonl' };
      }
      if (!keepEvent(event)) continue;
      keptBytes += Buffer.byteLength(line, 'utf8');
      if (keptBytes > limits.maxJsonlBytes || events.length + 1 > limits.maxJsonlLines) {
        return { ok: false, reason: 'input_limit_exceeded' };
      }
      events.push(event);
    }
  } catch (error) {
    return { ok: false, reason: isNotFound(error) ? 'missing_file' : 'unreadable' };
  } finally {
    lines.close();
    stream.destroy();
  }
  return { ok: true, events };
}

async function readBoundedJsonl(
  path: string,
  limits: NormalizedToolFailureLimits,
): Promise<BoundedJsonlResult> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch (error) {
    return { ok: false, reason: isNotFound(error) ? 'missing_file' : 'unreadable' };
  }
  if (size > limits.maxJsonlBytes) return { ok: false, reason: 'input_limit_exceeded' };

  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    return { ok: false, reason: isNotFound(error) ? 'missing_file' : 'unreadable' };
  }
  if (Buffer.byteLength(raw, 'utf8') > limits.maxJsonlBytes) {
    return { ok: false, reason: 'input_limit_exceeded' };
  }
  const lines = raw.split('\n').filter((line) => line.trim().length > 0);
  if (lines.length > limits.maxJsonlLines) return { ok: false, reason: 'input_limit_exceeded' };

  const events: unknown[] = [];
  for (const line of lines) {
    try {
      events.push(JSON.parse(line) as unknown);
    } catch {
      return { ok: false, reason: 'invalid_jsonl' };
    }
  }
  return { ok: true, events };
}

function isFunctionCallEvent(event: unknown): boolean {
  return isRecord(event) && isRecord(event.content) && event.content.kind === 'function_call';
}

function toolFailureDigest(
  event: unknown,
  callsById: ReadonlyMap<string, { name: string; argsPreview: string }>,
): Omit<RsiToolFailureCluster, 'count' | 'taskIds'> | undefined {
  if (!isRecord(event) || !isRecord(event.data)) return undefined;
  const data = event.data;
  const isFailedEvent = event.type === 'tool_failed';
  const isFailedCompletion =
    event.type === 'tool_completed' && (data.status === 'error' || data.status === 'aborted');
  if (!isFailedEvent && !isFailedCompletion) return undefined;
  if (typeof data.toolName !== 'string') return undefined;
  const call = typeof data.toolUseId === 'string' ? callsById.get(data.toolUseId) : undefined;
  return {
    name: promptSafeToken(data.toolName, 'unknown_tool'),
    ...(typeof data.errorClass === 'string'
      ? { errorClass: promptSafeToken(data.errorClass, 'unknown_error') }
      : {}),
    ...(call?.argsPreview ? { argsPreview: call.argsPreview } : {}),
  };
}

function compareToolFailureClusters(a: RsiToolFailureCluster, b: RsiToolFailureCluster): number {
  return (
    b.count - a.count ||
    compareStrings(a.name, b.name) ||
    compareStrings(a.errorClass ?? '', b.errorClass ?? '') ||
    compareStrings(a.argsPreview ?? '', b.argsPreview ?? '') ||
    compareStrings(a.taskIds.join(','), b.taskIds.join(','))
  );
}

function compareTraceUnavailable(a: RsiTraceUnavailableGroup, b: RsiTraceUnavailableGroup): number {
  return (
    compareStrings(a.source, b.source) ||
    compareStrings(a.reason, b.reason) ||
    compareStrings(a.taskIds.join(','), b.taskIds.join(','))
  );
}

function argsPreview(args: unknown, maxKeys: number): string {
  if (!isRecord(args)) return typeof args;
  if (maxKeys === 0) return '';
  return Object.keys(args)
    .map((key) => promptSafeToken(key, 'arg'))
    .sort(compareStrings)
    .slice(0, maxKeys)
    .join(',');
}

function addTraceUnavailable(
  groups: Map<string, RsiTraceUnavailableGroup & { taskIdSet: Set<string> }>,
  taskId: string,
  source: RsiTraceUnavailableSource,
  reason: RsiTraceUnavailableReason,
): void {
  const key = `${source}\0${reason}`;
  const current = groups.get(key) ?? { source, reason, taskIds: [], taskIdSet: new Set<string>() };
  current.taskIdSet.add(taskId);
  groups.set(key, current);
}

function hasRuntimePath(
  event: FixedPromptTaskWalEvent,
): event is FixedPromptTaskWalEvent & { runtimeEventsPath: string } {
  return 'runtimeEventsPath' in event && typeof event.runtimeEventsPath === 'string';
}

function hasTracePath(
  event: FixedPromptTaskWalEvent,
): event is FixedPromptTaskWalEvent & { traceEventsPath: string } {
  return 'traceEventsPath' in event && typeof event.traceEventsPath === 'string';
}

function normalizeToolFailureLimits(
  limits: AnalyzeRsiRoundInput['limits'],
): NormalizedToolFailureLimits {
  return {
    maxClusters: nonNegativeInt(limits?.maxToolFailureClusters, DEFAULT_MAX_TOOL_FAILURE_CLUSTERS),
    maxJsonlBytes: DEFAULT_MAX_TOOL_FAILURE_JSONL_BYTES,
    maxJsonlLines: DEFAULT_MAX_TOOL_FAILURE_JSONL_LINES,
    maxEventsPerTask: DEFAULT_MAX_TOOL_FAILURE_EVENTS_PER_TASK,
    maxArgsKeys: DEFAULT_MAX_TOOL_FAILURE_ARGS_KEYS,
  };
}

function nonNegativeInt(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.trunc(value));
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function promptSafeToken(value: string, fallback: string): string {
  if (/^[A-Za-z0-9_.:-]{1,64}$/.test(value)) return value;
  return fallback;
}

function isNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareStrings);
}

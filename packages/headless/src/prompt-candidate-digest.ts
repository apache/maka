import { readFile } from 'node:fs/promises';

export interface TrajectoryDigest {
  taskId: string;
  errorClass?: string;
  summary: string;
  recentToolCalls?: readonly TrajectoryToolCallDigest[];
  toolFailures?: readonly TrajectoryToolFailureDigest[];
}

export interface TrajectoryToolCallDigest {
  name: string;
  argsPreview: string;
}

export interface TrajectoryToolFailureDigest {
  name: string;
  count: number;
  errorClass?: string;
  argsPreview?: string;
}

export interface ExtractTrajectoryDigestInput {
  taskId: string;
  errorClass?: string;
  runtimeEventsPath: string;
  traceEventsPath?: string;
  verifierSummary: string;
}

export async function extractTrajectoryDigest(
  input: ExtractTrajectoryDigestInput,
): Promise<TrajectoryDigest> {
  const events = await readRuntimeEventsJsonl(input.runtimeEventsPath);
  const callsById = new Map<string, TrajectoryToolCallDigest>();
  for (const event of events) {
    const call = functionCallDigestWithId(event);
    if (call) callsById.set(call.id, { name: call.name, argsPreview: call.argsPreview });
  }
  const recentToolCalls = events
    .map((event) => functionCallDigest(event))
    .filter((call): call is TrajectoryToolCallDigest => call !== undefined)
    .slice(-2);
  const toolFailures = input.traceEventsPath
    ? await extractToolFailureDigests(input.traceEventsPath, callsById)
    : [];
  return {
    taskId: input.taskId,
    ...(input.errorClass ? { errorClass: input.errorClass } : {}),
    summary: input.verifierSummary,
    ...(recentToolCalls.length > 0 ? { recentToolCalls } : {}),
    ...(toolFailures.length > 0 ? { toolFailures } : {}),
  };
}

export function renderToolFailureSummary(
  digests: readonly TrajectoryDigest[],
  resultsTsv: string,
): string[] {
  const passedByTask = passedResultsByTask(resultsTsv);
  const failures = new Map<string, { digest: TrajectoryToolFailureDigest; taskIds: Set<string> }>();
  for (const digest of digests) {
    if (passedByTask?.get(digest.taskId) === true) continue;
    for (const failure of digest.toolFailures ?? []) {
      const key = [failure.name, failure.errorClass ?? '', failure.argsPreview ?? ''].join('\0');
      const current = failures.get(key) ?? {
        digest: { ...failure, count: 0 },
        taskIds: new Set<string>(),
      };
      current.digest = { ...failure, count: current.digest.count + failure.count };
      current.taskIds.add(digest.taskId);
      failures.set(key, current);
    }
  }
  const lines = [...failures.values()]
    .sort((a, b) => compareToolFailures(a.digest, b.digest))
    .slice(0, 10)
    .map(({ digest, taskIds }) =>
      [
        `${digest.name} x${digest.count}`,
        ...(digest.errorClass ? [`error=${digest.errorClass}`] : []),
        ...(digest.argsPreview ? [`args=${digest.argsPreview}`] : []),
        `tasks=${[...taskIds].sort((a, b) => a.localeCompare(b)).join(',')}`,
      ].join(' '),
    );
  return lines.length > 0 ? ['# Held-In Tool Failure Summary', ...lines] : [];
}

export function stripPromptOnlyToolFailures(
  digests: readonly TrajectoryDigest[],
): readonly Omit<TrajectoryDigest, 'toolFailures'>[] {
  return digests.map(({ toolFailures: _toolFailures, ...digest }) => digest);
}

export async function readRuntimeEventsJsonl(path: string): Promise<unknown[]> {
  const raw = await readFile(path, 'utf8');
  return raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

async function extractToolFailureDigests(
  traceEventsPath: string,
  callsById: ReadonlyMap<string, TrajectoryToolCallDigest>,
): Promise<TrajectoryToolFailureDigest[]> {
  let events: unknown[];
  try {
    events = await readRuntimeEventsJsonl(traceEventsPath);
  } catch (error) {
    if (!isNotFound(error)) throw error;
    return [];
  }
  const failures = new Map<string, TrajectoryToolFailureDigest>();
  for (const event of events) {
    const failure = toolFailureDigest(event, callsById);
    if (!failure) continue;
    const key = [failure.name, failure.errorClass ?? '', failure.argsPreview ?? ''].join('\0');
    const current = failures.get(key);
    failures.set(key, {
      ...failure,
      count: (current?.count ?? 0) + 1,
    });
  }
  return [...failures.values()].sort(compareToolFailures).slice(0, 5);
}

function passedResultsByTask(resultsTsv: string): ReadonlyMap<string, boolean> | undefined {
  const lines = resultsTsv.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const header = lines[0]?.split('\t');
  if (!header) return undefined;
  const taskIdIndex = header.indexOf('task_id');
  const passedIndex = header.indexOf('passed');
  if (taskIdIndex === -1 || passedIndex === -1) return undefined;
  const passedByTask = new Map<string, boolean>();
  for (const line of lines.slice(1)) {
    const columns = line.split('\t');
    const taskId = columns[taskIdIndex];
    if (!taskId) continue;
    passedByTask.set(taskId, columns[passedIndex] === 'true');
  }
  return passedByTask;
}

function functionCallDigest(event: unknown): TrajectoryToolCallDigest | undefined {
  if (!isRecord(event) || !isRecord(event.content)) return undefined;
  const content = event.content;
  if (content.kind !== 'function_call' || typeof content.name !== 'string') return undefined;
  return {
    name: content.name,
    argsPreview: argsPreview(content.args),
  };
}

function functionCallDigestWithId(
  event: unknown,
): (TrajectoryToolCallDigest & { id: string }) | undefined {
  const call = functionCallDigest(event);
  if (!call || !isRecord(event) || !isRecord(event.content) || typeof event.content.id !== 'string')
    return undefined;
  return { ...call, id: event.content.id };
}

function toolFailureDigest(
  event: unknown,
  callsById: ReadonlyMap<string, TrajectoryToolCallDigest>,
): TrajectoryToolFailureDigest | undefined {
  if (!isRecord(event) || event.type !== 'tool_failed' || !isRecord(event.data)) return undefined;
  const data = event.data;
  if (typeof data.toolName !== 'string') return undefined;
  const call = typeof data.toolUseId === 'string' ? callsById.get(data.toolUseId) : undefined;
  return {
    name: promptSafeToken(data.toolName, 'unknown_tool'),
    count: 1,
    ...(typeof data.errorClass === 'string'
      ? { errorClass: promptSafeToken(data.errorClass, 'unknown_error') }
      : {}),
    ...(call?.argsPreview ? { argsPreview: call.argsPreview } : {}),
  };
}

function compareToolFailures(
  a: TrajectoryToolFailureDigest,
  b: TrajectoryToolFailureDigest,
): number {
  return (
    b.count - a.count ||
    a.name.localeCompare(b.name) ||
    (a.errorClass ?? '').localeCompare(b.errorClass ?? '') ||
    (a.argsPreview ?? '').localeCompare(b.argsPreview ?? '')
  );
}

function argsPreview(args: unknown): string {
  if (!isRecord(args)) return typeof args;
  return Object.keys(args)
    .map((key) => promptSafeToken(key, 'arg'))
    .sort((a, b) => a.localeCompare(b))
    .join(',');
}

function promptSafeToken(value: string, fallback: string): string {
  if (/^[A-Za-z0-9_.:-]{1,64}$/.test(value)) return value;
  return fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}

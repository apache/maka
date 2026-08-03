import { resolve } from 'node:path';
import type { SessionHeader } from '@maka/core';
import {
  inspectTaskRun,
  openHeadlessStorageForRead,
  renderTaskRunInspectTree,
  type TaskRunReader,
} from '@maka/headless';
import {
  inspectAgentRunDocument,
  inspectSessionDocument,
  renderAgentRunInspectTree,
  renderSessionInspectTree,
  type RuntimeEventInspectReader,
  type SessionAgentRunInspectReader,
} from '@maka/runtime';
import {
  openInteractiveExecutionStoresForRead,
  type ExecutionStoresReader,
} from '@maka/storage/execution-stores';
import {
  discoverMarkedStorageRoot,
  StorageRootAuthorityError,
  tryAcquireInteractiveRootReader,
} from '@maka/storage/root-authority';
import { resolveMakaWorkspaceRoot } from './workspace-root.js';
import {
  inspectResolutionFailure,
  type InspectCandidate,
  type InspectCommandBackend,
  type InspectDocument,
  type InspectEntityKind,
  type InspectResolution,
  type InspectResolutionDocument,
} from './inspect-backend.js';
import {
  connectLiveInspectBackend,
  defaultInspectCommandDependencies,
  LiveInspectError,
  type InspectCommandDependencies,
} from './live-inspect-backend.js';

export type { InspectCommandDependencies } from './live-inspect-backend.js';
export { INSPECT_RESOLUTION_SCHEMA_VERSION } from './inspect-backend.js';
export type {
  InspectCandidate,
  InspectCandidateDescriptor,
  InspectCommandBackend,
  InspectDocument,
  InspectEntityKind,
  InspectResolution,
  InspectResolutionDocument,
} from './inspect-backend.js';

const isStorageRootAuthorityError = (error: unknown): error is StorageRootAuthorityError =>
  error instanceof StorageRootAuthorityError;

interface InspectSessionReader {
  list(): Promise<readonly { id: string }[]>;
  readHeader(id: string): Promise<SessionHeader>;
}

export interface InspectCommandStores {
  sessionStore: InspectSessionReader;
  agentRunStore: SessionAgentRunInspectReader;
  runtimeEventStore: RuntimeEventInspectReader;
  taskRunStore?: TaskRunReader;
}

export async function resolveInspectTarget(
  stores: InspectCommandStores,
  query: { id: string; requestedKind?: InspectEntityKind; sessionId?: string },
): Promise<InspectResolution> {
  let candidates: InspectCandidate[];
  if (query.requestedKind === 'session') {
    candidates = await findSessionCandidates(stores.sessionStore, query.id);
  } else if (query.requestedKind === 'task-run') {
    candidates = await findTaskRunCandidates(stores.taskRunStore, query.id);
  } else if (query.requestedKind === 'agent-run') {
    candidates = await findAgentRunCandidates(stores, query.id, query.sessionId);
  } else {
    const [sessions, agentRuns, taskRuns] = await Promise.all([
      findSessionCandidates(stores.sessionStore, query.id),
      findAgentRunCandidates(stores, query.id),
      findTaskRunCandidates(stores.taskRunStore, query.id),
    ]);
    candidates = [...sessions, ...agentRuns, ...taskRuns];
  }

  candidates.sort(compareCandidates);
  if (candidates.length === 1) return { status: 'resolved', candidate: candidates[0]! };
  const status = candidates.length === 0 ? 'not_found' : 'ambiguous';
  return inspectResolutionFailure(query, status, candidates);
}

export async function inspectResolvedTarget(
  stores: InspectCommandStores,
  candidate: InspectCandidate,
): Promise<InspectDocument> {
  if (candidate.kind === 'task-run') {
    if (!stores.taskRunStore) {
      throw new StorageRootAuthorityError(
        'root_kind_mismatch',
        'TaskRun inspection requires a headless storage root',
      );
    }
    return inspectTaskRun(
      {
        taskRunStore: stores.taskRunStore,
        agentRunStore: stores.agentRunStore,
        runtimeEventStore: stores.runtimeEventStore,
      },
      candidate.id,
    );
  }
  if (candidate.kind === 'agent-run') {
    return inspectAgentRunDocument(stores.agentRunStore, stores.runtimeEventStore, {
      sessionId: candidate.sessionId,
      agentRunId: candidate.id,
      isFatalReadError: isStorageRootAuthorityError,
    });
  }
  return inspectSessionDocument(
    { readHeader: (id) => stores.sessionStore.readHeader(id) },
    stores.agentRunStore,
    stores.runtimeEventStore,
    candidate.id,
    {
      isFatalReadError: isStorageRootAuthorityError,
    },
  );
}

export interface InspectCommandIo {
  stdout: { write(value: string): unknown };
  stderr: { write(value: string): unknown };
}

export async function runMakaInspectCli(
  args: string[],
  io: InspectCommandIo = process,
  dependencies: InspectCommandDependencies = defaultInspectCommandDependencies,
): Promise<number> {
  let parsed: ParsedInspectArgs;
  try {
    parsed = parseInspectArgs(args);
  } catch (error) {
    io.stderr.write(`${errorMessage(error)}\n\n${inspectUsage()}\n`);
    return 2;
  }
  if (parsed.help) {
    io.stdout.write(`${inspectUsage()}\n`);
    return 0;
  }
  if (!parsed.id) {
    io.stderr.write(`${inspectUsage()}\n`);
    return 2;
  }
  const targetId = parsed.id;

  const storageRoot = parsed.store ? resolve(parsed.store) : resolveMakaWorkspaceRoot();
  const result = await withInspectCommandBackend(storageRoot, dependencies, async (backend) => {
    const resolution = await backend.resolve({
      id: targetId,
      ...(parsed.kind ? { requestedKind: parsed.kind } : {}),
      ...(parsed.sessionId ? { sessionId: parsed.sessionId } : {}),
    });
    if (resolution.status !== 'resolved') return resolution;
    return {
      status: 'inspected' as const,
      document: await backend.inspect(resolution.candidate),
    };
  }).catch((error: unknown) => {
    if (!isStorageRootAuthorityError(error) && !(error instanceof LiveInspectError)) throw error;
    io.stderr.write(
      `maka inspect: ${
        error instanceof LiveInspectError
          ? error.message
          : formatInspectAuthorityError(error, parsed.store === undefined)
      }\n`,
    );
    return undefined;
  });
  if (result === undefined) return 1;
  if (result.status !== 'inspected') {
    if (parsed.json) {
      io.stdout.write(`${JSON.stringify(result.document, null, 2)}\n`);
    } else {
      io.stderr.write(`${renderResolutionFailure(result.document)}\n`);
    }
    return result.status === 'ambiguous' ? 2 : 1;
  }

  const document = result.document;
  if (parsed.json) {
    io.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
  } else if (document.kind === 'task_run') {
    io.stdout.write(renderTaskRunInspectTree(document));
  } else if (document.kind === 'agent_run') {
    io.stdout.write(renderAgentRunInspectTree(document));
  } else {
    io.stdout.write(renderSessionInspectTree(document));
  }
  return 0;
}

async function withInspectCommandBackend<T>(
  storageRoot: string,
  dependencies: InspectCommandDependencies,
  operation: (backend: InspectCommandBackend) => Promise<T>,
): Promise<T> {
  try {
    return await withInspectCommandStores(storageRoot, (stores) =>
      operation({
        resolve: (query) => resolveInspectTarget(stores, query),
        inspect: (candidate) => inspectResolvedTarget(stores, candidate),
      }),
    );
  } catch (error) {
    if (!isStorageRootAuthorityError(error) || error.code !== 'lock_failed') throw error;
  }

  const live = await connectLiveInspectBackend(storageRoot, dependencies);
  try {
    return await operation(live.backend);
  } finally {
    await live.close();
  }
}

export async function withInspectCommandStores<T>(
  storageRoot: string,
  operation: (stores: InspectCommandStores) => Promise<T>,
): Promise<T> {
  const capability = await discoverMarkedStorageRoot({ path: storageRoot });
  if (capability.kind === 'headless') {
    const storage = await openHeadlessStorageForRead(capability);
    try {
      return await operation(
        inspectStoresFromExecutionReader(storage.executionStores, storage.taskRunStore),
      );
    } finally {
      await storage.executionStores.sessionStore.close?.();
    }
  }

  const reader = await tryAcquireInteractiveRootReader(capability);
  if (!reader) {
    throw new StorageRootAuthorityError(
      'lock_failed',
      `Interactive storage root is exclusively locked: ${capability.canonicalPath}`,
    );
  }
  try {
    const executionStores = await openInteractiveExecutionStoresForRead(reader.lease);
    try {
      return await operation(inspectStoresFromExecutionReader(executionStores));
    } finally {
      await executionStores.sessionStore.close?.();
    }
  } finally {
    await reader.close();
  }
}

function inspectStoresFromExecutionReader(
  stores: ExecutionStoresReader<'headless' | 'interactive'>,
  taskRunStore?: TaskRunReader,
): InspectCommandStores {
  return {
    sessionStore: stores.sessionStore,
    agentRunStore: stores.agentRunStore,
    runtimeEventStore: stores.runtimeEventStore,
    ...(taskRunStore ? { taskRunStore } : {}),
  };
}

interface ParsedInspectArgs {
  id?: string;
  store?: string;
  kind?: InspectEntityKind;
  sessionId?: string;
  json: boolean;
  help: boolean;
}

function parseInspectArgs(args: readonly string[]): ParsedInspectArgs {
  const positional: string[] = [];
  let store: string | undefined;
  let kind: InspectEntityKind | undefined;
  let sessionId: string | undefined;
  let json = false;
  let help = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--json') {
      json = true;
    } else if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--store' || arg === '--kind' || arg === '--session') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      index += 1;
      if (arg === '--store') store = value;
      else if (arg === '--session') sessionId = value;
      else if (isInspectEntityKind(value)) kind = value;
      else throw new Error(`invalid --kind: ${value}`);
    } else if (arg.startsWith('-')) {
      throw new Error(`unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  if (positional.length > 1) throw new Error(`unexpected argument: ${positional[1]}`);
  if (sessionId && kind !== 'agent-run') {
    throw new Error('--session requires --kind agent-run');
  }
  return {
    ...(positional[0] ? { id: positional[0] } : {}),
    ...(store ? { store } : {}),
    ...(kind ? { kind } : {}),
    ...(sessionId ? { sessionId } : {}),
    json,
    help,
  };
}

function isInspectEntityKind(value: string): value is InspectEntityKind {
  return value === 'session' || value === 'agent-run' || value === 'task-run';
}

async function findSessionCandidates(
  store: InspectSessionReader,
  id: string,
): Promise<Array<Extract<InspectCandidate, { kind: 'session' }>>> {
  const summaries = await store.list();
  if (!summaries.some((session) => session.id === id)) return [];
  return [{ kind: 'session', id }];
}

async function findTaskRunCandidates(
  store: TaskRunReader | undefined,
  id: string,
): Promise<Array<Extract<InspectCandidate, { kind: 'task-run' }>>> {
  if (!store) return [];
  const records = await store.readEventRecords(id);
  return records.length > 0 ? [{ kind: 'task-run', id }] : [];
}

async function findAgentRunCandidates(
  stores: Pick<InspectCommandStores, 'sessionStore' | 'agentRunStore'>,
  id: string,
  sessionId?: string,
): Promise<Array<Extract<InspectCandidate, { kind: 'agent-run' }>>> {
  if (sessionId) {
    try {
      await stores.agentRunStore.readRun(sessionId, id);
      return [{ kind: 'agent-run', id, sessionId }];
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
  }
  const sessions = await stores.sessionStore.list();
  const runLists = await Promise.all(
    sessions.map((session) => stores.agentRunStore.listSessionRuns(session.id)),
  );
  const candidates: Array<Extract<InspectCandidate, { kind: 'agent-run' }>> = [];
  runLists.forEach((runs) => {
    for (const header of runs) {
      if (header.runId === id) {
        candidates.push({ kind: 'agent-run', id, sessionId: header.sessionId });
      }
    }
  });
  return candidates;
}

function compareCandidates(a: InspectCandidate, b: InspectCandidate): number {
  return (
    a.kind.localeCompare(b.kind) ||
    (a.kind === 'agent-run' ? a.sessionId : '').localeCompare(
      b.kind === 'agent-run' ? b.sessionId : '',
    )
  );
}

function renderResolutionFailure(document: InspectResolutionDocument): string {
  if (document.status === 'not_found') {
    return `No Session, AgentRun, or TaskRun found for ${document.query.id}.`;
  }
  const candidates = document.candidates.map((candidate) =>
    candidate.kind === 'agent-run'
      ? `  - agent-run ${candidate.id} in session ${candidate.sessionId}`
      : `  - ${candidate.kind} ${candidate.id}`,
  );
  return [
    `Inspect target ${document.query.id} is ambiguous:`,
    ...candidates,
    ...(document.candidatesTruncated ? ['  - additional candidates omitted'] : []),
    'Choose one with --kind session|agent-run|task-run; add --session <id> for a duplicate AgentRun id.',
  ].join('\n');
}

function inspectUsage(): string {
  return [
    'Usage: maka inspect <id> [--store <root>] [--kind session|agent-run|task-run] [--session <sessionId>] [--json]',
    '',
    'Inspects Session, AgentRun, or TaskRun evidence without copying raw model or tool payloads.',
    'The default store is the current Maka desktop workspace.',
  ].join('\n');
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatInspectAuthorityError(
  error: StorageRootAuthorityError,
  usesDefaultWorkspace: boolean,
): string {
  if (error.code !== 'root_unmarked') return error.message;
  return usesDefaultWorkspace
    ? `${error.message}. Open Maka Desktop or the TUI once to initialize this workspace, then retry`
    : `${error.message}. Initialize it through its owning Maka write command, or pass the correct --store root`;
}

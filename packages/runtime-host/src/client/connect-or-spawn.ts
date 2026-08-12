import { randomUUID } from 'node:crypto';
import {
  prepareStorageRootControlDirectory,
  resolveStorageRoot,
} from '@maka/storage/root-authority';
import { readStateRootCompositionBinding } from '@maka/storage/state-root-composition';
import { performance } from 'node:perf_hooks';
import {
  requireClientInstanceId,
  requireHostCompositionId,
  validateProtocolRange,
  type ClientSurface,
  type HostIncompatible,
  type ProtocolRange,
} from '../protocol/index.js';
import {
  connectResolvedRuntimeHost,
  type ConnectRuntimeHostResult,
  type RuntimeHostConnection,
} from './connection.js';
import {
  launchDetachedRuntimeHostCandidate,
  launchOwnedRuntimeHostCandidate,
  type CandidateLauncher,
  type OwnedCandidateAttempt,
} from './launcher.js';
import type { CandidateStartupFailure } from '../candidate-startup-failure.js';
import { abortable, waitForRuntimeHostReady } from './wait-for-ready.js';

const DEFAULT_ELECTION_DEADLINE_MS = 45_000;
const DEFAULT_BACKOFF_MIN_MS = 20;
const DEFAULT_BACKOFF_MAX_MS = 250;
const MIN_CANDIDATE_INTERVAL_MS = 250;

export interface ConnectOrSpawnRuntimeHostInput {
  rootPath: string;
  surface: ClientSurface;
  protocol: ProtocolRange;
  compositionId: string;
  generation?: string;
  takeoverHostEpoch?: string;
  clientInstanceId?: string;
  electionDeadlineMs?: number;
  connectTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  candidateEntrypoint: string | URL;
  signal?: AbortSignal;
}

interface ConnectOrSpawnRuntimeHostDependencies {
  launchCandidate: CandidateLauncher;
  random(): number;
}

const defaultDependencies: ConnectOrSpawnRuntimeHostDependencies = {
  launchCandidate: launchDetachedRuntimeHostCandidate,
  random: Math.random,
};

export type ConnectOrSpawnRuntimeHostResult =
  | {
      kind: 'connected';
      connection: RuntimeHostConnection;
      registration: Extract<ConnectRuntimeHostResult, { kind: 'connected' }>['registration'];
    }
  | Extract<ConnectRuntimeHostResult, { kind: 'upgrade_required' }>
  | Extract<ConnectRuntimeHostResult, { kind: 'incompatible' }>
  | {
      kind: 'failed';
      reason: 'composition_mismatch';
      requiredCompositionId: string;
    }
  | {
      kind: 'failed';
      reason: CandidateStartupFailure['reason'] | 'startup_timeout' | 'host_unresponsive';
    };

export async function connectOrSpawnRuntimeHost(
  input: ConnectOrSpawnRuntimeHostInput,
): Promise<ConnectOrSpawnRuntimeHostResult> {
  return connectOrSpawnRuntimeHostWithDependencies(input, defaultDependencies);
}

export type ConnectOwnedRuntimeHostResult =
  | { kind: 'connected'; connection: RuntimeHostConnection; host: OwnedCandidateAttempt }
  | Exclude<ConnectOrSpawnRuntimeHostResult, { kind: 'connected' }>
  | { kind: 'failed'; reason: 'existing_host' };

interface ConnectOwnedRuntimeHostDependencies {
  launchCandidate: typeof launchOwnedRuntimeHostCandidate;
}

const defaultOwnedDependencies: ConnectOwnedRuntimeHostDependencies = {
  launchCandidate: launchOwnedRuntimeHostCandidate,
};

export async function connectOwnedRuntimeHost(
  input: Omit<ConnectOrSpawnRuntimeHostInput, 'candidateEntrypoint'>,
): Promise<ConnectOwnedRuntimeHostResult> {
  return connectOwnedRuntimeHostWithDependencies(input, defaultOwnedDependencies);
}

export async function connectOwnedRuntimeHostWithDependencies(
  input: Omit<ConnectOrSpawnRuntimeHostInput, 'candidateEntrypoint'>,
  dependencies: ConnectOwnedRuntimeHostDependencies,
): Promise<ConnectOwnedRuntimeHostResult> {
  let launch: ReturnType<typeof launchOwnedRuntimeHostCandidate> | undefined;
  let connection: RuntimeHostConnection | undefined;
  try {
    const result = await connectOrSpawnRuntimeHostWithDependencies(
      {
        ...input,
        candidateEntrypoint: new URL('../execution-candidate-main.js', import.meta.url),
      },
      {
        launchCandidate(candidate) {
          launch ??= dependencies.launchCandidate({
            ...candidate,
            idleGraceMs: 0,
          });
          return launch;
        },
        random: Math.random,
      },
    );
    const host = await launch?.spawned;
    if (result.kind !== 'connected' || !host) {
      if (result.kind === 'connected') await result.connection.close();
      await host?.settle(1_000);
      return result.kind === 'connected' ? { kind: 'failed', reason: 'existing_host' } : result;
    }
    const ownedConnection = result.connection;
    connection = ownedConnection;
    const diagnostics = await abortable(() => ownedConnection.queryHostDiagnostics(), input.signal);
    if (diagnostics.pid !== host.pid) {
      await connection.close();
      connection = undefined;
      await host.settle(1_000);
      return { kind: 'failed', reason: 'existing_host' };
    }
    return { kind: 'connected', connection: ownedConnection, host };
  } catch {
    await connection?.close().catch(() => undefined);
    const host = await launch?.spawned.catch(() => undefined);
    await host?.settle(1_000);
    return { kind: 'failed', reason: 'host_unresponsive' };
  }
}

export async function connectOrSpawnRuntimeHostWithDependencies(
  input: ConnectOrSpawnRuntimeHostInput,
  dependencies: ConnectOrSpawnRuntimeHostDependencies,
): Promise<ConnectOrSpawnRuntimeHostResult> {
  const deadlineMs = input.electionDeadlineMs ?? DEFAULT_ELECTION_DEADLINE_MS;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0 || deadlineMs > 120_000) {
    throw new RangeError('electionDeadlineMs must be an integer between 1 and 120000');
  }
  validateProtocolRange(input.protocol);
  requireHostCompositionId(input.compositionId);
  requireOptionalTimeout(input.connectTimeoutMs, 'connectTimeoutMs', 1);
  requireOptionalTimeout(input.handshakeTimeoutMs, 'handshakeTimeoutMs', 1);
  input.signal?.throwIfAborted();
  const clientInstanceId = requireClientInstanceId(input.clientInstanceId ?? randomUUID());
  const capability = await resolveStorageRoot({ path: input.rootPath, kind: 'interactive' });
  const composition = await readStateRootCompositionBinding(capability.canonicalPath);
  if (composition && composition.compositionId !== input.compositionId) {
    return {
      kind: 'failed',
      reason: 'composition_mismatch',
      requiredCompositionId: composition.compositionId,
    };
  }
  const { controlDirectory } = await prepareStorageRootControlDirectory(capability);
  // Root authority initialization must settle before the bounded election window begins.
  const startedAt = performance.now();
  const deadline = startedAt + deadlineMs;
  let nextCandidateAt = startedAt;
  let backoffMs = DEFAULT_BACKOFF_MIN_MS;
  let sawUnresponsiveEndpoint = false;
  let startupFailure: CandidateStartupFailure | undefined;

  while (performance.now() < deadline) {
    input.signal?.throwIfAborted();
    const result = await connectResolvedRuntimeHost({
      capability,
      controlDirectory,
      surface: input.surface,
      protocol: input.protocol,
      compositionId: input.compositionId,
      ...(input.generation === undefined ? {} : { generation: input.generation }),
      ...(input.takeoverHostEpoch === undefined
        ? {}
        : { takeoverHostEpoch: input.takeoverHostEpoch }),
      clientInstanceId,
      connectTimeoutMs: input.connectTimeoutMs,
      handshakeTimeoutMs: input.handshakeTimeoutMs,
      electionDeadline: deadline,
    });
    if (result.kind === 'election_deadline_elapsed') {
      if (result.endpointConnected) sawUnresponsiveEndpoint = true;
      break;
    }
    if (result.kind === 'connected') {
      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        await result.connection.close().catch(() => undefined);
        break;
      }
      try {
        await waitForRuntimeHostReady(
          result.connection,
          Math.max(1, Math.ceil(remaining)),
          input.signal,
        );
        return result;
      } catch {
        await result.connection.close().catch(() => undefined);
      }
      input.signal?.throwIfAborted();
      sawUnresponsiveEndpoint = true;
    }
    if (result.kind === 'upgrade_required') return result;
    if (result.kind === 'unavailable' && result.reason === 'handshake_failed') {
      sawUnresponsiveEndpoint = true;
    }
    if (isBlockingIncompatibility(result)) {
      return result;
    }

    const now = performance.now();
    if (
      shouldLaunchCandidate(result) &&
      startupFailure?.reason !== 'stored_data_incompatible' &&
      now >= nextCandidateAt
    ) {
      try {
        const remaining = deadline - performance.now();
        if (remaining <= 0) break;
        const launch = dependencies.launchCandidate({
          rootPath: capability.canonicalPath,
          expectedRootId: capability.rootId,
          entrypoint: input.candidateEntrypoint,
          initialConnectionTimeoutMs: Math.ceil(remaining),
          ...(input.generation === undefined ? {} : { generation: input.generation }),
        });
        const attempt = await settleBeforeDeadline(launch.spawned, deadline, input.signal);
        void attempt.startupFailure?.then((failure) => {
          if (failure && (!startupFailure || failure.reason === 'stored_data_incompatible')) {
            startupFailure = failure;
          }
        });
      } catch {
        // A failed Candidate attempt is ordinary election evidence; discovery continues.
      }
      nextCandidateAt = now + MIN_CANDIDATE_INTERVAL_MS;
    }

    const remaining = deadline - performance.now();
    if (remaining <= 0) break;
    const random = dependencies.random();
    const jitter = 0.75 + Math.min(1, Math.max(0, Number.isFinite(random) ? random : 0.5)) * 0.5;
    await sleep(Math.min(remaining, Math.max(1, Math.round(backoffMs * jitter))), input.signal);
    backoffMs = Math.min(DEFAULT_BACKOFF_MAX_MS, backoffMs * 2);
  }
  if (startupFailure) return { kind: 'failed', reason: startupFailure.reason };
  return {
    kind: 'failed',
    reason: sawUnresponsiveEndpoint ? 'host_unresponsive' : 'startup_timeout',
  };
}

function isBlockingIncompatibility(
  result: ConnectRuntimeHostResult,
): result is Extract<ConnectRuntimeHostResult, { kind: 'incompatible' }> {
  return result.kind === 'incompatible' && result.handshake.replacement === 'blocked_by_residency';
}

function shouldLaunchCandidate(result: ConnectRuntimeHostResult): boolean {
  return result.kind === 'unavailable' || result.kind === 'draining';
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function settleBeforeDeadline<T>(
  operation: Promise<T>,
  deadline: number,
  signal?: AbortSignal,
): Promise<T> {
  const remaining = deadline - performance.now();
  if (remaining <= 0) return Promise.reject(new Error('Runtime Host election deadline elapsed'));
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const settle = (operation: () => void) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      operation();
    };
    const timer = setTimeout(() => {
      settle(() => reject(new Error('Runtime Host election deadline elapsed')));
    }, remaining);
    const onAbort = () => settle(() => reject(signal?.reason));
    signal?.addEventListener('abort', onAbort, { once: true });
    operation.then(
      (value) => settle(() => resolve(value)),
      (error: unknown) => settle(() => reject(error)),
    );
  });
}

function requireOptionalTimeout(value: number | undefined, label: string, minimum: number): void {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || value < minimum || value > 120_000) {
    throw new RangeError(`${label} must be an integer between ${minimum} and 120000`);
  }
}

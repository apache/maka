import { randomUUID } from 'node:crypto';
import {
  prepareStorageRootControlDirectory,
  resolveStorageRoot,
} from '@maka/storage/root-authority';
import { performance } from 'node:perf_hooks';
import {
  requireClientInstanceId,
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
import { launchDetachedRuntimeHostCandidate, type CandidateLauncher } from './launcher.js';

const DEFAULT_ELECTION_DEADLINE_MS = 45_000;
const DEFAULT_BACKOFF_MIN_MS = 20;
const DEFAULT_BACKOFF_MAX_MS = 250;
const MIN_CANDIDATE_INTERVAL_MS = 250;

export interface ConnectOrSpawnRuntimeHostInput {
  rootPath: string;
  surface: ClientSurface;
  protocol: ProtocolRange;
  clientInstanceId?: string;
  electionDeadlineMs?: number;
  connectTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  candidateEntrypoint?: string | URL;
  legacyConfigurationRoot?: string;
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
  | { kind: 'connected'; connection: RuntimeHostConnection }
  | { kind: 'incompatible'; handshake: HostIncompatible }
  | { kind: 'failed'; reason: 'startup_timeout' | 'host_unresponsive' };

export async function connectOrSpawnRuntimeHost(
  input: ConnectOrSpawnRuntimeHostInput,
): Promise<ConnectOrSpawnRuntimeHostResult> {
  return connectOrSpawnRuntimeHostWithDependencies(input, defaultDependencies);
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
  requireOptionalTimeout(input.connectTimeoutMs, 'connectTimeoutMs', 1);
  requireOptionalTimeout(input.handshakeTimeoutMs, 'handshakeTimeoutMs', 1);
  input.signal?.throwIfAborted();
  const clientInstanceId = requireClientInstanceId(input.clientInstanceId ?? randomUUID());
  const capability = await resolveStorageRoot({ path: input.rootPath, kind: 'interactive' });
  const { controlDirectory } = await prepareStorageRootControlDirectory(capability);
  // Root authority initialization must settle before the bounded election window begins.
  const startedAt = performance.now();
  const deadline = startedAt + deadlineMs;
  let nextCandidateAt = startedAt;
  let backoffMs = DEFAULT_BACKOFF_MIN_MS;
  let sawUnresponsiveEndpoint = false;

  while (performance.now() < deadline) {
    input.signal?.throwIfAborted();
    const result = await connectResolvedRuntimeHost({
      capability,
      controlDirectory,
      surface: input.surface,
      protocol: input.protocol,
      clientInstanceId,
      connectTimeoutMs: input.connectTimeoutMs,
      handshakeTimeoutMs: input.handshakeTimeoutMs,
      electionDeadline: deadline,
    });
    if (result.kind === 'election_deadline_elapsed') {
      if (result.endpointConnected) sawUnresponsiveEndpoint = true;
      break;
    }
    if (result.kind === 'connected') return { kind: 'connected', connection: result.connection };
    if (result.kind === 'unavailable' && result.reason === 'handshake_failed') {
      sawUnresponsiveEndpoint = true;
    }
    if (isBlockingIncompatibility(result)) {
      return { kind: 'incompatible', handshake: result.handshake };
    }

    const now = performance.now();
    if (shouldLaunchCandidate(result) && now >= nextCandidateAt) {
      try {
        const remaining = deadline - performance.now();
        if (remaining <= 0) break;
        const launch = dependencies.launchCandidate({
          rootPath: capability.canonicalPath,
          expectedRootId: capability.rootId,
          ...(input.candidateEntrypoint === undefined
            ? {}
            : { entrypoint: input.candidateEntrypoint }),
          ...(input.legacyConfigurationRoot === undefined
            ? {}
            : { legacyConfigurationRoot: input.legacyConfigurationRoot }),
        });
        await settleBeforeDeadline(launch.spawned, deadline, input.signal);
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

/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

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
  type HostRegistration,
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
  type CandidateExitDetails,
  type CandidateProcessExit,
  type CandidateLauncher,
  type DetachedCandidateAttempt,
  type OwnedCandidateAttempt,
} from './launcher.js';

export type { CandidateExitDetails } from './launcher.js';
import {
  isPermanentCandidateStartupFailure,
  type CandidateStartupFailure,
  type CandidateStartupFailureReport,
} from '../candidate-startup-failure.js';
import {
  clearCandidateStartupDiagnostic,
  selectCandidateStartupDiagnostic,
} from '../control/startup-diagnostic.js';
import {
  decodeRuntimeHostManagedLaunchClaim,
  readRuntimeHostManagedDeploymentConfig,
  runtimeHostManagedLaunchRejection,
  RuntimeHostManagedDeploymentError,
  type RuntimeHostManagedDeploymentAuthorityOptions,
  type RuntimeHostManagedLaunchClaim,
} from '../operator/managed-deployment.js';
import { abortable, waitForRuntimeHostReady } from './wait-for-ready.js';

const DEFAULT_ELECTION_DEADLINE_MS = 45_000;
const DEFAULT_BACKOFF_MIN_MS = 20;
const DEFAULT_BACKOFF_MAX_MS = 250;
const MIN_CANDIDATE_INTERVAL_MS = 250;
export const ELECTION_DEADLINE_MS_ENV_VAR = 'MAKA_RUNTIME_HOST_ELECTION_DEADLINE_MS';

export interface ConnectOrSpawnRuntimeHostInput {
  rootPath: string;
  protocol: ProtocolRange;
  compositionId: string;
  generation?: string;
  takeoverHostEpoch?: string;
  clientInstanceId?: string;
  electionDeadlineMs?: number;
  connectTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  candidateEntrypoint: string | URL;
  candidateExecutable?: string;
  managedLaunchClaim?: RuntimeHostManagedLaunchClaim;
  signal?: AbortSignal;
  /** Existing authority lease inherited by a launch-owner-supervised Candidate. */
  inheritableAuthorityLeaseFd?: number;
  /** Close a newly spawned ephemeral Candidate if this launcher exits. */
  closeOnLauncherExit?: boolean;
  /** Candidate-exit sink forwarded to the launcher; the embedder owns the sink. */
  onExit?: (details: CandidateExitDetails) => void;
}

interface ConnectOrSpawnRuntimeHostDependencies {
  launchCandidate: CandidateLauncher;
  random(): number;
  /** Defaults to `process.env`; injected so tests never mutate the real environment. */
  env?: NodeJS.ProcessEnv;
  connectHost?: typeof connectResolvedRuntimeHost;
  /** Authority-location override for tests and embedded runtimes. */
  managedDeploymentAuthority?: RuntimeHostManagedDeploymentAuthorityOptions;
}

type ElectionConnectionResult = Awaited<ReturnType<typeof connectResolvedRuntimeHost>>;

const defaultDependencies: ConnectOrSpawnRuntimeHostDependencies = {
  launchCandidate: launchDetachedRuntimeHostCandidate,
  random: Math.random,
};

/**
 * Resolves the operator override for the client election deadline. Large
 * workspaces can legitimately take longer than the default window on their
 * first start after an upgrade, so the deadline must be raisable without a
 * code change. Invalid values fail closed: a silently ignored typo would
 * leave the operator believing they widened the window when they did not.
 */
export function electionDeadlineMsFromEnvironment(
  rawValue: string | undefined,
): number | undefined {
  if (rawValue === undefined || rawValue.trim() === '') return undefined;
  const parsed = Number(rawValue);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 120_000) {
    throw new RangeError(
      `${ELECTION_DEADLINE_MS_ENV_VAR} must be an integer between 1 and 120000 milliseconds`,
    );
  }
  return parsed;
}

export type ConnectOrSpawnRuntimeHostResult =
  | {
      kind: 'connected';
      connection: RuntimeHostConnection;
      registration: Extract<ConnectRuntimeHostResult, { kind: 'connected' }>['registration'];
      spawnedProcess?: RuntimeHostSpawnedProcess;
    }
  | Extract<ConnectRuntimeHostResult, { kind: 'upgrade_required' }>
  | Extract<ConnectRuntimeHostResult, { kind: 'incompatible' }>
  | {
      kind: 'failed';
      reason: 'composition_mismatch';
      requiredCompositionId: string;
      diagnostic?: RuntimeHostElectionDiagnostic;
    }
  | {
      kind: 'failed';
      reason: CandidateStartupFailure['reason'] | 'startup_timeout' | 'host_unresponsive';
      diagnostic?: RuntimeHostElectionDiagnostic;
    };

export interface RuntimeHostElectionDiagnostic {
  readonly deadlineMs: number;
  readonly elapsedMs: number;
  readonly candidateLaunches: number;
  readonly sawEndpointConnected: boolean;
  readonly observations: {
    readonly totalResults: number;
    readonly notRegistered: number;
    readonly connectFailed: number;
    readonly handshakeFailed: number;
    readonly connected: number;
    readonly readyWaitFailed: number;
    readonly deadlineElapsed: number;
    readonly otherResults: number;
  };
  readonly lastRegistration?: {
    readonly pid: number;
    readonly state: HostRegistration['state'];
    readonly lifecycleMode: HostRegistration['lifecycleMode'];
    readonly generation?: string;
  };
  readonly latestCandidate?: {
    readonly pid: number;
    readonly startupAttemptId?: string;
    readonly state: 'running' | 'exited' | 'unknown';
    readonly exitCode?: number | null;
    readonly signal?: NodeJS.Signals | null;
  };
}

interface MutableElectionObservations {
  totalResults: number;
  notRegistered: number;
  connectFailed: number;
  handshakeFailed: number;
  connected: number;
  readyWaitFailed: number;
  deadlineElapsed: number;
  otherResults: number;
}

interface ObservedCandidateAttempt {
  readonly attempt: DetachedCandidateAttempt;
  exit?: CandidateProcessExit;
}

export interface RuntimeHostSpawnedProcess {
  readonly pid: number;
  readonly exited: Promise<CandidateProcessExit>;
}

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
    if (result.kind !== 'connected') {
      releaseOwnedLaunch(launch);
      return result;
    }
    const host = await launch?.spawned.catch(() => undefined);
    if (!host) {
      await result.connection.close();
      return {
        kind: 'failed',
        reason: launch ? 'host_unresponsive' : 'existing_host',
      };
    }
    const ownedConnection = result.connection;
    connection = ownedConnection;
    const diagnostics = await abortable(
      () => ownedConnection.request('host.diagnostics.query', {}),
      input.signal,
    );
    if (diagnostics.pid !== host.pid) {
      await connection.close();
      connection = undefined;
      await host.settle(1_000);
      return { kind: 'failed', reason: 'existing_host' };
    }
    return { kind: 'connected', connection: ownedConnection, host };
  } catch {
    await connection?.close().catch(() => undefined);
    releaseOwnedLaunch(launch);
    return { kind: 'failed', reason: 'host_unresponsive' };
  }
}

function releaseOwnedLaunch(
  launch: ReturnType<typeof launchOwnedRuntimeHostCandidate> | undefined,
): void {
  if (!launch) return;
  void launch.spawned
    .then((host) => {
      host.releaseToEnvironment();
    })
    .catch(() => undefined);
}

export async function connectOrSpawnRuntimeHostWithDependencies(
  input: ConnectOrSpawnRuntimeHostInput,
  dependencies: ConnectOrSpawnRuntimeHostDependencies,
): Promise<ConnectOrSpawnRuntimeHostResult> {
  const deadlineMs =
    input.electionDeadlineMs ??
    electionDeadlineMsFromEnvironment(
      (dependencies.env ?? process.env)[ELECTION_DEADLINE_MS_ENV_VAR],
    ) ??
    DEFAULT_ELECTION_DEADLINE_MS;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0 || deadlineMs > 120_000) {
    throw new RangeError('electionDeadlineMs must be an integer between 1 and 120000');
  }
  validateProtocolRange(input.protocol);
  requireHostCompositionId(input.compositionId);
  requireOptionalTimeout(input.connectTimeoutMs, 'connectTimeoutMs', 1);
  requireOptionalTimeout(input.handshakeTimeoutMs, 'handshakeTimeoutMs', 1);
  const managedLaunchClaim =
    input.managedLaunchClaim === undefined
      ? undefined
      : decodeRuntimeHostManagedLaunchClaim(input.managedLaunchClaim);
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
  let startupFailure: CandidateStartupFailureReport | undefined;
  let pendingCandidateReports = 0;
  let electionSettled = false;
  let candidateInFlight = false;
  const candidateLaunches = new Set<ReturnType<CandidateLauncher>>();
  let sawEndpointConnected = false;
  let lastRegistration: HostRegistration | undefined;
  let latestCandidate: ObservedCandidateAttempt | undefined;
  const observations: MutableElectionObservations = {
    totalResults: 0,
    notRegistered: 0,
    connectFailed: 0,
    handshakeFailed: 0,
    connected: 0,
    readyWaitFailed: 0,
    deadlineElapsed: 0,
    otherResults: 0,
  };

  try {
    while (performance.now() < deadline) {
      input.signal?.throwIfAborted();
      const result = await (dependencies.connectHost ?? connectResolvedRuntimeHost)({
        capability,
        controlDirectory,
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
      const observed = recordElectionResult(result, observations);
      if (observed.registration) lastRegistration = observed.registration;
      if (observed.endpointConnected) sawEndpointConnected = true;
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
          electionSettled = true;
          await retireCandidateStartupDiagnostic(capability.rootId, startupFailure);
          const selected = latestCandidate?.attempt;
          const spawnedProcess =
            selected?.pid === result.registration.pid && selected.exited
              ? { pid: selected.pid, exited: selected.exited }
              : undefined;
          return spawnedProcess ? { ...result, spawnedProcess } : result;
        } catch {
          observations.readyWaitFailed += 1;
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
      if (isPermanentCandidateStartupFailure(startupFailure) && pendingCandidateReports === 0) {
        const selectedFailure = startupFailure;
        electionSettled = true;
        await selectCandidateStartupDiagnostic(
          capability.rootId,
          selectedFailure.startupAttemptId,
        ).catch(() => undefined);
        return { kind: 'failed', reason: selectedFailure.reason };
      }

      const now = performance.now();
      if (
        shouldLaunchCandidate(result) &&
        !isPermanentCandidateStartupFailure(startupFailure) &&
        !candidateInFlight &&
        now >= nextCandidateAt
      ) {
        let managedDeployment;
        try {
          managedDeployment = await readRuntimeHostManagedDeploymentConfig(
            capability,
            dependencies.managedDeploymentAuthority,
          );
        } catch (error) {
          if (
            error instanceof RuntimeHostManagedDeploymentError &&
            error.code === 'invalid_config'
          ) {
            return { kind: 'failed', reason: 'deployment_record_invalid' };
          }
          throw error;
        }
        const managedLaunchRejection = runtimeHostManagedLaunchRejection(
          managedDeployment,
          managedLaunchClaim,
          'on_demand',
        );
        if (managedLaunchRejection !== undefined) {
          return { kind: 'failed', reason: managedLaunchRejection };
        }
        try {
          const remaining = deadline - performance.now();
          if (remaining <= 0) break;
          const launch = dependencies.launchCandidate({
            rootPath: capability.canonicalPath,
            expectedRootId: capability.rootId,
            entrypoint: input.candidateEntrypoint,
            ...(input.candidateExecutable === undefined
              ? {}
              : { executable: input.candidateExecutable }),
            initialConnectionTimeoutMs: Math.ceil(remaining),
            ...(input.generation === undefined ? {} : { generation: input.generation }),
            ...(managedLaunchClaim === undefined ? {} : { managedLaunchClaim }),
            ...(input.onExit === undefined ? {} : { onExit: input.onExit }),
            ...(input.inheritableAuthorityLeaseFd === undefined
              ? {}
              : { inheritableAuthorityLeaseFd: input.inheritableAuthorityLeaseFd }),
            ...(input.closeOnLauncherExit === undefined
              ? {}
              : { closeOnLauncherExit: input.closeOnLauncherExit }),
          });
          candidateLaunches.add(launch);
          const attempt = await settleBeforeDeadline(launch.spawned, deadline, input.signal);
          candidateInFlight = true;
          const candidate: ObservedCandidateAttempt = { attempt };
          latestCandidate = candidate;
          if (attempt.exited) {
            void attempt.exited.then(
              (exit) => {
                candidate.exit = exit;
                candidateInFlight = false;
              },
              () => {
                candidateInFlight = false;
              },
            );
          }
          if (attempt.startupFailure) {
            pendingCandidateReports += 1;
            void attempt.startupFailure
              .then(
                (failure) => {
                  if (!failure) return;
                  if (electionSettled) {
                    void clearCandidateStartupDiagnostic(
                      capability.rootId,
                      failure.startupAttemptId,
                    ).catch(() => undefined);
                    return;
                  }
                  const replace =
                    !startupFailure ||
                    (!isPermanentCandidateStartupFailure(startupFailure) &&
                      isPermanentCandidateStartupFailure(failure));
                  const obsolete = replace ? startupFailure : failure;
                  if (replace) {
                    startupFailure = failure;
                  }
                  if (obsolete) {
                    void clearCandidateStartupDiagnostic(
                      capability.rootId,
                      obsolete.startupAttemptId,
                    ).catch(() => undefined);
                  }
                },
                () => undefined,
              )
              .finally(() => {
                pendingCandidateReports -= 1;
              });
          }
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
    if (startupFailure) {
      const selectedFailure = startupFailure;
      electionSettled = true;
      await selectCandidateStartupDiagnostic(
        capability.rootId,
        selectedFailure.startupAttemptId,
      ).catch(() => undefined);
      return { kind: 'failed', reason: selectedFailure.reason };
    }
    return {
      kind: 'failed',
      reason: sawUnresponsiveEndpoint ? 'host_unresponsive' : 'startup_timeout',
      diagnostic: createElectionDiagnostic({
        deadlineMs,
        startedAt,
        candidateLaunches: candidateLaunches.size,
        sawEndpointConnected,
        observations,
        lastRegistration,
        latestCandidate,
      }),
    };
  } finally {
    electionSettled = true;
  }
}

function recordElectionResult(
  result: ElectionConnectionResult,
  observations: MutableElectionObservations,
): { readonly endpointConnected: boolean; readonly registration?: HostRegistration } {
  observations.totalResults += 1;
  const registration = 'registration' in result ? result.registration : undefined;
  if (result.kind === 'election_deadline_elapsed') {
    observations.deadlineElapsed += 1;
    return {
      endpointConnected: result.endpointConnected,
      ...(result.registration ? { registration: result.registration } : {}),
    };
  }
  if (result.kind === 'connected') {
    observations.connected += 1;
    return { endpointConnected: true, registration };
  }
  if (result.kind !== 'unavailable') {
    observations.otherResults += 1;
    return {
      endpointConnected: electionResultReachedEndpoint(result),
      ...(registration ? { registration } : {}),
    };
  }
  switch (result.reason) {
    case 'not_registered':
      observations.notRegistered += 1;
      break;
    case 'connect_failed':
      observations.connectFailed += 1;
      break;
    case 'handshake_failed':
      observations.handshakeFailed += 1;
      break;
    default:
      observations.otherResults += 1;
      break;
  }
  return {
    endpointConnected: electionResultReachedEndpoint(result),
    ...(registration ? { registration } : {}),
  };
}

function electionResultReachedEndpoint(
  result: Exclude<ElectionConnectionResult, { kind: 'election_deadline_elapsed' }>,
): boolean {
  switch (result.kind) {
    case 'connected':
    case 'draining':
    case 'incompatible':
    case 'upgrade_required':
      return true;
    case 'unavailable':
      return result.endpointConnected;
  }
}

function createElectionDiagnostic(input: {
  readonly deadlineMs: number;
  readonly startedAt: number;
  readonly candidateLaunches: number;
  readonly sawEndpointConnected: boolean;
  readonly observations: MutableElectionObservations;
  readonly lastRegistration: HostRegistration | undefined;
  readonly latestCandidate: ObservedCandidateAttempt | undefined;
}): RuntimeHostElectionDiagnostic {
  const candidate = input.latestCandidate;
  return {
    deadlineMs: input.deadlineMs,
    elapsedMs: Math.max(0, Math.round(performance.now() - input.startedAt)),
    candidateLaunches: input.candidateLaunches,
    sawEndpointConnected: input.sawEndpointConnected,
    observations: { ...input.observations },
    ...(input.lastRegistration
      ? {
          lastRegistration: {
            pid: input.lastRegistration.pid,
            state: input.lastRegistration.state,
            lifecycleMode: input.lastRegistration.lifecycleMode,
            ...(input.lastRegistration.generation === undefined
              ? {}
              : { generation: input.lastRegistration.generation }),
          },
        }
      : {}),
    ...(candidate
      ? {
          latestCandidate: {
            pid: candidate.attempt.pid,
            ...(candidate.attempt.startupAttemptId === undefined
              ? {}
              : { startupAttemptId: candidate.attempt.startupAttemptId }),
            state: candidate.exit ? 'exited' : candidate.attempt.exited ? 'running' : 'unknown',
            ...(candidate.exit
              ? { exitCode: candidate.exit.code, signal: candidate.exit.signal }
              : {}),
          },
        }
      : {}),
  };
}

async function retireCandidateStartupDiagnostic(
  rootId: string,
  startupFailure: CandidateStartupFailureReport | undefined,
): Promise<void> {
  await Promise.all([
    clearCandidateStartupDiagnostic(rootId),
    ...(startupFailure
      ? [clearCandidateStartupDiagnostic(rootId, startupFailure.startupAttemptId)]
      : []),
  ]).catch(() => undefined);
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

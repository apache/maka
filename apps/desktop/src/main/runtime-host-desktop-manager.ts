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
import type { BotIncomingMessage } from '@maka/runtime/bots';
import {
  abortable,
  connectExistingRuntimeHost,
  prepareConnectedRuntimeHostRetirement,
  runHostHandoff,
  HostHandoffCancelledError,
  type OpenHostHandoffSurface,
  type HostHandoffObservation,
  type HostHandoffBlocker,
  forceTerminateObservedRegisteredRuntimeHost,
  RuntimeHostOperationError,
  RuntimeHostPermanentReconnectError,
  RuntimeHostRemoteCompatibilityError,
  RuntimeHostPeerError,
  RuntimeHostPeerReachabilityUnavailableError,
  RuntimeHostRequestInterruptedError,
  runtimeHostStartupError,
  LOCAL_RUNTIME_HOST_PROFILE,
  sameResolvedRuntimeHostProfileTarget,
  startRuntimeHostReconnectLifecycle,
  type CandidateExitDetails,
  type ResolvedRuntimeHostProfile,
  type RuntimeHostReconnectBackoff,
  type RuntimeHostReconnectLifecycle,
  type RuntimeHostConnectionPhase,
  type RuntimeHostRetirementMode,
  type RuntimeHostSshInteraction,
} from '@maka/runtime-host/client';
import {
  RUNTIME_HOST_PROTOCOL_VERSION,
  type HostRegistration,
  type HostStatusResult,
} from '@maka/runtime-host/protocol';
import type { DesktopTargetSessionRef } from '../shared/runtime-host-identity.js';
import {
  startDesktopRuntimeHostCandidate,
  type DesktopRuntimeHostCandidate,
  type DesktopRuntimeHostCandidateStartInput,
  type DesktopRuntimeHostCandidateStartResult,
  type DesktopRuntimeHostOwnership,
} from './runtime-host-desktop-candidate.js';
import { RuntimeHostReconnectingIpcMain } from './runtime-host-reconnecting-ipc-main.js';
import { RuntimeHostSessionObservationRegistry } from './runtime-host-session-observation-registry.js';
import { canRepairManagedRuntimeHostStartup } from './runtime-host-startup-recovery.js';

export interface RuntimeHostDesktopManager {
  current(profileId?: string): RuntimeHostDesktopTargetSnapshot | undefined;
  entries(): readonly RuntimeHostDesktopTargetState[];
  ownsScope(scope: { readonly hostId: string; readonly targetEpoch: string }): boolean;
  defaultProfileId(): string;
  handleBotIncomingMessage(message: BotIncomingMessage): Promise<void>;
  finalizePairing(profileId: string): Promise<void>;
  stopSession(ref: DesktopTargetSessionRef): Promise<void>;
  closeTranscript(consumerId: string, targetId: number): Promise<void>;
  acknowledgeTranscript(
    scope: { readonly hostId: string; readonly targetEpoch: string },
    consumerId: string,
    generation: string,
    deliverySequence: number,
    targetId: number,
  ): void;
  unobserveSession(observerId: string): Promise<void>;
  enable(
    profileTarget: DesktopRuntimeHostCandidateStartInput['profileTarget'],
    onHostStatus?: (status: HostStatusResult) => void,
  ): Promise<void>;
  mountGuest(
    profileTarget: NonNullable<DesktopRuntimeHostCandidateStartInput['profileTarget']>,
    onSessionCatalogChanged: () => void,
    signal?: AbortSignal,
    onConnectionPhase?: (phase: RuntimeHostConnectionPhase) => void,
    onHostStatus?: (status: HostStatusResult) => void,
  ): Promise<void>;
  finalizeGuestAccess(
    mountId: string,
    signal?: AbortSignal,
    onAccessActivated?: () => void,
    onFinalizationStarted?: () => void,
  ): Promise<RuntimeHostGuestAccessFinalization>;
  unmountGuest(mountId: string): Promise<void>;
  wakePeerRecovery(profileId?: string): void;
  disable(profileId: string): Promise<void>;
  waitUntilReady(
    profileId: string,
    previousHostEpoch?: string,
    signal?: AbortSignal,
  ): Promise<void>;
  runManagedLocalHostChange<T>(change: () => Promise<T>): Promise<T>;
  setDefaultProfile(profileId: string): void;
  retireOwnedLocalHost(mode: RuntimeHostRetirementMode): Promise<DesktopLocalHostRetirement>;
  prepareOwnedLocalHostQuit(mode: RuntimeHostRetirementMode): Promise<'ready' | 'active_tasks'>;
  close(): Promise<void>;
}

export interface RuntimeHostDesktopTargetSnapshot {
  readonly epoch: string;
  readonly hostId?: string;
  readonly target: ResolvedRuntimeHostProfile;
  readonly readiness: 'ready' | 'reconnecting';
  readonly candidate?: DesktopRuntimeHostCandidate;
}

export type RuntimeHostDesktopTargetState = (
  | {
      readonly epoch: string;
      readonly target: ResolvedRuntimeHostProfile;
      readonly readiness: 'connecting' | 'reconnecting';
      readonly hostId?: string;
      readonly error?: Error;
    }
  | {
      readonly epoch: string;
      readonly target: ResolvedRuntimeHostProfile;
      readonly readiness: 'ready';
      readonly candidate: DesktopRuntimeHostCandidate;
    }
  | {
      readonly epoch: string;
      readonly target: ResolvedRuntimeHostProfile;
      readonly readiness: 'unavailable';
      readonly hostId?: string;
      readonly error: Error;
    }
) & {
  readonly reconnect?: {
    readonly failures: number;
    readonly firstFailureAt: number;
    readonly lastFailureAt: number;
  };
};

export type DesktopLocalHostRetirement =
  | { readonly kind: 'active_tasks' }
  | { readonly kind: 'not_owned' }
  | { readonly kind: 'retired'; resume(): void };

type PreparedLocalHostRetirement =
  | Exclude<DesktopLocalHostRetirement, { kind: 'retired' }>
  | (Extract<DesktopLocalHostRetirement, { kind: 'retired' }> & { waitForExit(): Promise<void> });

interface DesktopLocalHostRetirementTask {
  readonly mode: RuntimeHostRetirementMode;
  readonly result: Promise<PreparedLocalHostRetirement>;
}

export interface DesktopLocalHostRetirementFacts {
  readonly hostId: string;
  readonly hostEpoch: string;
  readonly lifecycleMode: 'ephemeral';
  readonly rootPath: string;
  readonly pid?: number;
}

export class DesktopLocalHostRetirementError extends Error {
  constructor(
    readonly facts: DesktopLocalHostRetirementFacts,
    options: ErrorOptions,
  ) {
    super('Unable to retire the Desktop-owned local Runtime Host', options);
    this.name = 'DesktopLocalHostRetirementError';
  }
}

export interface RuntimeHostLocalReplacement {
  readonly identity?: string;
  readonly canReplaceIdle?: boolean;
  replace(
    activeWorkPolicy: RuntimeHostRetirementMode,
    progress?: (phase: 'checking' | 'staging' | 'retiring' | 'replacing') => void,
    signal?: AbortSignal,
  ): Promise<'replaced' | 'active_tasks'>;
}

export class RuntimeHostUpgradeCancelledError extends RuntimeHostPermanentReconnectError {
  constructor() {
    super('Runtime Host restart was cancelled');
    this.name = 'RuntimeHostUpgradeCancelledError';
  }
}

export class RuntimeHostPairingFinalizationInterruptedError extends Error {
  constructor(options?: ErrorOptions) {
    super('Runtime Host pairing finalization is continuing in the background', options);
    this.name = 'RuntimeHostPairingFinalizationInterruptedError';
  }
}

export type RuntimeHostGuestAccessFinalization = 'ready' | 'reconnecting';

const DEFAULT_PAIRING_FINALIZATION_TIMEOUT_MS = 30_000;
const LOCAL_HOST_RETIREMENT_ADMISSION_TIMEOUT_MS = 5_000;

export type RuntimeHostRestartableConflict = Extract<
  DesktopRuntimeHostCandidateStartResult,
  { kind: 'upgrade_required'; restartable: true }
>;

export type RuntimeHostWaitConflict =
  | Extract<
      DesktopRuntimeHostCandidateStartResult,
      { kind: 'upgrade_required'; restartable: false }
    >
  | Extract<DesktopRuntimeHostCandidateStartResult, { kind: 'incompatible' }>;

interface DesktopRuntimeHostTargetGeneration {
  readonly epoch: string;
  readonly input: DesktopRuntimeHostCandidateStartInput;
  readonly target: ResolvedRuntimeHostProfile;
  readonly observations: RuntimeHostSessionObservationRegistry;
  state: RuntimeHostDesktopTargetState;
  hostId?: string;
  lifecycle?: RuntimeHostReconnectLifecycle<DesktopRuntimeHostCandidate>;
  unsubscribeLifecycle?: () => void;
  unsubscribeRoutes?: () => void;
  skipPeerRouteRefreshOnce?: boolean;
  lastCandidate?: {
    readonly hostId: string;
    readonly hostEpoch: string;
    readonly ownership: DesktopRuntimeHostOwnership;
    readonly ownedProcess?: DesktopOwnedProcessEvidence;
  };
  valid: boolean;
}

interface DesktopOwnedProcessEvidence {
  readonly pid: number;
  state: 'running' | 'exited' | 'unknown';
}

export async function startRuntimeHostDesktopManager(
  input: DesktopRuntimeHostCandidateStartInput,
  options: {
    startCandidate?: (
      input: DesktopRuntimeHostCandidateStartInput,
      observationRegistry: RuntimeHostSessionObservationRegistry,
    ) => Promise<DesktopRuntimeHostCandidateStartResult>;
    onFatalError?: (error: Error, target: ResolvedRuntimeHostProfile) => void;
    handoffSurface?: OpenHostHandoffSurface;
    waitForHostExit?: (pid: number) => Promise<void>;
    forceTerminateObservedHost?: typeof forceTerminateObservedRegisteredRuntimeHost;
    resolveLocalHostReplacement?: (
      registration: HostRegistration,
      signal: AbortSignal,
    ) => Promise<RuntimeHostLocalReplacement | undefined>;
    recoverLocalHost?: (signal: AbortSignal) => Promise<boolean>;
    resolveStartupRepair?: (error: Error, signal: AbortSignal) => Promise<HostHandoffBlocker | undefined>;
    resolveWslHostHandoff?: (profile: Extract<ResolvedRuntimeHostProfile['profile'], { kind: 'environment' }>, error: RuntimeHostRemoteCompatibilityError, signal: AbortSignal) => Promise<HostHandoffBlocker>;
    reconnectBackoff?: RuntimeHostReconnectBackoff;
    pairingFinalizationTimeoutMs?: number;
    onTargetStateChanged?: (state: RuntimeHostDesktopTargetState) => void;
    onTargetRemoved?: (state: RuntimeHostDesktopTargetState) => void;
    onDefaultProfileChanged?: (profileId: string) => void;
  } = {},
): Promise<RuntimeHostDesktopManager> {
  if (input.profileTarget) throw new Error('Desktop Runtime Host manager must start with Local');
  const manager = new RuntimeHostDesktopManagerImpl(
    input,
    options.startCandidate ?? startDesktopRuntimeHostCandidate,
    options.onFatalError ?? ((error) => console.error('[runtime-host] reconnect failed:', error)),
    options.handoffSurface,
    options.waitForHostExit ?? waitForProcessExit,
    options.forceTerminateObservedHost ?? forceTerminateObservedRegisteredRuntimeHost,
    options.resolveLocalHostReplacement,
    options.recoverLocalHost,
    options.resolveStartupRepair,
    options.resolveWslHostHandoff,
    options.reconnectBackoff,
    options.pairingFinalizationTimeoutMs ?? DEFAULT_PAIRING_FINALIZATION_TIMEOUT_MS,
    options.onTargetStateChanged,
    options.onTargetRemoved,
    options.onDefaultProfileChanged,
  );
  await manager.start();
  return manager;
}

class RuntimeHostDesktopManagerImpl implements RuntimeHostDesktopManager {
  readonly #ipcMain: RuntimeHostReconnectingIpcMain;
  readonly #observationRegistries = new Set<RuntimeHostSessionObservationRegistry>();
  readonly #targets = new Map<string, DesktopRuntimeHostTargetGeneration>();
  readonly #targetMutations = new Map<string, {
    readonly settled: Promise<void>;
    readonly connectionAbort: AbortController;
  }>();
  readonly #baseInput: DesktopRuntimeHostCandidateStartInput;
  readonly #shutdown = new AbortController();
  #defaultProfileId: string = LOCAL_RUNTIME_HOST_PROFILE.id;
  #localHostRetirement: Extract<PreparedLocalHostRetirement, { kind: 'retired' }> | undefined;
  #localHostRetirementTask: DesktopLocalHostRetirementTask | undefined;
  #closed = false;
  #closeTask: Promise<void> | undefined;

  constructor(
    input: DesktopRuntimeHostCandidateStartInput,
    private readonly startCandidate: (
      input: DesktopRuntimeHostCandidateStartInput,
      observationRegistry: RuntimeHostSessionObservationRegistry,
    ) => Promise<DesktopRuntimeHostCandidateStartResult>,
    private readonly onFatalError: (
      error: Error,
      target: ResolvedRuntimeHostProfile,
    ) => void,
    private readonly handoffSurface: OpenHostHandoffSurface | undefined,
    private readonly waitForHostExit: (pid: number) => Promise<void>,
    private readonly forceTerminateObservedHost: typeof forceTerminateObservedRegisteredRuntimeHost,
    private readonly resolveLocalHostReplacement:
      | ((
          registration: HostRegistration,
          signal: AbortSignal,
        ) => Promise<RuntimeHostLocalReplacement | undefined>)
      | undefined,
    private readonly recoverLocalHost:
      | ((signal: AbortSignal) => Promise<boolean>)
      | undefined,
    private readonly resolveStartupRepair:
      | ((error: Error, signal: AbortSignal) => Promise<HostHandoffBlocker | undefined>)
      | undefined,
    private readonly resolveWslHostHandoff: ((profile: Extract<ResolvedRuntimeHostProfile['profile'], { kind: 'environment' }>, error: RuntimeHostRemoteCompatibilityError, signal: AbortSignal) => Promise<HostHandoffBlocker>) | undefined,
    private readonly reconnectBackoff: RuntimeHostReconnectBackoff | undefined,
    private readonly pairingFinalizationTimeoutMs: number,
    private readonly onTargetStateChanged:
      | ((state: RuntimeHostDesktopTargetState) => void)
      | undefined,
    private readonly onTargetRemoved:
      | ((state: RuntimeHostDesktopTargetState) => void)
      | undefined,
    private readonly onDefaultProfileChanged:
      | ((profileId: string) => void)
      | undefined,
  ) {
    this.#ipcMain = new RuntimeHostReconnectingIpcMain(input.ipcMain);
    this.#baseInput = input;
    const local = this.#createTarget(input);
    this.#targets.set(local.target.profile.id, local);
  }

  async start(): Promise<void> {
    const local = this.#requireTarget(LOCAL_RUNTIME_HOST_PROFILE.id);
    this.#publishState(local, {
      epoch: local.epoch,
      target: local.target,
      readiness: 'connecting',
    });
    try {
      local.lifecycle = await this.#startLifecycle(local, true);
      this.#activate(local);
    } catch (error) {
      local.valid = false;
      await this.#closeObservations(local.observations);
      this.#ipcMain.close();
      throw error;
    }
  }

  async handleBotIncomingMessage(message: BotIncomingMessage): Promise<void> {
    const target = this.#requireTarget(this.#defaultProfileId);
    if (target.state.readiness === 'unavailable') throw target.state.error;
    const candidate = await this.#waitForReadyCandidate(
      this.#requireLifecycle(target),
    );
    await candidate.botIncoming.handleBotIncomingMessage(message);
  }

  finalizePairing(profileId: string): Promise<void> {
    return this.#mutateTarget(profileId, async () => {
      await this.#finalizeAccessCredential(profileId, 'ready');
    });
  }

  finalizeGuestAccess(
    mountId: string,
    signal?: AbortSignal,
    onAccessActivated?: () => void,
    onFinalizationStarted?: () => void,
  ): Promise<RuntimeHostGuestAccessFinalization> {
    return this.#mutateTarget(mountId, () =>
      this.#finalizeAccessCredential(mountId, 'activation', signal, onAccessActivated, onFinalizationStarted),
    );
  }

  async #finalizeAccessCredential(
    profileId: string,
    completion: 'activation' | 'ready',
    externalSignal?: AbortSignal,
    onAccessActivated?: () => void,
    onFinalizationStarted?: () => void,
  ): Promise<RuntimeHostGuestAccessFinalization> {
    const target = this.#requireTarget(profileId);
    if (target.target.profile.kind !== 'remote') {
      throw new Error('Only remote Runtime Host profiles can finalize pairing');
    }
    const lifecycle = this.#requireLifecycle(target);
    const deadline = Date.now() + this.pairingFinalizationTimeoutMs;
    const timeout = new AbortController();
    const timer = setTimeout(
      () => timeout.abort(new RuntimeHostPairingFinalizationInterruptedError()),
      this.pairingFinalizationTimeoutMs,
    );
    const signal = AbortSignal.any([
      this.#shutdown.signal,
      timeout.signal,
      ...(externalSignal ? [externalSignal] : []),
    ]);
    let finalizationStarted = false;
    try {
      let candidate = await this.#waitForReadyCandidate(lifecycle, undefined, signal);
      while (true) {
        signal.throwIfAborted();
        if (!target.valid || candidate.client.hostId !== target.target.profile.rootId) {
          throw new Error('Runtime Host target changed before pairing was finalized');
        }
        try {
          const remainingMs = deadline - Date.now();
          if (remainingMs <= 0) throw new RuntimeHostPairingFinalizationInterruptedError();
          onFinalizationStarted?.();
          finalizationStarted = true;
          const finalized = await abortable(
            () => candidate.client.finalizeAccessCredential(remainingMs),
            signal,
          );
          notifyAccessActivated(onAccessActivated);
          if (finalized.reconnectRequired) {
            if (
              target.target.profile.kind === 'remote' &&
              target.target.profile.transport.kind === 'libp2p-direct'
            ) {
              target.skipPeerRouteRefreshOnce = true;
            }
            if (completion === 'activation') {
              try {
                await candidate.close();
              } catch (error) {
                // The Host already committed the credential. Candidate cleanup
                // cannot turn that durable success into a failed Guest import;
                // its closed signal still drives the reconnect lifecycle.
                this.#baseInput.onError?.(error);
              }
              return 'reconnecting';
            }
            await candidate.close();
            await this.#waitForReadyCandidate(lifecycle, candidate, signal);
          }
          if (completion === 'ready') signal.throwIfAborted();
          return 'ready';
        } catch (error) {
          if (pairingFinalizeTimedOut(error)) {
            throw new RuntimeHostPairingFinalizationInterruptedError({ cause: error });
          }
          const retry = pairingFinalizeRetry(error);
          if (!retry) throw error;
          candidate = await this.#waitForReadyCandidate(lifecycle, candidate, signal);
        }
      }
    } catch (error) {
      if (this.#shutdown.signal.aborted) {
        throw new RuntimeHostPairingFinalizationInterruptedError({ cause: error });
      }
      if (!finalizationStarted && timeout.signal.aborted && completion === 'activation') {
        throw (target.state.readiness !== 'ready' && target.state.error)
          || new Error('Unable to connect to the sharing host before the deadline');
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  current(profileId?: string): RuntimeHostDesktopTargetSnapshot | undefined {
    return this.#current(profileId ?? this.#defaultProfileId);
  }

  #current(profileId: string): RuntimeHostDesktopTargetSnapshot | undefined {
    const target = this.#targets.get(profileId);
    if (
      !target?.valid ||
      target.state.readiness === 'connecting' ||
      target.state.readiness === 'unavailable'
    ) return undefined;
    const candidate = target.lifecycle?.current;
    return {
      epoch: target.epoch,
      ...(target.hostId ? { hostId: target.hostId } : {}),
      target: target.target,
      readiness: candidate ? 'ready' : 'reconnecting',
      ...(candidate ? { candidate } : {}),
    };
  }

  entries(): readonly RuntimeHostDesktopTargetState[] {
    return [...this.#targets.values()].map((target) => target.state);
  }

  ownsScope(scope: { readonly hostId: string; readonly targetEpoch: string }): boolean {
    for (const target of this.#targets.values()) {
      if (target.epoch === scope.targetEpoch && target.hostId === scope.hostId) return true;
    }
    return false;
  }

  defaultProfileId(): string {
    return this.#defaultProfileId;
  }

  async stopSession(ref: DesktopTargetSessionRef): Promise<void> {
    if (this.#closed) return;
    const target = this.#targetForScope(ref);
    if (!target?.lifecycle) return;
    let candidate: DesktopRuntimeHostCandidate;
    try {
      candidate = await this.#waitForReadyCandidate(target.lifecycle);
    } catch (error) {
      if (!target.valid) return;
      throw error;
    }
    if (!target.valid || candidate.client.hostId !== ref.hostId) return;
    await candidate.stopSession(ref.sessionId);
  }

  async unobserveSession(observerId: string): Promise<void> {
    await Promise.all(
      [...this.#observationRegistries].map((observations) =>
        observations.unobserve(observerId),
      ),
    );
  }

  async closeTranscript(consumerId: string, targetId: number): Promise<void> {
    await Promise.all(
      [...this.#observationRegistries].map((observations) =>
        observations.closeTranscript(consumerId, targetId),
      ),
    );
  }

  acknowledgeTranscript(
    scope: { readonly hostId: string; readonly targetEpoch: string },
    consumerId: string,
    generation: string,
    deliverySequence: number,
    targetId: number,
  ): void {
    this.#targetForScope(scope)?.observations.acknowledgeTranscript(
      consumerId,
      generation,
      deliverySequence,
      targetId,
    );
  }

  async enable(
    profileTarget: DesktopRuntimeHostCandidateStartInput['profileTarget'],
    onHostStatus?: (status: HostStatusResult) => void,
  ): Promise<void> {
    if (!profileTarget) throw new Error('A non-local Runtime Host profile is required');
    if (isSessionGuestProfile(profileTarget.profile)) {
      throw new Error('Session Guest targets must be mounted instead of enabled as profiles');
    }
    return this.#mutateTarget(profileTarget.profile.id, (signal) =>
      this.#enable(profileTarget, false, signal, undefined, onHostStatus),
    );
  }

  mountGuest(
    profileTarget: NonNullable<DesktopRuntimeHostCandidateStartInput['profileTarget']>,
    onSessionCatalogChanged: () => void,
    signal?: AbortSignal,
    onConnectionPhase?: (phase: RuntimeHostConnectionPhase) => void,
    onHostStatus?: (status: HostStatusResult) => void,
  ): Promise<void> {
    if (!isSessionGuestProfile(profileTarget.profile)) {
      return Promise.reject(new Error('A Session Guest target is required'));
    }
    return this.#mutateTarget(profileTarget.profile.id, (connectionSignal) =>
      this.#enable(
        profileTarget,
        true,
        signal ? AbortSignal.any([signal, connectionSignal]) : connectionSignal,
        onConnectionPhase,
        onHostStatus,
        onSessionCatalogChanged,
      ),
    );
  }

  async #enable(
    profileTarget: NonNullable<DesktopRuntimeHostCandidateStartInput['profileTarget']>,
    allowSameRoot: boolean,
    signal?: AbortSignal,
    onConnectionPhase?: (phase: RuntimeHostConnectionPhase) => void,
    onHostStatus?: (status: HostStatusResult) => void,
    onGuestSessionCatalogChanged?: () => void,
  ): Promise<void> {
    signal?.throwIfAborted();
    if (this.#closed) throw new Error('Desktop Runtime Host manager is closed');
    const profileId = profileTarget.profile.id;
    if (profileId === LOCAL_RUNTIME_HOST_PROFILE.id) {
      throw new Error('Local Runtime Host is already enabled');
    }
    for (const target of this.#targets.values()) {
      if (target.target.profile.id === profileId) continue;
      const rootId = target.target.profile.kind !== 'local'
        ? target.target.profile.rootId
        : target.hostId;
      if (
        rootId === profileTarget.profile.rootId &&
        !allowSameRoot &&
        !isSessionGuestProfile(target.target.profile)
      ) {
        throw new Error(`Runtime Host ${profileTarget.profile.rootId} is already enabled`);
      }
    }
    const existing = this.#targets.get(profileId);
    if (
      existing?.valid &&
      sameResolvedRuntimeHostProfileTarget(existing.target, profileTarget)
    ) return;
    if (existing) await this.#removeTarget(existing);

    const target = this.#createTarget({
      ...withRuntimeHostTarget(this.#baseInput, profileTarget),
      ...(onConnectionPhase ? { onConnectionPhase } : {}),
      ...(onHostStatus ? { onHostStatus } : {}),
      ...(onGuestSessionCatalogChanged ? { onGuestSessionCatalogChanged } : {}),
    });
    this.#targets.set(profileId, target);
    this.#publishState(target, {
      epoch: target.epoch,
      target: target.target,
      readiness: 'connecting',
    });
    try {
      target.lifecycle = await this.#startLifecycle(target, false, signal);
      if (this.#closed) {
        await target.lifecycle.close();
        throw new Error('Desktop Runtime Host manager is closed');
      }
      if (!target.valid) {
        await target.lifecycle.close();
        throw target.state.readiness === 'unavailable'
          ? target.state.error
          : new Error('Desktop Runtime Host target became unavailable during startup');
      }
      this.#activate(target);
    } catch (error) {
      const alreadyUnavailable = target.state.readiness === 'unavailable';
      target.valid = false;
      this.#ipcMain.deactivate(target.epoch);
      await this.#closeObservations(target.observations);
      if (!alreadyUnavailable) {
        this.#publishState(target, {
          epoch: target.epoch,
          target: target.target,
          readiness: 'unavailable',
          ...(target.hostId ? { hostId: target.hostId } : {}),
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
      throw error;
    }
  }

  async disable(profileId: string): Promise<void> {
    if (profileId === LOCAL_RUNTIME_HOST_PROFILE.id) {
      throw new Error('Local Runtime Host cannot be disabled');
    }
    // Cancel both running and queued starts before waiting for their cleanup.
    this.#targetMutations.get(profileId)?.connectionAbort.abort(
      new Error('Runtime Host profile was disabled'),
    );
    return this.#mutateTarget(profileId, () => this.#disable(profileId));
  }

  unmountGuest(mountId: string): Promise<void> {
    return this.#mutateTarget(mountId, async () => {
      const target = this.#targets.get(mountId);
      if (target && !isSessionGuestProfile(target.target.profile)) {
        throw new Error('Runtime Host target is not a Session Guest mount');
      }
      await this.#disable(mountId);
    });
  }

  wakePeerRecovery(profileId?: string): void {
    for (const target of this.#targets.values()) {
      if (
        target.valid &&
        (profileId === undefined || target.target.profile.id === profileId) &&
        target.target.profile.kind === 'remote' &&
        target.target.profile.transport.kind === 'libp2p-direct'
      ) {
        target.lifecycle?.wake();
      }
    }
  }

  async waitUntilReady(
    profileId: string,
    previousHostEpoch?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const target = this.#requireTarget(profileId);
    let candidate = await this.#waitForReadyCandidate(
      this.#requireLifecycle(target),
      undefined,
      signal,
    );
    while (previousHostEpoch !== undefined && candidate.client.hostEpoch === previousHostEpoch) {
      candidate = await this.#waitForReadyCandidate(
        this.#requireLifecycle(target),
        candidate,
        signal,
      );
    }
  }

  async #disable(profileId: string): Promise<void> {
    if (profileId === LOCAL_RUNTIME_HOST_PROFILE.id) {
      throw new Error('Local Runtime Host cannot be disabled');
    }
    const target = this.#targets.get(profileId);
    if (!target) return;
    await this.#removeTarget(target);
  }

  runManagedLocalHostChange<T>(change: () => Promise<T>): Promise<T> {
    return this.#mutateTarget(LOCAL_RUNTIME_HOST_PROFILE.id, async () => {
      const lifecycle = this.#requireLifecycle(
        this.#requireTarget(LOCAL_RUNTIME_HOST_PROFILE.id),
      );
      const suspension = await lifecycle.suspend();
      try {
        if (suspension.current?.hostOwnership === 'owned_ephemeral') {
          throw new Error('The Local Runtime Host is not managed by a background service');
        }
        return await change();
      } finally {
        suspension.resume();
      }
    });
  }

  setDefaultProfile(profileId: string): void {
    this.#defaultProfileId = profileId;
    this.onDefaultProfileChanged?.(profileId);
  }

  async retireOwnedLocalHost(
    mode: RuntimeHostRetirementMode,
  ): Promise<DesktopLocalHostRetirement> {
    const result = await this.#prepareLocalHostRetirement(mode, 'replacement');
    if (result.kind === 'retired') await result.waitForExit();
    return result;
  }

  async prepareOwnedLocalHostQuit(
    mode: RuntimeHostRetirementMode,
  ): Promise<'ready' | 'active_tasks'> {
    const candidate = this.#targets.get(LOCAL_RUNTIME_HOST_PROFILE.id)?.lifecycle?.current;
    if (candidate?.hostOwnership !== 'owned_ephemeral') return 'ready';
    try {
      const result = await this.#prepareLocalHostRetirement(mode, 'quit');
      return result.kind === 'active_tasks' ? 'active_tasks' : 'ready';
    } catch {
      // An unreachable Host must not prevent quitting. Its launch-owner guard
      // remains armed and closes it when the Desktop process exits.
      return 'ready';
    }
  }

  #prepareLocalHostRetirement(
    mode: RuntimeHostRetirementMode,
    purpose: 'quit' | 'replacement',
  ): Promise<PreparedLocalHostRetirement> {
    if (this.#localHostRetirement) return Promise.resolve(this.#localHostRetirement);

    const activeTask = this.#localHostRetirementTask;
    if (activeTask) {
      if (
        activeTask.mode === 'refuse_active_work' &&
        mode === 'interrupt_active_work'
      ) {
        return activeTask.result.then((result) =>
          result.kind === 'active_tasks'
            ? this.#prepareLocalHostRetirement(mode, purpose)
            : result,
        );
      }
      return activeTask.result;
    }

    const result = this.#retireOwnedLocalHost(mode, purpose).finally(() => {
      if (this.#localHostRetirementTask?.result === result) {
        this.#localHostRetirementTask = undefined;
      }
    });
    this.#localHostRetirementTask = { mode, result };
    return result;
  }

  async #retireOwnedLocalHost(
    mode: RuntimeHostRetirementMode,
    purpose: 'quit' | 'replacement',
  ): Promise<PreparedLocalHostRetirement> {
    const target = this.#requireTarget(LOCAL_RUNTIME_HOST_PROFILE.id);
    const lifecycle = this.#requireLifecycle(target);
    const unavailable = this.#unavailableLocalHostRetirement(target);
    if (unavailable) return unavailable;
    let quiescence: Awaited<
      ReturnType<RuntimeHostReconnectLifecycle<DesktopRuntimeHostCandidate>['quiesce']>
    >;
    const admissionAbort = new AbortController();
    const admissionTimeout = setTimeout(
      () => admissionAbort.abort(new Error('Runtime Host did not reconnect before retirement')),
      LOCAL_HOST_RETIREMENT_ADMISSION_TIMEOUT_MS,
    );
    try {
      quiescence = await lifecycle.quiesce(admissionAbort.signal);
    } catch (error) {
      const terminal = this.#unavailableLocalHostRetirement(target, error);
      if (terminal) return terminal;
      if (admissionAbort.signal.aborted) {
        throw this.#localHostRetirementError(target, error) ?? error;
      }
      throw error;
    } finally {
      clearTimeout(admissionTimeout);
    }
    let hostPid = quiescence.current.hostPid;
    const retirementError = (cause: unknown) => new DesktopLocalHostRetirementError(
      {
        hostId: quiescence.current.client.hostId,
        hostEpoch: quiescence.current.client.hostEpoch,
        lifecycleMode: 'ephemeral',
        rootPath: this.#baseInput.rootPath,
        ...(hostPid === undefined ? {} : { pid: hostPid }),
      },
      { cause },
    );
    let launchBarrierPaused = false;
    const resume = () => {
      if (launchBarrierPaused) {
        launchBarrierPaused = false;
        this.#baseInput.candidateLaunchBarrier?.resume();
      }
      quiescence.resume();
    };
    try {
      if (quiescence.current.hostOwnership !== 'owned_ephemeral') {
        resume();
        return { kind: 'not_owned' };
      }
      this.#baseInput.candidateLaunchBarrier?.pause();
      launchBarrierPaused = this.#baseInput.candidateLaunchBarrier !== undefined;
      const diagnostics = await quiescence.current.client.queryHostDiagnostics();
      hostPid = diagnostics.pid;
      // The adopted Host still owns the root here, so every other owned launch
      // can be settled without allowing it to become a late election winner.
      await this.#baseInput.candidateLaunchBarrier?.retireExcept(diagnostics.pid);
      const result = await quiescence.current.client.prepareHostRetirement(
        mode,
        purpose === 'quit' ? { timeoutMs: 2_000, allowCooperativeHandoff: false } : undefined,
      );
      if (result.kind === 'active_tasks') {
        if (mode === 'interrupt_active_work') {
          throw new Error('Runtime Host refused authorized retirement');
        }
        resume();
        return result;
      }
      hostPid = result.pid;
      return this.#completeLocalHostRetirement(resume, async () => {
        try {
          await this.waitForHostExit(result.pid);
          target.lastCandidate = undefined;
        } catch (error) {
          throw retirementError(error);
        }
      });
    } catch (error) {
      resume();
      throw retirementError(error);
    }
  }

  #unavailableLocalHostRetirement(
    target: DesktopRuntimeHostTargetGeneration,
    cause: unknown = target.state.readiness === 'unavailable' ? target.state.error : undefined,
  ): Extract<DesktopLocalHostRetirement, { kind: 'not_owned' }> | undefined {
    if (target.state.readiness !== 'unavailable') return undefined;
    return this.#retirementWithoutCurrentHost(target, cause);
  }

  #retirementWithoutCurrentHost(
    target: DesktopRuntimeHostTargetGeneration,
    cause: unknown,
  ): Extract<DesktopLocalHostRetirement, { kind: 'not_owned' }> {
    const failure = this.#localHostRetirementError(target, cause);
    if (!failure || target.lastCandidate?.ownedProcess?.state === 'exited') {
      return { kind: 'not_owned' };
    }
    throw failure;
  }

  #localHostRetirementError(
    target: DesktopRuntimeHostTargetGeneration,
    cause: unknown,
  ): DesktopLocalHostRetirementError | undefined {
    const last = target.lastCandidate;
    if (!last || last.ownership !== 'owned_ephemeral') return undefined;
    return new DesktopLocalHostRetirementError(
      {
        hostId: last.hostId,
        hostEpoch: last.hostEpoch,
        lifecycleMode: 'ephemeral',
        rootPath: this.#baseInput.rootPath,
        ...(last.ownedProcess?.state === 'running'
          ? { pid: last.ownedProcess.pid }
          : {}),
      },
      { cause: cause instanceof Error ? cause : new Error(String(cause)) },
    );
  }

  #completeLocalHostRetirement(
    resume: () => void,
    waitForExit: () => Promise<void>,
  ): Extract<PreparedLocalHostRetirement, { kind: 'retired' }> {
    let active = true;
    let exitTask: Promise<void> | undefined;
    const retirement = {
      kind: 'retired' as const,
      waitForExit: () => {
        exitTask ??= waitForExit().catch((error: unknown) => {
          retirement.resume();
          throw error;
        });
        return exitTask;
      },
      resume: () => {
        if (!active) return;
        active = false;
        if (this.#localHostRetirement !== retirement) return;
        this.#localHostRetirement = undefined;
        if (this.#closed) return;
        resume();
      },
    };
    this.#localHostRetirement = retirement;
    return retirement;
  }

  close(): Promise<void> {
    this.#closeTask ??= this.#close();
    return this.#closeTask;
  }

  async #close(): Promise<void> {
    this.#closed = true;
    this.#shutdown.abort(new Error('Desktop Runtime Host manager is closed'));
    await Promise.allSettled([...this.#targetMutations.values()].map((mutation) => mutation.settled));
    const results = await Promise.allSettled(
      [...this.#targets.values()].map((target) => this.#removeTarget(target)),
    );
    // Owned candidates are deliberately not released here: a launcher that
    // exits without releasing them is their close authority, so keeping the
    // launch-owner guard armed is what retires an owned ephemeral Host on
    // quit.
    this.#ipcMain.close();
    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        'Unable to close every Desktop Runtime Host',
      );
    }
  }

  async #startLifecycle(
    target: DesktopRuntimeHostTargetGeneration,
    reportInitialFailure: boolean,
    initialSignal?: AbortSignal,
  ): Promise<RuntimeHostReconnectLifecycle<DesktopRuntimeHostCandidate>> {
    let starting = true;
    let initialAttempt = true;
    let fatalDuringStart: Error | undefined;
    const retryInitialFailure =
      target.target.profile.kind === 'remote' &&
      target.target.profile.transport.kind === 'libp2p-direct';
    try {
      const lifecycle = await startRuntimeHostReconnectLifecycle({
        connect: (signal) => {
          const first = initialAttempt;
          initialAttempt = false;
          return this.connect(
            target,
            signal,
            first ? target.input.profileTarget?.sshInteraction : 'batch',
            first ? target.input.onConnectionPhase : undefined,
          );
        },
        retryInitialFailure: retryInitialFailure
          ? (error) => !(error instanceof RuntimeHostPeerError && error.code === 'peer_capacity_exceeded')
          : false,
        initialSignal: AbortSignal.any([
          this.#shutdown.signal,
          ...(initialSignal ? [initialSignal] : []),
        ]),
        onReconnectError: (error) => {
          if (!target.valid || target.state.readiness === 'ready') return;
          const previous = target.state.error;
          const last = target.state.reconnect;
          const now = Date.now();
          // Keep one live diagnostic per outage, even when successive dials
          // fail differently. Routine retries must not evict unrelated logs.
          target.state = {
            ...target.state,
            error,
            reconnect: {
              failures: (last?.failures ?? 0) + 1,
              firstFailureAt: last?.firstFailureAt ?? now,
              lastFailureAt: now,
            },
          };
          if (!last) {
            if (error instanceof RuntimeHostPeerReachabilityUnavailableError ||
              error instanceof RuntimeHostPeerError) {
              console.info('[runtime-host] reconnecting:', {
                profileId: target.target.profile.id,
                code: error.code,
                message: error.message,
              });
            } else {
              console.warn('[runtime-host] reconnecting:', target.target.profile.id, error);
            }
          }
          if (previous?.name === error.name && previous.message === error.message &&
            ('code' in previous ? previous.code : undefined) ===
              ('code' in error ? error.code : undefined)) return;
          this.#publishState(target, target.state);
        },
        onFatalError: (error) => {
          if (starting) {
            fatalDuringStart = error;
          } else if (target.valid) {
            target.valid = false;
            target.unsubscribeLifecycle?.();
            target.unsubscribeRoutes?.();
            this.#ipcMain.deactivate(target.epoch);
            this.#publishState(target, {
              epoch: target.epoch,
              target: target.target,
              readiness: 'unavailable',
              ...(target.hostId ? { hostId: target.hostId } : {}),
              error,
            });
          }
          if (reportInitialFailure || !starting) this.onFatalError(error, target.target);
        },
        ...(this.reconnectBackoff ? { backoff: this.reconnectBackoff } : {}),
      });
      if (fatalDuringStart) {
        await lifecycle.close();
        throw fatalDuringStart;
      }
      return lifecycle;
    } finally {
      starting = false;
    }
  }

  private async connect(
    target: DesktopRuntimeHostTargetGeneration,
    signal: AbortSignal,
    sshInteraction: RuntimeHostSshInteraction | undefined,
    onConnectionPhase: ((phase: RuntimeHostConnectionPhase) => void) | undefined,
  ): Promise<DesktopRuntimeHostCandidate> {
    let localRecoveryAttempted = false;
    const inheritedExit = target.input.onExit;
    let refreshPeerRoutes = target.skipPeerRouteRefreshOnce !== true;
    target.skipPeerRouteRefreshOnce = false;
    const tryRecoverLocalHost = async (): Promise<boolean> => {
      if (target.input.profileTarget || localRecoveryAttempted || !this.recoverLocalHost) {
        return false;
      }
      localRecoveryAttempted = true;
      return this.recoverLocalHost(signal);
    };
    const resolveRepair = async (error: unknown): Promise<HostHandoffObservation<DesktopRuntimeHostCandidate> | undefined> => {
      if (target.input.profileTarget || !(error instanceof Error) ||
        !canRepairManagedRuntimeHostStartup(error) || !this.resolveStartupRepair) return undefined;
      let blocker: HostHandoffBlocker | undefined;
      let diagnostic = error.message;
      try {
        blocker = await this.resolveStartupRepair(error, signal);
      } catch (inspectionError) {
        signal.throwIfAborted();
        // The repair need is known; unavailable authority evidence must not
        // grant replacement rights or discard the live Retry/Cancel journey.
        diagnostic += '\n' + (inspectionError instanceof Error ? inspectionError.message : String(inspectionError));
      }
      return { kind: 'blocked', blocker: blocker ?? {
        identity: JSON.stringify([target.epoch, error.name, diagnostic]),
        target: { name: target.target.profile.name, location: 'local' },
        reason: 'repair', mayExitNaturally: false, diagnostic,
      } };
    };
    const observe = async (): Promise<HostHandoffObservation<DesktopRuntimeHostCandidate>> => {
    while (true) {
      let result: DesktopRuntimeHostCandidateStartResult;
      const ipcMain = this.#ipcMain.createTarget(target.epoch);
      try {
        result = await this.startCandidate(
          {
            ...target.input,
            onExit: (details) => this.#reportCandidateExit(inheritedExit, details),
            ...(target.input.profileTarget
              ? {
                  profileTarget: {
                    ...target.input.profileTarget,
                    ...(sshInteraction === undefined ? {} : { sshInteraction }),
                  },
                }
              : {}),
            ipcMain,
            isTargetActive: () => this.#ipcMain.isActive(target.epoch),
            isTargetValid: () => target.valid,
            // Import progress belongs to the initial connection only. Override
            // the callback inherited from target.input so reconnects cannot
            // replay one-shot join progress.
            onConnectionPhase: (phase) => onConnectionPhase?.(phase),
            ...(refreshPeerRoutes ? {} : { refreshPeerRoutes: false }),
            signal,
          },
          target.observations,
        );
        refreshPeerRoutes = true;
      } catch (error) {
        signal.throwIfAborted();
        if (target.input.profileTarget && error instanceof RuntimeHostRemoteCompatibilityError) {
          if (target.target.profile.kind === 'environment' && this.resolveWslHostHandoff) {
            try {
              return { kind: 'blocked', blocker: await this.resolveWslHostHandoff(target.target.profile, error, signal) };
            } catch (managementError) {
              signal.throwIfAborted();
              return { kind: 'blocked', blocker: {
                identity: JSON.stringify([target.epoch, error.hostEpoch, 'management-unavailable']),
                target: { name: target.target.profile.name, location: 'remote', rootId: target.target.profile.rootId, hostEpoch: error.hostEpoch },
                reason: 'unavailable', mayExitNaturally: false, manualRecheck: true,
                diagnostic: managementError instanceof Error ? managementError.message : String(managementError),
              } };
            }
          }
          return { kind: 'blocked', blocker: {
            identity: JSON.stringify([target.epoch, error.hostEpoch, error.details]),
            target: { name: target.target.profile.name, location: 'remote',
              ...(target.target.profile.kind === 'local' ? {} : { rootId: target.target.profile.rootId }),
              hostEpoch: error.hostEpoch },
            reason: 'upgrade', mayExitNaturally: false, manualRecheck: true, diagnostic: error.message,
          } };
        }
        if (await tryRecoverLocalHost()) continue;
        const repair = await resolveRepair(error);
        if (repair) return repair;
        throw error;
      }
      if (result.kind === 'ready') {
        ipcMain.completeRegistration();
        target.hostId = result.candidate.client.hostId;
        const previous = target.lastCandidate;
        const retainedOwnedProcess =
          previous?.hostId === result.candidate.client.hostId &&
          previous.hostEpoch === result.candidate.client.hostEpoch &&
          previous.ownership === 'owned_ephemeral' &&
          result.candidate.hostOwnership === 'owned_ephemeral' &&
          previous.ownedProcess?.pid === result.candidate.hostPid
            ? previous.ownedProcess
            : undefined;
        target.lastCandidate = {
          hostId: result.candidate.client.hostId,
          hostEpoch: result.candidate.client.hostEpoch,
          ownership: result.candidate.hostOwnership,
          ...(result.candidate.ownedProcess
            ? { ownedProcess: trackOwnedProcess(result.candidate.ownedProcess) }
            : retainedOwnedProcess
              ? { ownedProcess: retainedOwnedProcess }
              : {}),
        };
        return { kind: 'ready', value: result.candidate };
      }
      if (result.kind === 'incompatible' || result.kind === 'upgrade_required') {
        const conflict = result;
        const idleTakeover = result.kind === 'upgrade_required' && result.restartable &&
          !target.input.profileTarget && target.input.generation !== undefined;
        const cooperativeRetirement = !target.input.profileTarget &&
          result.registration.lifecycleMode === 'ephemeral' &&
          result.handshake?.activity?.cooperativeHandoff === true;
        const replacement = target.input.profileTarget
          ? undefined
          : this.#registeredEphemeralHostReplacement(target, result, signal) ??
            (await this.resolveLocalHostReplacement?.(result.registration, signal));
        return { kind: 'blocked', blocker: {
          identity: JSON.stringify([target.epoch, result.registration, result.processIdentity, replacement?.identity]),
          target: {
            name: target.target.profile.name,
            location: target.input.profileTarget ? 'remote' : 'local',
            rootId: result.registration.rootId,
            hostEpoch: result.registration.hostEpoch,
          },
          reason: 'upgrade',
          ...(result.handshake?.activity ? { activity: result.handshake.activity } : {}),
          mayExitNaturally: result.registration.lifecycleMode === 'ephemeral' &&
            result.handshake?.replacement === 'wait_for_idle_exit',
          ...((replacement || idleTakeover || cooperativeRetirement) ? { replacement: {
            kind: 'replace',
            canReplaceIdle: result.handshake?.state === 'ready' &&
              (cooperativeRetirement || idleTakeover || replacement?.canReplaceIdle === true),
            canInterrupt: replacement !== undefined,
            execute: async (policy, progress, _consent, attemptSignal) => {
              const retirementSignal = attemptSignal ? AbortSignal.any([signal, attemptSignal]) : signal;
              retirementSignal.throwIfAborted();
              progress('retiring');
              if (policy === 'refuse_active_work' && cooperativeRetirement) {
                const observed = await connectExistingRuntimeHost({
                  rootPath: target.input.rootPath,
                  protocol: { min: RUNTIME_HOST_PROTOCOL_VERSION, max: RUNTIME_HOST_PROTOCOL_VERSION },
                  compositionId: conflict.registration.compositionId,
                });
                if (observed.kind !== 'connected') return { kind: 'changed' };
                try {
                  if (observed.registration.rootId !== conflict.registration.rootId ||
                    observed.registration.hostEpoch !== conflict.registration.hostEpoch ||
                    !observed.connection.cooperativeHandoff) return { kind: 'changed' };
                  const prepared = await prepareConnectedRuntimeHostRetirement(
                    observed.connection, policy, 60_000, retirementSignal,
                  );
                  return { kind: prepared.kind === 'prepared' ? 'completed' : 'active_work' };
                } finally {
                  await observed.connection.close();
                }
              }
              if (policy === 'refuse_active_work' && idleTakeover) {
                const retired = await connectExistingRuntimeHost({
                  rootPath: target.input.rootPath,
                  protocol: { min: RUNTIME_HOST_PROTOCOL_VERSION, max: RUNTIME_HOST_PROTOCOL_VERSION },
                  compositionId: conflict.registration.compositionId,
                  generation: target.input.generation,
                  takeoverHostEpoch: conflict.registration.hostEpoch,
                });
                if (retired.kind === 'connected') await retired.connection.close();
                if (retired.kind === 'draining') return { kind: 'completed' };
                return { kind: 'registration' in retired &&
                  retired.registration?.hostEpoch === conflict.registration.hostEpoch ? 'active_work' : 'changed' };
              }
              if (!replacement) return { kind: 'changed' };
              const replaced = await replacement.replace(policy, progress, retirementSignal);
              return { kind: replaced === 'replaced' ? 'completed' : 'active_work' };
            },
          } } : {}),
        } };
      }
      if (await tryRecoverLocalHost()) continue;
      const failure = runtimeHostStartupError(result.reason, result.diagnostic);
      const repair = await resolveRepair(failure);
      if (repair) return repair;
      throw failure;
    }
    };
    try {
      return await runHostHandoff({ observe, openSurface: this.handoffSurface, signal });
    } catch (error) {
      if (error instanceof HostHandoffCancelledError) throw new RuntimeHostUpgradeCancelledError();
      throw error;
    }
  }

  #registeredEphemeralHostReplacement(
    target: DesktopRuntimeHostTargetGeneration,
    conflict: RuntimeHostWaitConflict | RuntimeHostRestartableConflict,
    signal: AbortSignal,
  ): RuntimeHostLocalReplacement | undefined {
    const { registration, processIdentity } = conflict;
    if (registration.lifecycleMode !== 'ephemeral' || !processIdentity) return undefined;
    const stillAuthorized = () =>
      !this.#closed &&
      !signal.aborted &&
      target.valid &&
      this.#targets.get(target.target.profile.id) === target;
    return {
      canReplaceIdle: false,
      replace: async (activeWorkPolicy, _progress, attemptSignal) => {
        // This Host cannot participate in the current retirement protocol, so
        // an earlier idle snapshot cannot prove that it remains idle. Require
        // explicit consent before using the identity-fenced termination path.
        if (activeWorkPolicy === 'refuse_active_work') return 'active_tasks';
        signal.throwIfAborted();
        attemptSignal?.throwIfAborted();
        const terminated = await this.forceTerminateObservedHost(
          {
            rootPath: this.#baseInput.rootPath,
            registration,
          },
          { processIdentity, isCurrent: () => stillAuthorized() && !attemptSignal?.aborted },
        );
        signal.throwIfAborted();
        if (!terminated) {
          throw new RuntimeHostPermanentReconnectError(
            'The older Runtime Host changed before it could be stopped safely',
          );
        }
        return 'replaced';
      },
    };
  }

  #requireLifecycle(
    target: DesktopRuntimeHostTargetGeneration,
  ): RuntimeHostReconnectLifecycle<DesktopRuntimeHostCandidate> {
    if (!target.lifecycle) throw new Error('Desktop Runtime Host target has not started');
    return target.lifecycle;
  }

  /** Desktop-owned candidate-exit diagnostics; honors an embedder-supplied sink. */
  #reportCandidateExit(
    inherited: ((details: CandidateExitDetails) => void) | undefined,
    details: CandidateExitDetails,
  ): void {
    inherited?.(details);
    if (details.code === 0 && details.signal === null) {
      console.info('[runtime-host] candidate exited cleanly', details);
      return;
    }
    console.error('[runtime-host] candidate exited unexpectedly', details);
  }

  async #waitForReadyCandidate(
    lifecycle: RuntimeHostReconnectLifecycle<DesktopRuntimeHostCandidate>,
    previous?: DesktopRuntimeHostCandidate,
    signal?: AbortSignal,
  ): Promise<DesktopRuntimeHostCandidate> {
    signal?.throwIfAborted();
    let candidate = await lifecycle.waitForCurrent(previous, signal);
    while (candidate.client.lifecycleState !== 'ready') {
      candidate = await lifecycle.waitForCurrent(candidate, signal);
    }
    return candidate;
  }

  #createTarget(
    input: DesktopRuntimeHostCandidateStartInput,
    observations = new RuntimeHostSessionObservationRegistry((error) => input.onError?.(error)),
  ): DesktopRuntimeHostTargetGeneration {
    this.#observationRegistries.add(observations);
    const target = input.profileTarget
      ? {
          profile: input.profileTarget.profile,
          ...(input.profileTarget.credential === undefined
            ? {}
            : { credential: input.profileTarget.credential }),
        }
      : { profile: LOCAL_RUNTIME_HOST_PROFILE };
    const epoch = randomUUID();
    return {
      epoch,
      input,
      target,
      observations,
      state: {
        epoch,
        target,
        readiness: 'connecting',
      },
      valid: true,
    };
  }

  async #closeObservations(observations: RuntimeHostSessionObservationRegistry): Promise<void> {
    try {
      await observations.close();
    } finally {
      this.#observationRegistries.delete(observations);
    }
  }

  #mutateTarget<T>(profileId: string, operation: (connectionSignal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.#closed) {
      return Promise.reject(new Error('Desktop Runtime Host manager is closed'));
    }
    const previous = this.#targetMutations.get(profileId);
    const connectionAbort = previous && !previous.connectionAbort.signal.aborted
      ? previous.connectionAbort : new AbortController();
    const pending = (previous?.settled ?? Promise.resolve()).then(() => operation(connectionAbort.signal));
    const settled = pending.then(
      () => undefined,
      () => undefined,
    ).finally(() => {
      if (this.#targetMutations.get(profileId)?.settled === settled) {
        this.#targetMutations.delete(profileId);
      }
    });
    this.#targetMutations.set(profileId, { settled, connectionAbort });
    return pending;
  }

  #activate(target: DesktopRuntimeHostTargetGeneration): void {
    this.#ipcMain.activate(target.epoch);
    const profile = target.target.profile;
    if (profile.kind === 'remote' && profile.transport.kind === 'libp2p-direct') {
      target.unsubscribeRoutes = this.#baseInput.peerClient?.subscribeRoutes(
        profile.transport.reachability.lease.peerId,
        () => target.lifecycle?.wake(),
      );
    }
    target.unsubscribeLifecycle = target.lifecycle?.subscribe((candidate) => {
      if (!target.valid) return;
      this.#publishState(
        target,
        candidate
          ? {
              epoch: target.epoch,
              target: target.target,
              readiness: 'ready',
              candidate,
            }
          : {
              epoch: target.epoch,
              target: target.target,
              readiness: 'reconnecting',
              ...(target.hostId ? { hostId: target.hostId } : {}),
            },
      );
    });
    const candidate = target.lifecycle?.current;
    this.#publishState(
      target,
      candidate
        ? {
            epoch: target.epoch,
            target: target.target,
            readiness: 'ready',
            candidate,
          }
        : {
            epoch: target.epoch,
            target: target.target,
            readiness: 'reconnecting',
            ...(target.hostId ? { hostId: target.hostId } : {}),
          },
    );
  }

  async #removeTarget(target: DesktopRuntimeHostTargetGeneration): Promise<void> {
    if (this.#targets.get(target.target.profile.id) === target) {
      this.#targets.delete(target.target.profile.id);
    }
    target.valid = false;
    this.onTargetRemoved?.(target.state);
    target.unsubscribeLifecycle?.();
    target.unsubscribeRoutes?.();
    this.#ipcMain.deactivate(target.epoch);
    try {
      await target.lifecycle?.close();
    } finally {
      await this.#closeObservations(target.observations);
    }
  }

  #targetForScope(scope: {
    readonly hostId: string;
    readonly targetEpoch: string;
  }): DesktopRuntimeHostTargetGeneration | undefined {
    for (const target of this.#targets.values()) {
      if (
        target.valid &&
        target.epoch === scope.targetEpoch &&
        target.hostId === scope.hostId
      ) return target;
    }
    return undefined;
  }

  #requireTarget(profileId: string): DesktopRuntimeHostTargetGeneration {
    const target = this.#targets.get(profileId);
    if (!target) throw new Error(`Runtime Host profile is not enabled: ${profileId}`);
    return target;
  }

  #publishState(
    target: DesktopRuntimeHostTargetGeneration,
    state: RuntimeHostDesktopTargetState,
  ): void {
    // A retry starting is not evidence of recovery. Keep its last failure until
    // a connection succeeds (or a newer failure replaces it).
    if (state.readiness !== 'ready' && target.state.readiness !== 'ready') {
      state = {
        ...state,
        ...(!state.error && target.state.error ? { error: target.state.error } : {}),
        ...(target.state.reconnect ? { reconnect: target.state.reconnect } : {}),
      };
    }
    if (state.readiness === 'ready' && target.state.reconnect) {
      console.info('[runtime-host] connection restored:', {
        profileId: target.target.profile.id,
        failedAttempts: target.state.reconnect.failures,
        durationMs: Math.max(0, Date.now() - target.state.reconnect.firstFailureAt),
      });
    }
    target.state = state;
    try {
      this.onTargetStateChanged?.(state);
    } catch (error) {
      this.onFatalError(
        error instanceof Error ? error : new Error(String(error)),
        target.target,
      );
    }
  }

}

function trackOwnedProcess(
  process: NonNullable<DesktopRuntimeHostCandidate['ownedProcess']>,
): DesktopOwnedProcessEvidence {
  const evidence: DesktopOwnedProcessEvidence = { pid: process.pid, state: 'running' };
  void process.exited.then(
    () => {
      evidence.state = 'exited';
    },
    () => {
      evidence.state = 'unknown';
    },
  );
  return evidence;
}

function pairingFinalizeRetry(error: unknown): boolean {
  // Finalization is idempotent for the current credential, so both a known
  // non-dispatch and an unknown outcome converge on the replacement connection.
  if (
    error instanceof RuntimeHostRequestInterruptedError &&
    error.operation === 'access.credential.finalize' &&
    error.reason === 'connection_lost'
  ) {
    return true;
  }
  if (error instanceof RuntimeHostOperationError && error.operation === 'access.credential.finalize') {
    return error.code === 'commit_outcome_unknown';
  }
  return false;
}

function pairingFinalizeTimedOut(error: unknown): boolean {
  return (
    error instanceof RuntimeHostRequestInterruptedError &&
    error.operation === 'access.credential.finalize' &&
    error.reason === 'timeout'
  );
}

function notifyAccessActivated(observer: (() => void) | undefined): void {
  try {
    observer?.();
  } catch {
    // Presentation progress cannot control credential finalization.
  }
}

function withRuntimeHostTarget(
  input: DesktopRuntimeHostCandidateStartInput,
  profileTarget: DesktopRuntimeHostCandidateStartInput['profileTarget'],
): DesktopRuntimeHostCandidateStartInput {
  const { profileTarget: _previousProfileTarget, ...base } = input;
  return profileTarget ? { ...base, profileTarget } : base;
}

function isSessionGuestProfile(
  profile: ResolvedRuntimeHostProfile['profile'],
): boolean {
  return profile.kind === 'remote' && profile.access === 'session_guest';
}

async function waitForProcessExit(pid: number): Promise<void> {
  // The Host owns a 10-second graceful-shutdown deadline. Keep a separate
  // observation margin so Desktop cannot race the Host's final process.exit.
  const deadline = Date.now() + 12_000;
  while (isProcessAlive(pid)) {
    if (Date.now() >= deadline) throw new Error('Runtime Host did not exit before retirement');
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      error instanceof Error &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ESRCH'
    );
  }
}

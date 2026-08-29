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
  RuntimeHostOperationError,
  RuntimeHostPermanentReconnectError,
  RuntimeHostRequestInterruptedError,
  runtimeHostStartupError,
  LOCAL_RUNTIME_HOST_PROFILE,
  sameResolvedRuntimeHostProfileTarget,
  startRuntimeHostReconnectLifecycle,
  type CandidateExitDetails,
  type ResolvedRuntimeHostProfile,
  type RuntimeHostReconnectBackoff,
  type RuntimeHostReconnectLifecycle,
  type RuntimeHostRetirementMode,
  type RuntimeHostSshInteraction,
} from '@maka/runtime-host/client';
import type { HostRegistration } from '@maka/runtime-host/protocol';
import type { DesktopTargetSessionRef } from '../shared/runtime-host-identity.js';
import {
  startDesktopRuntimeHostCandidate,
  type DesktopRuntimeHostCandidate,
  type DesktopRuntimeHostCandidateStartInput,
  type DesktopRuntimeHostCandidateStartResult,
} from './runtime-host-desktop-candidate.js';
import { RuntimeHostReconnectingIpcMain } from './runtime-host-reconnecting-ipc-main.js';
import { RuntimeHostSessionObservationRegistry } from './runtime-host-session-observation-registry.js';

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
  ): Promise<void>;
  disable(profileId: string): Promise<void>;
  waitUntilReady(
    profileId: string,
    previousHostEpoch?: string,
    signal?: AbortSignal,
  ): Promise<void>;
  runManagedLocalHostChange<T>(change: () => Promise<T>): Promise<T>;
  setDefaultProfile(profileId: string): void;
  retireOwnedLocalHost(mode: RuntimeHostRetirementMode): Promise<DesktopLocalHostRetirement>;
  close(): Promise<void>;
}

export interface RuntimeHostDesktopTargetSnapshot {
  readonly epoch: string;
  readonly hostId?: string;
  readonly target: ResolvedRuntimeHostProfile;
  readonly readiness: 'ready' | 'reconnecting';
  readonly candidate?: DesktopRuntimeHostCandidate;
}

export type RuntimeHostDesktopTargetState =
  | {
      readonly epoch: string;
      readonly target: ResolvedRuntimeHostProfile;
      readonly readiness: 'connecting' | 'reconnecting';
      readonly hostId?: string;
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
    };

export type DesktopLocalHostRetirement =
  | { readonly kind: 'active_tasks' }
  | { readonly kind: 'not_owned' }
  | { readonly kind: 'retired'; resume(): void };

interface DesktopLocalHostRetirementTask {
  readonly mode: RuntimeHostRetirementMode;
  readonly result: Promise<DesktopLocalHostRetirement>;
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

export type RuntimeHostRestartDecision = 'restart' | 'wait' | 'cancel';
export type RuntimeHostWaitDecision = 'wait' | 'cancel';

export class RuntimeHostUpgradeCancelledError extends RuntimeHostPermanentReconnectError {
  constructor() {
    super('Runtime Host restart was cancelled');
    this.name = 'RuntimeHostUpgradeCancelledError';
  }
}

export class RuntimeHostPairingFinalizationInterruptedError extends Error {
  constructor(options?: ErrorOptions) {
    super('Runtime Host pairing finalization was deferred until the next startup', options);
    this.name = 'RuntimeHostPairingFinalizationInterruptedError';
  }
}

const DEFAULT_PAIRING_FINALIZATION_TIMEOUT_MS = 30_000;

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

export interface RuntimeHostUpgradePrompts {
  restartable(
    conflict: RuntimeHostRestartableConflict,
  ): Promise<RuntimeHostRestartDecision>;
  waitOnly(conflict: RuntimeHostWaitConflict): Promise<RuntimeHostWaitDecision>;
}

interface DesktopRuntimeHostTargetGeneration {
  readonly epoch: string;
  readonly input: DesktopRuntimeHostCandidateStartInput;
  readonly target: ResolvedRuntimeHostProfile;
  readonly observations: RuntimeHostSessionObservationRegistry;
  state: RuntimeHostDesktopTargetState;
  hostId?: string;
  lifecycle?: RuntimeHostReconnectLifecycle<DesktopRuntimeHostCandidate>;
  unsubscribeLifecycle?: () => void;
  valid: boolean;
}

export async function startRuntimeHostDesktopManager(
  input: DesktopRuntimeHostCandidateStartInput,
  options: {
    startCandidate?: (
      input: DesktopRuntimeHostCandidateStartInput,
      observationRegistry: RuntimeHostSessionObservationRegistry,
    ) => Promise<DesktopRuntimeHostCandidateStartResult>;
    onFatalError?: (error: Error, target: ResolvedRuntimeHostProfile) => void;
    upgradePrompts?: RuntimeHostUpgradePrompts;
    waitForHostExit?: (pid: number) => Promise<void>;
    waitForHostRetirement?: (
      registration: HostRegistration,
      signal: AbortSignal,
    ) => Promise<void>;
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
    options.upgradePrompts,
    options.waitForHostExit ?? waitForProcessExit,
    options.waitForHostRetirement ?? waitForProcessRetirement,
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
  readonly #targetMutations = new Map<string, Promise<void>>();
  readonly #baseInput: DesktopRuntimeHostCandidateStartInput;
  readonly #pairingFinalizationShutdown = new AbortController();
  #defaultProfileId: string = LOCAL_RUNTIME_HOST_PROFILE.id;
  #localHostRetirement: Extract<DesktopLocalHostRetirement, { kind: 'retired' }> | undefined;
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
    private readonly upgradePrompts: RuntimeHostUpgradePrompts | undefined,
    private readonly waitForHostExit: (pid: number) => Promise<void>,
    private readonly waitForHostRetirement: (
      registration: HostRegistration,
      signal: AbortSignal,
    ) => Promise<void>,
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
    return this.#mutateTarget(profileId, () => this.#finalizePairing(profileId));
  }

  async #finalizePairing(profileId: string): Promise<void> {
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
      this.#pairingFinalizationShutdown.signal,
      timeout.signal,
    ]);
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
          const finalized = await candidate.client.finalizeAccessCredential(remainingMs);
          if (finalized.reconnectRequired) {
            await candidate.close();
            await this.#waitForReadyCandidate(lifecycle, candidate, signal);
          }
          return;
        } catch (error) {
          if (pairingFinalizeTimedOut(error)) {
            throw new RuntimeHostPairingFinalizationInterruptedError({ cause: error });
          }
          const retry = pairingFinalizeRetry(error);
          if (!retry) throw error;
          candidate = await this.#waitForReadyCandidate(lifecycle, candidate, signal);
        }
      }
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
  ): Promise<void> {
    if (!profileTarget) throw new Error('A non-local Runtime Host profile is required');
    return this.#mutateTarget(profileTarget.profile.id, () => this.#enable(profileTarget));
  }

  async #enable(
    profileTarget: NonNullable<DesktopRuntimeHostCandidateStartInput['profileTarget']>,
  ): Promise<void> {
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
      if (rootId === profileTarget.profile.rootId) {
        throw new Error(`Runtime Host ${profileTarget.profile.rootId} is already enabled`);
      }
    }
    const existing = this.#targets.get(profileId);
    if (
      existing?.valid &&
      sameResolvedRuntimeHostProfileTarget(existing.target, profileTarget)
    ) return;
    if (existing) await this.#removeTarget(existing);

    const target = this.#createTarget(withRuntimeHostTarget(this.#baseInput, profileTarget));
    this.#targets.set(profileId, target);
    this.#publishState(target, {
      epoch: target.epoch,
      target: target.target,
      readiness: 'connecting',
    });
    try {
      target.lifecycle = await this.#startLifecycle(target, false);
      if (this.#closed) {
        await target.lifecycle.close();
        throw new Error('Desktop Runtime Host manager is closed');
      }
      this.#activate(target);
    } catch (error) {
      target.valid = false;
      this.#ipcMain.deactivate(target.epoch);
      await this.#closeObservations(target.observations);
      this.#publishState(target, {
        epoch: target.epoch,
        target: target.target,
        readiness: 'unavailable',
        ...(target.hostId ? { hostId: target.hostId } : {}),
        error: error instanceof Error ? error : new Error(String(error)),
      });
      throw error;
    }
  }

  async disable(profileId: string): Promise<void> {
    return this.#mutateTarget(profileId, () => this.#disable(profileId));
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
      const quiescence = await lifecycle.quiesce();
      try {
        if (quiescence.current.hostOwnership !== 'supervised') {
          throw new Error('The Local Runtime Host is not managed by a background service');
        }
        return await change();
      } finally {
        quiescence.resume();
      }
    });
  }

  setDefaultProfile(profileId: string): void {
    this.#defaultProfileId = profileId;
    this.onDefaultProfileChanged?.(profileId);
  }

  retireOwnedLocalHost(
    mode: RuntimeHostRetirementMode,
  ): Promise<DesktopLocalHostRetirement> {
    if (this.#localHostRetirement) return Promise.resolve(this.#localHostRetirement);

    const activeTask = this.#localHostRetirementTask;
    if (activeTask) {
      if (
        activeTask.mode === 'refuse_active_work' &&
        mode === 'interrupt_active_work'
      ) {
        return activeTask.result.then((result) =>
          result.kind === 'active_tasks'
            ? this.retireOwnedLocalHost(mode)
            : result,
        );
      }
      return activeTask.result;
    }

    const result = this.#retireOwnedLocalHost(mode).finally(() => {
      if (this.#localHostRetirementTask?.result === result) {
        this.#localHostRetirementTask = undefined;
      }
    });
    this.#localHostRetirementTask = { mode, result };
    return result;
  }

  async #retireOwnedLocalHost(
    mode: RuntimeHostRetirementMode,
  ): Promise<DesktopLocalHostRetirement> {
    const lifecycle = this.#requireLifecycle(
      this.#requireTarget(LOCAL_RUNTIME_HOST_PROFILE.id),
    );
    const quiescence = await lifecycle.quiesce();
    let hostPid = quiescence.current.hostPid;
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
      const result = await quiescence.current.client.prepareHostRetirement(mode);
      if (result.kind === 'active_tasks') {
        if (mode === 'interrupt_active_work') {
          throw new Error('Runtime Host refused authorized retirement');
        }
        resume();
        return result;
      }
      await this.waitForHostExit(result.pid);
      return this.#completeLocalHostRetirement(resume);
    } catch (error) {
      resume();
      throw new DesktopLocalHostRetirementError(
        {
          hostId: quiescence.current.client.hostId,
          hostEpoch: quiescence.current.client.hostEpoch,
          lifecycleMode: 'ephemeral',
          rootPath: this.#baseInput.rootPath,
          ...(hostPid === undefined ? {} : { pid: hostPid }),
        },
        { cause: error },
      );
    }
  }

  #completeLocalHostRetirement(
    resume: () => void,
  ): Extract<DesktopLocalHostRetirement, { kind: 'retired' }> {
    let active = true;
    const retirement = {
      kind: 'retired' as const,
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
    this.#pairingFinalizationShutdown.abort(
      new RuntimeHostPairingFinalizationInterruptedError(),
    );
    await Promise.allSettled([...this.#targetMutations.values()]);
    const results = await Promise.allSettled(
      [...this.#targets.values()].map((target) => this.#removeTarget(target)),
    );
    const peerResults = await Promise.allSettled(
      this.#baseInput.peerClient ? [this.#baseInput.peerClient.close()] : [],
    );
    this.#baseInput.candidateLaunchBarrier?.release();
    this.#ipcMain.close();
    const failures = [...results, ...peerResults].filter(
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
  ): Promise<RuntimeHostReconnectLifecycle<DesktopRuntimeHostCandidate>> {
    let starting = true;
    try {
      return await startRuntimeHostReconnectLifecycle({
        connect: (signal) =>
          this.connect(
            target,
            signal,
            starting ? target.input.profileTarget?.sshInteraction : 'batch',
          ),
        onReconnectError: (error) => {
          console.warn('[runtime-host] reconnect attempt failed:', error);
        },
        onFatalError: (error) => {
          if (!starting && target.valid) {
            target.valid = false;
            target.unsubscribeLifecycle?.();
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
    } finally {
      starting = false;
    }
  }

  private async connect(
    target: DesktopRuntimeHostTargetGeneration,
    signal: AbortSignal,
    sshInteraction: RuntimeHostSshInteraction | undefined,
  ): Promise<DesktopRuntimeHostCandidate> {
    let takeoverHostEpoch: string | undefined;
    const inheritedExit = target.input.onExit;
    while (true) {
      const result = await this.startCandidate(
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
          ipcMain: this.#ipcMain.createTarget(target.epoch),
          isTargetActive: () => this.#ipcMain.isActive(target.epoch),
          isTargetValid: () => target.valid,
          signal,
          ...(takeoverHostEpoch === undefined ? {} : { takeoverHostEpoch }),
        },
        target.observations,
      );
      if (result.kind === 'ready') {
        target.hostId = result.candidate.client.hostId;
        return result.candidate;
      }
      if (result.kind === 'upgrade_required' && result.restartable) {
        const activity = result.handshake?.activity;
        const decision =
          activity &&
          activity.connections === 0 &&
          activity.activeOperations === 0 &&
          activity.residencies.length === 0
            ? 'restart'
            : await this.#resolveRestartable(result);
        if (decision === 'cancel') {
          throw new RuntimeHostUpgradeCancelledError();
        }
        if (decision === 'restart') {
          takeoverHostEpoch = result.registration.hostEpoch;
          continue;
        }
        takeoverHostEpoch = undefined;
        await this.waitForHostRetirement(result.registration, signal);
        continue;
      }
      if (
        result.kind === 'incompatible' ||
        (result.kind === 'upgrade_required' && !result.restartable)
      ) {
        const decision = await this.#resolveWaitOnly(result);
        if (decision === 'cancel') throw new RuntimeHostUpgradeCancelledError();
        takeoverHostEpoch = undefined;
        await this.waitForHostRetirement(result.registration, signal);
        continue;
      }
      throw runtimeHostStartupError(result.reason, result.diagnostic);
    }
  }

  #resolveRestartable(
    conflict: RuntimeHostRestartableConflict,
  ): Promise<RuntimeHostRestartDecision> {
    if (this.upgradePrompts) return this.upgradePrompts.restartable(conflict);
    return this.#missingUpgradePrompt();
  }

  #resolveWaitOnly(conflict: RuntimeHostWaitConflict): Promise<RuntimeHostWaitDecision> {
    if (this.upgradePrompts) return this.upgradePrompts.waitOnly(conflict);
    return this.#missingUpgradePrompt();
  }

  #missingUpgradePrompt(): never {
    throw new RuntimeHostPermanentReconnectError(
      'An older Runtime Host is still running. Restart it or wait for its background work to finish.',
    );
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

  #mutateTarget<T>(profileId: string, operation: () => Promise<T>): Promise<T> {
    if (this.#closed) {
      return Promise.reject(new Error('Desktop Runtime Host manager is closed'));
    }
    const previous = this.#targetMutations.get(profileId) ?? Promise.resolve();
    const pending = previous.catch(() => undefined).then(operation);
    const settled = pending.then(
      () => undefined,
      () => undefined,
    ).finally(() => {
      if (this.#targetMutations.get(profileId) === settled) {
        this.#targetMutations.delete(profileId);
      }
    });
    this.#targetMutations.set(profileId, settled);
    return pending;
  }

  #activate(target: DesktopRuntimeHostTargetGeneration): void {
    this.#ipcMain.activate(target.epoch);
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

function withRuntimeHostTarget(
  input: DesktopRuntimeHostCandidateStartInput,
  profileTarget: DesktopRuntimeHostCandidateStartInput['profileTarget'],
): DesktopRuntimeHostCandidateStartInput {
  const { profileTarget: _previousProfileTarget, ...base } = input;
  return profileTarget ? { ...base, profileTarget } : base;
}

function waitForAbortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function waitForProcessRetirement(
  registration: HostRegistration,
  signal: AbortSignal,
): Promise<void> {
  while (isProcessAlive(registration.pid)) {
    await waitForAbortableDelay(250, signal);
  }
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 10_000;
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

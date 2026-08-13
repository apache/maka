import { randomUUID } from 'node:crypto';
import type { BotIncomingMessage } from '@maka/runtime/bots';
import {
  RuntimeHostPermanentReconnectError,
  runtimeHostStartupError,
  LOCAL_RUNTIME_HOST_PROFILE,
  sameResolvedRuntimeHostProfileTarget,
  startRuntimeHostReconnectLifecycle,
  type ResolvedRuntimeHostProfile,
  type RuntimeHostReconnectBackoff,
  type RuntimeHostReconnectLifecycle,
  type RuntimeHostSshInteraction,
} from '@maka/runtime-host/client';
import type { HostRegistration } from '@maka/runtime-host/protocol';
import type { DesktopSessionRef } from '../preload/runtime-host-identity.js';
import {
  startDesktopRuntimeHostCandidate,
  type DesktopRuntimeHostCandidate,
  type DesktopRuntimeHostCandidateStartInput,
  type DesktopRuntimeHostCandidateStartResult,
} from './runtime-host-desktop-candidate.js';
import { RuntimeHostReconnectingIpcMain } from './runtime-host-reconnecting-ipc-main.js';
import { RuntimeHostSessionObservationRegistry } from './runtime-host-session-observation-registry.js';

export interface RuntimeHostDesktopOwner {
  current(): RuntimeHostDesktopTargetSnapshot | undefined;
  handleBotIncomingMessage(message: BotIncomingMessage): Promise<void>;
  stopSession(ref: DesktopSessionRef): Promise<void>;
  unobserveSession(observerId: string): Promise<void>;
  switchTarget(
    remote: DesktopRuntimeHostCandidateStartInput['remote'],
  ): Promise<void>;
  prepareForUpdate(
    allowInterruptActiveTasks: boolean,
  ): Promise<RuntimeHostUpdatePreparation>;
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
      readonly error: Error;
    };

export type RuntimeHostUpdatePreparation =
  | { readonly kind: 'active_tasks' }
  | { readonly kind: 'prepared'; rollback(): void };

export type RuntimeHostRestartDecision = 'restart' | 'wait' | 'cancel';
export type RuntimeHostWaitDecision = 'wait' | 'cancel';

export class RuntimeHostUpgradeCancelledError extends RuntimeHostPermanentReconnectError {
  constructor() {
    super('Runtime Host restart was cancelled');
    this.name = 'RuntimeHostUpgradeCancelledError';
  }
}

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
  hostId?: string;
  lifecycle?: RuntimeHostReconnectLifecycle<DesktopRuntimeHostCandidate>;
  unsubscribeLifecycle?: () => void;
  valid: boolean;
}

export async function startRuntimeHostDesktopOwner(
  input: DesktopRuntimeHostCandidateStartInput,
  options: {
    startCandidate?: (
      input: DesktopRuntimeHostCandidateStartInput,
      observationRegistry: RuntimeHostSessionObservationRegistry,
    ) => Promise<DesktopRuntimeHostCandidateStartResult>;
    onFatalError?: (error: Error) => void;
    upgradePrompts?: RuntimeHostUpgradePrompts;
    waitForHostExit?: (pid: number) => Promise<void>;
    waitForHostRetirement?: (
      registration: HostRegistration,
      signal: AbortSignal,
    ) => Promise<void>;
    reconnectBackoff?: RuntimeHostReconnectBackoff;
    onTargetStateChanged?: (state: RuntimeHostDesktopTargetState) => void;
  } = {},
): Promise<RuntimeHostDesktopOwner> {
  const owner = new RuntimeHostDesktopOwnerImpl(
    input,
    options.startCandidate ?? startDesktopRuntimeHostCandidate,
    options.onFatalError ?? ((error) => console.error('[runtime-host] reconnect failed:', error)),
    options.upgradePrompts,
    options.waitForHostExit ?? waitForProcessExit,
    options.waitForHostRetirement ?? waitForProcessRetirement,
    options.reconnectBackoff,
    options.onTargetStateChanged,
  );
  await owner.start();
  return owner;
}

class RuntimeHostDesktopOwnerImpl implements RuntimeHostDesktopOwner {
  readonly #ipcMain: RuntimeHostReconnectingIpcMain;
  readonly #observationRegistries = new Set<RuntimeHostSessionObservationRegistry>();
  #target: DesktopRuntimeHostTargetGeneration;
  #activeTarget: DesktopRuntimeHostTargetGeneration | undefined;
  #switchTail: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(
    input: DesktopRuntimeHostCandidateStartInput,
    private readonly startCandidate: (
      input: DesktopRuntimeHostCandidateStartInput,
      observationRegistry: RuntimeHostSessionObservationRegistry,
    ) => Promise<DesktopRuntimeHostCandidateStartResult>,
    private readonly onFatalError: (error: Error) => void,
    private readonly upgradePrompts: RuntimeHostUpgradePrompts | undefined,
    private readonly waitForHostExit: (pid: number) => Promise<void>,
    private readonly waitForHostRetirement: (
      registration: HostRegistration,
      signal: AbortSignal,
    ) => Promise<void>,
    private readonly reconnectBackoff: RuntimeHostReconnectBackoff | undefined,
    private readonly onTargetStateChanged:
      | ((state: RuntimeHostDesktopTargetState) => void)
      | undefined,
  ) {
    this.#ipcMain = new RuntimeHostReconnectingIpcMain(input.ipcMain);
    this.#target = this.#createTarget(input);
  }

  async start(): Promise<void> {
    this.#publishState({
      epoch: this.#target.epoch,
      target: this.#target.target,
      readiness: 'connecting',
    });
    try {
      this.#target.lifecycle = await this.#startLifecycle(this.#target, true);
      this.#activate(this.#target);
    } catch (error) {
      this.#target.valid = false;
      this.#activeTarget = undefined;
      await this.#closeObservations(this.#target.observations);
      this.#ipcMain.close();
      throw error;
    }
  }

  async handleBotIncomingMessage(message: BotIncomingMessage): Promise<void> {
    await this.#switchTail;
    const candidate = await this.#waitForReadyCandidate();
    await candidate.botIncoming.handleBotIncomingMessage(message);
  }

  current(): RuntimeHostDesktopTargetSnapshot | undefined {
    const target = this.#activeTarget;
    if (!target) return undefined;
    const candidate = target.lifecycle?.current;
    return {
      epoch: target.epoch,
      ...(target.hostId ? { hostId: target.hostId } : {}),
      target: target.target,
      readiness: candidate ? 'ready' : 'reconnecting',
      ...(candidate ? { candidate } : {}),
    };
  }

  stopSession(ref: DesktopSessionRef): Promise<void> {
    const precedingTransitions = this.#switchTail;
    return precedingTransitions.then(async () => {
      if (this.#closed) return;
      const target = this.#activeTarget;
      if (
        !target?.valid ||
        target.epoch !== ref.targetEpoch ||
        target.hostId !== ref.hostId ||
        !target.lifecycle
      ) return;
      let candidate: DesktopRuntimeHostCandidate;
      try {
        candidate = await this.#waitForReadyCandidate(target.lifecycle);
      } catch (error) {
        if (!target.valid || this.#activeTarget !== target) return;
        throw error;
      }
      if (
        !target.valid ||
        this.#activeTarget !== target ||
        candidate.client.hostId !== ref.hostId
      ) return;
      await candidate.stopSession(ref.sessionId);
    });
  }

  async unobserveSession(observerId: string): Promise<void> {
    await Promise.all(
      [...this.#observationRegistries].map((observations) =>
        observations.unobserve(observerId),
      ),
    );
  }

  switchTarget(
    remote: DesktopRuntimeHostCandidateStartInput['remote'],
  ): Promise<void> {
    const operation = this.#switchTail.then(() => this.#switchTarget(remote));
    this.#switchTail = operation.catch(() => undefined);
    return operation;
  }

  async prepareForUpdate(
    allowInterruptActiveTasks: boolean,
  ): Promise<RuntimeHostUpdatePreparation> {
    await this.#switchTail;
    const lifecycle = this.#requireLifecycle();
    const quiescence = lifecycle.quiesce();
    try {
      if (
        quiescence.current.hostLifecycleMode === 'service' ||
        quiescence.current.hostLifecycleMode === 'remote'
      ) {
        return { kind: 'prepared', rollback: quiescence.resume };
      }
      const result = await quiescence.current.client.prepareHostUpgrade(
        allowInterruptActiveTasks,
      );
      if (result.kind === 'active_tasks') {
        quiescence.resume();
        return result;
      }
      await this.waitForHostExit(result.pid);
      return { kind: 'prepared', rollback: quiescence.resume };
    } catch (error) {
      quiescence.resume();
      throw error;
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.#switchTail;
    this.#target.valid = false;
    this.#activeTarget = undefined;
    this.#target.unsubscribeLifecycle?.();
    this.#ipcMain.deactivate(this.#target.epoch);
    try {
      await this.#target.lifecycle?.close();
    } finally {
      try {
        await this.#closeObservations(this.#target.observations);
      } finally {
        this.#ipcMain.close();
      }
    }
  }

  async #switchTarget(
    remote: DesktopRuntimeHostCandidateStartInput['remote'],
  ): Promise<void> {
    if (this.#closed) throw new Error('Desktop Runtime Host owner is closed');
    if (this.#activeTarget && sameRuntimeHostTarget(this.#target.input.remote, remote)) return;

    const previousTarget = this.#target;
    const previousWasActive = this.#activeTarget === previousTarget;
    previousTarget.valid = false;
    previousTarget.unsubscribeLifecycle?.();
    this.#ipcMain.deactivate(previousTarget.epoch);
    this.#activeTarget = undefined;
    const nextTarget = this.#createTarget(withRuntimeHostTarget(previousTarget.input, remote));
    this.#target = nextTarget;
    this.#publishState({
      epoch: nextTarget.epoch,
      target: nextTarget.target,
      readiness: 'connecting',
    });
    await previousTarget.lifecycle?.close();
    if (!previousWasActive) await this.#closeObservations(previousTarget.observations);
    if (this.#closed) throw new Error('Desktop Runtime Host owner is closed');

    try {
      nextTarget.lifecycle = await this.#startLifecycle(nextTarget, false);
    } catch (switchError) {
      nextTarget.valid = false;
      await this.#closeObservations(nextTarget.observations);
      if (!previousWasActive) {
        this.#publishState({
          epoch: nextTarget.epoch,
          target: nextTarget.target,
          readiness: 'unavailable',
          error: switchError instanceof Error ? switchError : new Error(String(switchError)),
        });
        throw switchError;
      }
      const rollbackTarget = this.#createTarget(
        previousTarget.input,
        previousTarget.observations,
      );
      rollbackTarget.hostId = previousTarget.hostId;
      this.#target = rollbackTarget;
      this.#activeTarget = rollbackTarget;
      this.#publishState({
        epoch: rollbackTarget.epoch,
        target: rollbackTarget.target,
        readiness: 'connecting',
        ...(rollbackTarget.hostId ? { hostId: rollbackTarget.hostId } : {}),
      });
      this.#ipcMain.activate(rollbackTarget.epoch);
      try {
        rollbackTarget.lifecycle = await this.#startLifecycle(rollbackTarget, false);
      } catch (rollbackError) {
        rollbackTarget.valid = false;
        this.#activeTarget = undefined;
        this.#ipcMain.deactivate(rollbackTarget.epoch);
        await this.#closeObservations(rollbackTarget.observations);
        const failure = new AggregateError(
          [switchError, rollbackError],
          'Runtime Host switch failed and the previous Host could not be restored',
        );
        this.#target = nextTarget;
        this.#publishState({
          epoch: nextTarget.epoch,
          target: nextTarget.target,
          readiness: 'unavailable',
          error: failure,
        });
        throw failure;
      }
      this.#activate(rollbackTarget);
      throw switchError;
    }
    this.#activate(nextTarget);
    await this.#closeObservations(previousTarget.observations);
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
            starting ? target.input.remote?.sshInteraction : 'batch',
          ),
        onFatalError: (error) => {
          if (!starting && this.#activeTarget === target) {
            target.valid = false;
            target.unsubscribeLifecycle?.();
            this.#activeTarget = undefined;
            this.#ipcMain.deactivate(target.epoch);
            this.#publishState({
              epoch: target.epoch,
              target: target.target,
              readiness: 'unavailable',
              error,
            });
          }
          if (reportInitialFailure || !starting) this.onFatalError(error);
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
    while (true) {
      const result = await this.startCandidate(
        {
          ...target.input,
          ...(target.input.remote
            ? {
                remote: {
                  ...target.input.remote,
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
        const decision = await this.#resolveRestartable(result);
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
      throw runtimeHostStartupError(result.reason);
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

  #requireLifecycle(): RuntimeHostReconnectLifecycle<DesktopRuntimeHostCandidate> {
    if (!this.#target.lifecycle) throw new Error('Desktop Runtime Host owner has not started');
    return this.#target.lifecycle;
  }

  async #waitForReadyCandidate(
    lifecycle = this.#requireLifecycle(),
  ): Promise<DesktopRuntimeHostCandidate> {
    let candidate = await lifecycle.waitForCurrent();
    while (candidate.client.lifecycleState !== 'ready') {
      candidate = await lifecycle.waitForCurrent(candidate);
    }
    return candidate;
  }

  #createTarget(
    input: DesktopRuntimeHostCandidateStartInput,
    observations = new RuntimeHostSessionObservationRegistry((error) => input.onError?.(error)),
  ): DesktopRuntimeHostTargetGeneration {
    this.#observationRegistries.add(observations);
    return {
      epoch: randomUUID(),
      input,
      target: input.remote
        ? {
            profile: input.remote.profile,
            credential: input.remote.credential,
          }
        : { profile: LOCAL_RUNTIME_HOST_PROFILE },
      observations,
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

  #activate(target: DesktopRuntimeHostTargetGeneration): void {
    this.#target = target;
    this.#activeTarget = target;
    this.#ipcMain.activate(target.epoch);
    target.unsubscribeLifecycle = target.lifecycle?.subscribe((candidate) => {
      if (!target.valid || this.#activeTarget !== target) return;
      this.#publishState(
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

  #publishState(state: RuntimeHostDesktopTargetState): void {
    try {
      this.onTargetStateChanged?.(state);
    } catch (error) {
      this.onFatalError(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

function sameRuntimeHostTarget(
  left: DesktopRuntimeHostCandidateStartInput['remote'],
  right: DesktopRuntimeHostCandidateStartInput['remote'],
): boolean {
  if (!left || !right) return left === right;
  return sameResolvedRuntimeHostProfileTarget(left, right);
}

function withRuntimeHostTarget(
  input: DesktopRuntimeHostCandidateStartInput,
  remote: DesktopRuntimeHostCandidateStartInput['remote'],
): DesktopRuntimeHostCandidateStartInput {
  const { remote: _previousRemote, ...base } = input;
  return remote ? { ...base, remote } : base;
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
    if (Date.now() >= deadline) throw new Error('Runtime Host did not exit before update');
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

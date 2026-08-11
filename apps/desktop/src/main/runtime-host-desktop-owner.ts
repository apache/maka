import type { BotIncomingMessage } from '@maka/runtime/bots';
import {
  RuntimeHostPermanentReconnectError,
  startRuntimeHostReconnectLifecycle,
  type RuntimeHostReconnectBackoff,
  type RuntimeHostReconnectLifecycle,
} from '@maka/runtime-host/client';
import type { HostRegistration } from '@maka/runtime-host/protocol';
import {
  startDesktopRuntimeHostCandidate,
  type DesktopRuntimeHostCandidate,
  type DesktopRuntimeHostCandidateStartInput,
  type DesktopRuntimeHostCandidateStartResult,
} from './runtime-host-desktop-candidate.js';
import { RuntimeHostReconnectingIpcMain } from './runtime-host-reconnecting-ipc-main.js';
import { RuntimeHostSessionObservationRegistry } from './runtime-host-session-observation-registry.js';

export interface RuntimeHostDesktopOwner {
  handleBotIncomingMessage(message: BotIncomingMessage): Promise<void>;
  stopSession(sessionId: string): Promise<void>;
  prepareForUpdate(
    allowInterruptActiveTasks: boolean,
  ): Promise<RuntimeHostUpdatePreparation>;
  close(): Promise<void>;
}

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
  );
  await owner.start();
  return owner;
}

class RuntimeHostDesktopOwnerImpl implements RuntimeHostDesktopOwner {
  readonly #ipcMain: RuntimeHostReconnectingIpcMain;
  readonly #sessionObservations: RuntimeHostSessionObservationRegistry;
  #lifecycle: RuntimeHostReconnectLifecycle<DesktopRuntimeHostCandidate> | undefined;

  constructor(
    private readonly input: DesktopRuntimeHostCandidateStartInput,
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
  ) {
    this.#ipcMain = new RuntimeHostReconnectingIpcMain(this.input.ipcMain);
    this.#sessionObservations = new RuntimeHostSessionObservationRegistry(
      (error) => this.input.onError?.(error),
    );
  }

  async start(): Promise<void> {
    try {
      this.#lifecycle = await startRuntimeHostReconnectLifecycle({
        connect: (signal) => this.connect(signal),
        onFatalError: this.onFatalError,
        ...(this.reconnectBackoff ? { backoff: this.reconnectBackoff } : {}),
      });
    } catch (error) {
      await this.#sessionObservations.close();
      this.#ipcMain.close();
      throw error;
    }
  }

  async handleBotIncomingMessage(message: BotIncomingMessage): Promise<void> {
    const candidate = await this.#waitForReadyCandidate();
    await candidate.botIncoming.handleBotIncomingMessage(message);
  }

  async stopSession(sessionId: string): Promise<void> {
    const candidate = await this.#waitForReadyCandidate();
    await candidate.stopSession(sessionId);
  }

  async prepareForUpdate(
    allowInterruptActiveTasks: boolean,
  ): Promise<RuntimeHostUpdatePreparation> {
    const lifecycle = this.#requireLifecycle();
    const quiescence = lifecycle.quiesce();
    try {
      if (quiescence.current.hostLifecycleMode === 'service') {
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
    try {
      await this.#lifecycle?.close();
    } finally {
      try {
        await this.#sessionObservations.close();
      } finally {
        this.#ipcMain.close();
      }
    }
  }

  private async connect(signal: AbortSignal): Promise<DesktopRuntimeHostCandidate> {
    let takeoverHostEpoch: string | undefined;
    while (true) {
      const result = await this.startCandidate(
        {
          ...this.input,
          ipcMain: this.#ipcMain,
          signal,
          ...(takeoverHostEpoch === undefined ? {} : { takeoverHostEpoch }),
        },
        this.#sessionObservations,
      );
      if (result.kind === 'ready') return result.candidate;
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
      throw new Error(`Runtime Host startup failed: ${result.reason}`);
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
    if (!this.#lifecycle) throw new Error('Desktop Runtime Host owner has not started');
    return this.#lifecycle;
  }

  async #waitForReadyCandidate(): Promise<DesktopRuntimeHostCandidate> {
    const lifecycle = this.#requireLifecycle();
    let candidate = await lifecycle.waitForCurrent();
    while (candidate.client.lifecycleState !== 'ready') {
      candidate = await lifecycle.waitForCurrent(candidate);
    }
    return candidate;
  }
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

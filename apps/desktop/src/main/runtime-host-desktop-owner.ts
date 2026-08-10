import type { BotIncomingMessage } from '@maka/runtime';
import {
  RuntimeHostPermanentReconnectError,
  startRuntimeHostReconnectLifecycle,
  type RuntimeHostReconnectBackoff,
  type RuntimeHostReconnectLifecycle,
} from '@maka/runtime-host/client';
import { RUNTIME_HOST_COMPATIBILITY_EPOCH } from '@maka/runtime-host/protocol';
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
  close(): Promise<void>;
}

export async function startRuntimeHostDesktopOwner(
  input: DesktopRuntimeHostCandidateStartInput,
  options: {
    startCandidate?: (
      input: DesktopRuntimeHostCandidateStartInput,
      observationRegistry: RuntimeHostSessionObservationRegistry,
    ) => Promise<DesktopRuntimeHostCandidateStartResult>;
    onFatalError?: (error: Error) => void;
    reconnectBackoff?: RuntimeHostReconnectBackoff;
  } = {},
): Promise<RuntimeHostDesktopOwner> {
  const owner = new RuntimeHostDesktopOwnerImpl(
    input,
    options.startCandidate ?? startDesktopRuntimeHostCandidate,
    options.onFatalError ?? ((error) => console.error('[runtime-host] reconnect failed:', error)),
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
    const result = await this.startCandidate(
      { ...this.input, ipcMain: this.#ipcMain, signal },
      this.#sessionObservations,
    );
    if (result.kind === 'ready') return result.candidate;
    if (result.kind === 'incompatible') {
      if (result.handshake.compatibilityEpoch < RUNTIME_HOST_COMPATIBILITY_EPOCH) {
        throw new RuntimeHostPermanentReconnectError(
          'An older Maka process is still running and is incompatible with this build. Fully quit the previous Maka Desktop process, then start Maka again.',
        );
      }
      throw new RuntimeHostPermanentReconnectError(
        `Runtime Host is incompatible (protocol ${result.handshake.protocolMin}-${result.handshake.protocolMax}; ${result.handshake.replacement})`,
      );
    }
    throw new Error(`Runtime Host startup failed: ${result.reason}`);
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

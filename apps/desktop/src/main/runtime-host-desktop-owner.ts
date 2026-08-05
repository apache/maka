import type { BotIncomingMessage } from '@maka/runtime';
import {
  startDesktopRuntimeHostCandidate,
  type DesktopRuntimeHostCandidate,
  type DesktopRuntimeHostCandidateStartInput,
  type DesktopRuntimeHostCandidateStartResult,
} from './runtime-host-desktop-candidate.js';

const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_DELAY_MS = 250;

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
    ) => Promise<DesktopRuntimeHostCandidateStartResult>;
    onFatalError?: (error: Error) => void;
  } = {},
): Promise<RuntimeHostDesktopOwner> {
  const owner = new RuntimeHostDesktopOwnerImpl(
    input,
    options.startCandidate ?? startDesktopRuntimeHostCandidate,
    options.onFatalError ?? ((error) => console.error('[runtime-host] reconnect failed:', error)),
  );
  await owner.start();
  return owner;
}

class RuntimeHostDesktopOwnerImpl implements RuntimeHostDesktopOwner {
  #candidate: DesktopRuntimeHostCandidate | undefined;
  #generation = 0;
  #closed = false;
  #closeTask: Promise<void> | undefined;

  constructor(
    private readonly input: DesktopRuntimeHostCandidateStartInput,
    private readonly startCandidate: (
      input: DesktopRuntimeHostCandidateStartInput,
    ) => Promise<DesktopRuntimeHostCandidateStartResult>,
    private readonly onFatalError: (error: Error) => void,
  ) {}

  async start(): Promise<void> {
    const candidate = await this.connect();
    this.install(candidate);
  }

  async handleBotIncomingMessage(message: BotIncomingMessage): Promise<void> {
    const candidate = this.#candidate;
    if (!candidate || this.#closed) return;
    await candidate.botIncoming.handleBotIncomingMessage(message);
  }

  async stopSession(sessionId: string): Promise<void> {
    const candidate = this.#candidate;
    if (!candidate || this.#closed) return;
    await candidate.stopSession(sessionId);
  }

  close(): Promise<void> {
    this.#closeTask ??= this.closeOwner();
    return this.#closeTask;
  }

  private async closeOwner(): Promise<void> {
    this.#closed = true;
    this.#generation += 1;
    const candidate = this.#candidate;
    this.#candidate = undefined;
    await candidate?.close();
  }

  private install(candidate: DesktopRuntimeHostCandidate): void {
    if (this.#closed) {
      void candidate.close();
      return;
    }
    this.#candidate = candidate;
    const generation = ++this.#generation;
    void candidate.closed.then(
      () => this.reconnect(generation),
      () => this.reconnect(generation),
    );
  }

  private async reconnect(generation: number): Promise<void> {
    if (this.#closed || generation !== this.#generation) return;
    this.#candidate = undefined;
    for (let attempt = 0; attempt < MAX_RECONNECT_ATTEMPTS; attempt += 1) {
      if (this.#closed || generation !== this.#generation) return;
      if (attempt > 0) await delay(RECONNECT_DELAY_MS);
      try {
        const candidate = await this.connect();
        if (this.#closed || generation !== this.#generation) {
          await candidate.close();
          return;
        }
        this.install(candidate);
        return;
      } catch (error) {
        if (attempt + 1 === MAX_RECONNECT_ATTEMPTS) {
          this.onFatalError(asError(error));
        }
      }
    }
  }

  private async connect(): Promise<DesktopRuntimeHostCandidate> {
    const result = await this.startCandidate(this.input);
    if (result.kind === 'ready') return result.candidate;
    if (result.kind === 'incompatible') {
      throw new Error(
        `Runtime Host is incompatible (protocol ${result.handshake.protocolMin}-${result.handshake.protocolMax}; ${result.handshake.replacement})`,
      );
    }
    throw new Error(`Runtime Host startup failed: ${result.reason}`);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

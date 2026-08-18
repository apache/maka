import type {
  ExtensionTimerAuthority,
  ExtensionTimerContribution,
  ExtensionTimerContributionInspection,
} from '@maka/runtime/extension-timer-contributions';
import type { MakaContributionContext } from '@maka/runtime/plugin-runtime';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const STATE_FILE = 'extension-timers-v1.json';
const MAX_STATE_BYTES = 2 * 1024 * 1024;
const MAX_TIMEOUT_MS = 2_147_483_647;

interface TimerState {
  readonly bindingId: string;
  readonly scopeId: string;
  readonly extensionId: string;
  readonly revision: string;
  readonly id: string;
  readonly intervalMs: number;
  nextRunAt: number;
  running: boolean;
  lastStartedAt?: number;
  lastSucceededAt?: number;
  lastError?: string;
}

interface ActiveTimer {
  readonly token: symbol;
  readonly runtimeContext: MakaContributionContext['runtimeContext'];
  readonly contribution: ExtensionTimerContribution;
  readonly configuration: Readonly<Record<string, string | number | boolean>>;
  readonly state: TimerState;
  handle?: NodeJS.Timeout;
}

/** Host-owned, durable scheduler for trusted in-process Extension Timer invocations. */
export class HostExtensionTimerScheduler implements ExtensionTimerAuthority {
  readonly path: string | undefined;
  readonly #states = new Map<string, TimerState>();
  readonly #active = new Map<string, ActiveTimer[]>();
  #loaded = false;
  #closed = false;
  #draining = false;
  #tail: Promise<void> = Promise.resolve();

  constructor(
    controlDirectory?: string,
    private readonly cwdForScope: (scopeId: string) => string | Promise<string> = () =>
      process.cwd(),
  ) {
    this.path = controlDirectory ? join(controlDirectory, STATE_FILE) : undefined;
  }

  async register(
    context: MakaContributionContext,
    contribution: ExtensionTimerContribution,
  ): Promise<() => Promise<void>> {
    if (this.#closed) throw new Error('Extension Timer scheduler is closed');
    await this.#load();
    const key = timerKey(context.bindingId, contribution.id);
    const stack = this.#active.get(key) ?? [];
    const previous = stack.at(-1);
    if (previous?.handle) clearTimeout(previous.handle);
    const persisted = this.#states.get(key);
    const reusable =
      persisted?.scopeId === context.scopeId &&
      persisted.extensionId === context.extensionId &&
      persisted.revision === context.revision &&
      persisted.intervalMs === contribution.intervalMs;
    const state: TimerState = reusable
      ? persisted
      : {
          bindingId: context.bindingId,
          scopeId: context.scopeId,
          extensionId: context.extensionId,
          revision: context.revision,
          id: contribution.id,
          intervalMs: contribution.intervalMs,
          nextRunAt: Date.now() + contribution.initialDelayMs,
          running: false,
        };
    state.running = false;
    this.#states.set(key, state);
    const active: ActiveTimer = {
      token: Symbol(key),
      runtimeContext: context.runtimeContext,
      contribution,
      configuration: Object.freeze({ ...contribution.configuration }),
      state,
    };
    this.#active.set(key, [...stack, active]);
    await this.#persistQueued();
    this.#scheduleWhenActive(key, active);
    return async () => {
      const current = this.#active.get(key) ?? [];
      const wasCurrent = current.at(-1)?.token === active.token;
      const remaining = current.filter((entry) => entry.token !== active.token);
      if (remaining.length === current.length) return;
      if (active.handle) clearTimeout(active.handle);
      if (remaining.length === 0) {
        this.#active.delete(key);
        if (!this.#draining) this.#states.delete(key);
      } else {
        this.#active.set(key, remaining);
        const restored = remaining.at(-1)!;
        this.#states.set(key, restored.state);
        if (wasCurrent && !restored.state.running) this.#scheduleWhenActive(key, restored);
      }
      await this.#persistQueued();
    };
  }

  beginDrain(): void {
    this.#draining = true;
  }

  inspect(scopeId?: string): readonly ExtensionTimerContributionInspection[] {
    return Object.freeze(
      [...this.#states.values()]
        .filter((state) => scopeId === undefined || state.scopeId === scopeId)
        .map((state) => Object.freeze({ ...state }))
        .sort(
          (left, right) =>
            left.scopeId.localeCompare(right.scopeId) || left.id.localeCompare(right.id),
        ),
    );
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const stack of this.#active.values()) {
      for (const active of stack) if (active.handle) clearTimeout(active.handle);
    }
    this.#active.clear();
    await this.#tail;
  }

  #scheduleWhenActive(key: string, active: ActiveTimer): void {
    if (this.#closed || this.#current(key)?.token !== active.token) return;
    if (active.runtimeContext.fiber.state === 2) {
      this.#schedule(key, active);
      return;
    }
    if (active.runtimeContext.fiber.state !== 0 && active.runtimeContext.fiber.state !== 1) return;
    active.handle = setTimeout(() => this.#scheduleWhenActive(key, active), 0);
    active.handle.unref?.();
  }

  #schedule(key: string, active: ActiveTimer): void {
    if (this.#closed || this.#current(key)?.token !== active.token) return;
    const delay = Math.max(0, Math.min(MAX_TIMEOUT_MS, active.state.nextRunAt - Date.now()));
    active.handle = setTimeout(() => void this.#fire(key, active), delay);
    active.handle.unref?.();
  }

  async #fire(key: string, active: ActiveTimer): Promise<void> {
    if (this.#closed || this.#current(key)?.token !== active.token) return;
    const scheduledAt = active.state.nextRunAt;
    const now = Date.now();
    const elapsed = Math.max(0, now - scheduledAt);
    const skipped = Math.floor(elapsed / active.state.intervalMs);
    active.state.nextRunAt = scheduledAt + (skipped + 1) * active.state.intervalMs;
    active.state.running = true;
    active.state.lastStartedAt = now;
    delete active.state.lastError;
    // Advance durably before invoking: a crash can skip this fire, but can never duplicate it.
    await this.#persistQueued().catch((error) => {
      active.state.running = false;
      active.state.lastError = boundedError(error);
    });
    if (active.state.lastError) {
      this.#schedule(key, active);
      return;
    }

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error(`Extension Timer timed out: ${active.state.id}`)),
      active.contribution.timeoutMs,
    );
    timeout.unref?.();
    try {
      const cwd = await this.cwdForScope(active.state.scopeId);
      await active.contribution.invoke(structuredClone(active.contribution.payload ?? null), {
        sessionId: active.state.scopeId,
        turnId: `timer:${active.state.id}:${scheduledAt}`,
        cwd,
        permissionMode: 'default',
        origin: 'host',
        configuration: active.configuration,
        signal: controller.signal,
        scheduledAt,
      });
      active.state.lastSucceededAt = Date.now();
      delete active.state.lastError;
    } catch (error) {
      active.state.lastError = boundedError(error);
    } finally {
      clearTimeout(timeout);
      active.state.running = false;
      await this.#persistQueued().catch(() => undefined);
      // A Timer owns at most one live invocation. If it ran beyond its
      // interval, #fire collapses all missed ticks when this next handle fires.
      this.#schedule(key, active);
    }
  }

  #current(key: string): ActiveTimer | undefined {
    return this.#active.get(key)?.at(-1);
  }

  #persistQueued(): Promise<void> {
    const run = this.#tail.then(() => this.#persist());
    this.#tail = run.catch(() => undefined);
    return run;
  }

  async #load(): Promise<void> {
    if (this.#loaded) return;
    this.#loaded = true;
    if (!this.path) return;
    let encoded: Buffer;
    try {
      encoded = await readFile(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (encoded.byteLength > MAX_STATE_BYTES) throw new Error('Extension Timer state is too large');
    const value = JSON.parse(encoded.toString('utf8')) as {
      schemaVersion?: unknown;
      timers?: unknown;
    };
    if (value.schemaVersion !== 1 || !Array.isArray(value.timers))
      throw new Error('Extension Timer state is invalid');
    for (const item of value.timers) {
      if (!validState(item)) throw new Error('Extension Timer state contains an invalid record');
      this.#states.set(timerKey(item.bindingId, item.id), { ...item, running: false });
    }
  }

  async #persist(): Promise<void> {
    if (!this.path) return;
    const timers = [...this.#states.values()]
      .map((state) => ({ ...state, running: false }))
      .sort(
        (left, right) =>
          left.bindingId.localeCompare(right.bindingId) || left.id.localeCompare(right.id),
      );
    const encoded = `${JSON.stringify({ schemaVersion: 1, timers })}\n`;
    if (Buffer.byteLength(encoded, 'utf8') > MAX_STATE_BYTES)
      throw new Error('Extension Timer state is too large');
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(encoded, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, this.path);
    } finally {
      await handle?.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}

function timerKey(bindingId: string, id: string): string {
  return `${bindingId}\0${id}`;
}

function validState(value: unknown): value is TimerState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  return (
    ['bindingId', 'scopeId', 'extensionId', 'revision', 'id'].every(
      (key) => typeof state[key] === 'string' && (state[key] as string).length > 0,
    ) &&
    Number.isSafeInteger(state.intervalMs) &&
    Number.isSafeInteger(state.nextRunAt)
  );
}

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return Buffer.from(message, 'utf8').subarray(0, 4096).toString('utf8');
}

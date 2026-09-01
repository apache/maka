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

/*
 * Windows native Computer Use supervisor.
 *
 * This is intentionally a separate supervisor from maka.cu/2. The Windows
 * helper has a private `maka.cu.windows/0` contract and is not allowed to
 * inherit macOS protocol assumptions (image directories, foreground input or
 * host.hello). The host still owns executable verification and lifecycle.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, readFile, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { decodeJsonLines } from './stdio-json-rpc.js';

export const WINDOWS_CU_PROTOCOL_VERSION = 'maka.cu.windows/0';
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_RESTART_ATTEMPTS = 3;
const CANCEL_GRACE_MS = 2_000;
const MAX_BUFFER_BYTES = 32 * 1024 * 1024;

export type WindowsCuServiceState =
  | 'idle'
  | 'starting'
  | 'ready'
  | 'backing_off'
  | 'unavailable'
  | 'disposed';

export interface WindowsCuHandshake {
  protocol: typeof WINDOWS_CU_PROTOCOL_VERSION;
  generation: number | string;
  capabilities: Record<string, unknown>;
  limits?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface WindowsCuReleaseEvent {
  generation: number;
  reason:
    | 'child_exit'
    | 'request_timeout'
    | 'protocol_violation'
    | 'restart_exhausted'
    | 'disposed';
  sessionIds: readonly string[];
  outcomeUnknown: boolean;
}

export interface WindowsCuServiceOptions {
  binaryPath: string;
  /** Test seam for a script-backed helper; product helpers are direct exes. */
  childArgs?: readonly string[];
  expectedBinarySha256?: string;
  timeoutMs?: number;
  handshakeTimeoutMs?: number;
  maxRestartAttempts?: number;
  restartBackoffMs?: number;
  childEnv?: NodeJS.ProcessEnv;
  onRelease?: (event: WindowsCuReleaseEvent) => void;
}

export class WindowsCuLifecycleError extends Error {
  constructor(
    readonly code: 'service_unavailable' | 'service_mismatch' | 'outcome_unknown' | 'aborted',
    message: string,
    readonly generation: number,
  ) {
    super(`${code}: ${message}`);
    this.name = 'WindowsCuLifecycleError';
  }
}

export class WindowsCuRpcError extends Error {
  constructor(
    readonly method: string,
    readonly body: { code: number; message: string; data?: Record<string, unknown> },
  ) {
    super(`Windows helper ${method} request failed: ${body.message}`);
    this.name = 'WindowsCuRpcError';
  }
}

interface Pending {
  method: string;
  sessionId?: string;
  stage: 'queued' | 'writing' | 'delivered';
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
  cancelRequested?: boolean;
  cancel?: () => void;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export class WindowsCuService {
  private child?: ChildProcessWithoutNullStreams;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private generation = 0;
  private state: WindowsCuServiceState = 'idle';
  private starting?: Promise<void>;
  private disposed = false;
  private handshake?: WindowsCuHandshake;
  private buffer = '';
  private childError?: Error;
  private releaseListeners = new Set<(event: WindowsCuReleaseEvent) => void>();

  constructor(private readonly opts: WindowsCuServiceOptions) {}

  snapshot() {
    return { state: this.state, generation: this.generation };
  }

  negotiated(): WindowsCuHandshake | undefined {
    return this.handshake;
  }

  subscribeRelease(listener: (event: WindowsCuReleaseEvent) => void): () => void {
    this.releaseListeners.add(listener);
    return () => this.releaseListeners.delete(listener);
  }

  private emitRelease(event: WindowsCuReleaseEvent): void {
    this.opts.onRelease?.(event);
    for (const listener of this.releaseListeners) listener(event);
  }

  async ensureStarted(signal?: AbortSignal): Promise<WindowsCuHandshake> {
    if (this.disposed)
      throw new WindowsCuLifecycleError(
        'service_unavailable',
        'Windows helper is disposed',
        this.generation,
      );
    if (this.child && this.state === 'ready' && this.handshake) return this.handshake;
    if (!this.starting)
      this.starting = this.startWithBudget().finally(() => {
        this.starting = undefined;
      });
    if (signal?.aborted)
      throw new WindowsCuLifecycleError(
        'aborted',
        'request aborted before helper startup',
        this.generation,
      );
    await Promise.race([
      this.starting,
      signal
        ? new Promise<never>((_, reject) =>
            signal.addEventListener(
              'abort',
              () =>
                reject(
                  new WindowsCuLifecycleError(
                    'aborted',
                    'request aborted during helper startup',
                    this.generation,
                  ),
                ),
              { once: true },
            ),
          )
        : new Promise<never>(() => {}),
    ]);
    if (!this.handshake)
      throw new WindowsCuLifecycleError(
        'service_unavailable',
        'Windows helper is not ready',
        this.generation,
      );
    return this.handshake;
  }

  private async startWithBudget(): Promise<void> {
    const attempts = this.opts.maxRestartAttempts ?? DEFAULT_RESTART_ATTEMPTS;
    let last: unknown;
    for (let i = 0; i < attempts; i += 1) {
      try {
        await this.start();
        return;
      } catch (error) {
        last = error;
        if (error instanceof WindowsCuLifecycleError && error.code === 'service_mismatch')
          throw error;
        if (i + 1 < attempts) {
          this.state = 'backing_off';
          await new Promise((resolve) =>
            setTimeout(resolve, (this.opts.restartBackoffMs ?? 50) * 2 ** i),
          );
        }
      }
    }
    this.state = 'unavailable';
    this.emitRelease({
      generation: this.generation,
      reason: 'restart_exhausted',
      sessionIds: [],
      outcomeUnknown: false,
    });
    throw new WindowsCuLifecycleError(
      'service_unavailable',
      `Windows helper restart budget exhausted: ${last instanceof Error ? last.message : String(last)}`,
      this.generation,
    );
  }

  private async start(): Promise<void> {
    this.state = 'starting';
    let executable: string;
    try {
      executable = await realpath(this.opts.binaryPath);
      await access(executable, constants.R_OK | constants.X_OK);
      if (this.opts.expectedBinarySha256) {
        const actual = createHash('sha256')
          .update(await readFile(executable))
          .digest('hex');
        if (actual !== this.opts.expectedBinarySha256)
          throw new WindowsCuLifecycleError(
            'service_mismatch',
            'Windows helper hash does not match manifest',
            this.generation,
          );
      }
    } catch (error) {
      if (error instanceof WindowsCuLifecycleError) throw error;
      throw new WindowsCuLifecycleError(
        'service_unavailable',
        `Windows helper is not usable at ${this.opts.binaryPath}`,
        this.generation,
      );
    }
    const child = spawn(executable, [...(this.opts.childArgs ?? [])], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...(this.opts.childEnv ?? process.env) },
    });
    this.child = child;
    this.generation += 1;
    this.handshake = undefined;
    this.buffer = '';
    this.childError = undefined;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onStdout(child, chunk));
    child.stderr.resume();
    child.on('error', (error: Error) => {
      if (this.child === child) this.childError = error;
      this.onExit(child, 'child_exit');
    });
    child.on('exit', () => this.onExit(child, 'child_exit'));
    try {
      const response = await this.request(
        'initialize',
        {
          protocol: WINDOWS_CU_PROTOCOL_VERSION,
          host: { name: 'maka', version: '0.1.0' },
          hostPid: process.pid,
        },
        this.opts.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
      );
      const hello = record(response.result);
      if (!hello || hello.protocol !== WINDOWS_CU_PROTOCOL_VERSION)
        throw new WindowsCuLifecycleError(
          'service_mismatch',
          'Windows helper protocol mismatch',
          this.generation,
        );
      this.handshake = hello as WindowsCuHandshake;
      this.state = 'ready';
    } catch (error) {
      child.kill('SIGKILL');
      throw error;
    }
  }

  private onStdout(child: ChildProcessWithoutNullStreams, chunk: string): void {
    if (this.child !== child) return;
    this.buffer = decodeJsonLines(this.buffer, chunk, {
      maxBufferBytes: MAX_BUFFER_BYTES,
      onOverflow: () => this.kill('protocol_violation'),
      onNonJsonLine: () => this.kill('protocol_violation'),
      onMessage: (value) => {
        const message = record(value);
        if (!message || typeof message.id !== 'number') return;
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (pending.timer) clearTimeout(pending.timer);
        const error = record(message.error);
        if (error && typeof error.code === 'number' && typeof error.message === 'string')
          pending.reject(
            new WindowsCuRpcError(
              pending.method,
              error as { code: number; message: string; data?: Record<string, unknown> },
            ),
          );
        else pending.resolve(message);
      },
    });
  }

  private onExit(
    child: ChildProcessWithoutNullStreams,
    reason: WindowsCuReleaseEvent['reason'],
  ): void {
    if (this.child !== child) return;
    this.child = undefined;
    this.handshake = undefined;
    const pending = [...this.pending.values()];
    this.pending.clear();
    const delivered = pending.filter(
      (entry) => entry.stage === 'writing' || entry.stage === 'delivered',
    );
    for (const entry of pending) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(
        new WindowsCuLifecycleError(
          delivered.includes(entry) ? 'outcome_unknown' : 'service_unavailable',
          'Windows helper exited',
          this.generation,
        ),
      );
    }
    if (!this.disposed) this.state = 'unavailable';
    this.emitRelease({
      generation: this.generation,
      reason,
      sessionIds: delivered.flatMap((entry) => (entry.sessionId ? [entry.sessionId] : [])),
      outcomeUnknown: delivered.length > 0,
    });
  }

  private async request(
    method: string,
    params: unknown,
    timeoutMs: number,
    signal?: AbortSignal,
    sessionId?: string,
  ): Promise<Record<string, unknown>> {
    const child = this.child;
    if (!child || this.disposed)
      throw new WindowsCuLifecycleError(
        'service_unavailable',
        'Windows helper is unavailable',
        this.generation,
      );
    const id = this.nextId++;
    return await new Promise<Record<string, unknown>>((resolve, reject) => {
      const pending: Pending = { method, sessionId, stage: 'queued', resolve, reject };
      this.pending.set(id, pending);
      const cancel = () => {
        if (pending.cancelRequested || !this.pending.has(id)) return;
        pending.cancelRequested = true;
        this.notify('$/cancel', { id });
        if (pending.timer) clearTimeout(pending.timer);
        pending.timer = setTimeout(() => this.kill('request_timeout'), CANCEL_GRACE_MS);
      };
      pending.cancel = cancel;
      if (signal) {
        if (signal.aborted) {
          this.pending.delete(id);
          reject(
            new WindowsCuLifecycleError(
              'aborted',
              'request aborted before delivery',
              this.generation,
            ),
          );
          return;
        }
        signal.addEventListener('abort', cancel, { once: true });
      }
      pending.timer = setTimeout(() => cancel(), timeoutMs);
      pending.stage = 'writing';
      try {
        child.stdin.write(
          `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`,
          (error) => {
            if (error) {
              this.pending.delete(id);
              reject(error);
              return;
            }
            if (this.pending.has(id)) pending.stage = 'delivered';
          },
        );
      } catch (error) {
        this.pending.delete(id);
        reject(error as Error);
      }
    });
  }

  private notify(method: string, params: unknown): void {
    if (this.child && !this.child.killed)
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  async call(
    method: string,
    params: unknown,
    signal?: AbortSignal,
    sessionId?: string,
  ): Promise<Record<string, unknown>> {
    await this.ensureStarted(signal);
    return (
      await this.request(
        method,
        params,
        this.opts.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
        signal,
        sessionId,
      )
    ).result as Record<string, unknown>;
  }

  clearSession(sessionId: string): void {
    for (const [id, entry] of this.pending) {
      if (entry.sessionId !== sessionId) continue;
      entry.cancel?.();
    }
  }

  private kill(reason: WindowsCuReleaseEvent['reason']): void {
    const child = this.child;
    if (!child) return;
    child.kill('SIGKILL');
    this.onExit(child, reason);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.state = 'disposed';
    const child = this.child;
    if (child) {
      // Ask the private helper to drain and exit. The process exit callback is
      // the confirmation; SIGKILL is reserved for the bounded fallback.
      this.notify('shutdown', {});
      const timer = setTimeout(() => {
        if (this.child === child) this.kill('disposed');
      }, 2_000);
      timer.unref?.();
    } else
      this.emitRelease({
        generation: this.generation,
        reason: 'disposed',
        sessionIds: [],
        outcomeUnknown: false,
      });
  }
}

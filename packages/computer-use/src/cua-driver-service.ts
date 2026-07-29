import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { access, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { join } from 'node:path';
import {
  CuaDriverLifecycleError,
  type CuaDriverReleaseEvent,
  type CuaDriverRequestStage,
  type CuaDriverRole,
  type CuaDriverRoleSnapshot,
} from './cua-driver-release.js';

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_RESTART_ATTEMPTS = 3;
const DEFAULT_RESTART_BACKOFF_MS = 50;
const MAX_STDOUT_BUFFER = 32 * 1024 * 1024;
const STDERR_TAIL_CAP = 4096;

export interface CuaDriverJsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: {
    protocolVersion?: string;
    serverInfo?: {
      name?: string;
      version?: string;
    };
    content?: Array<{
      type: string;
      text?: string;
      data?: string;
      mimeType?: string;
    }>;
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
  };
  error?: { code: number; message: string };
}

export interface CuaDriverServiceOptions {
  role: CuaDriverRole;
  binaryPath: string;
  hostBundleId: string;
  captureScope: 'window' | 'desktop';
  homeDir: string;
  timeoutMs?: number;
  handshakeTimeoutMs?: number;
  maxRestartAttempts?: number;
  restartBackoffMs?: number;
  childEnv?: NodeJS.ProcessEnv;
  expectedBinarySha256?: string;
  expectedServerName?: string;
  expectedServerVersion?: string;
  expectedProtocolVersion?: string;
  onRelease?: (event: CuaDriverReleaseEvent) => void;
}

interface PendingRequest {
  sessionId?: string;
  stage: CuaDriverRequestStage;
  resolve: (response: CuaDriverJsonRpcResponse) => void;
  reject: (error: Error) => void;
}

function abortPromise(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(new Error('aborted'));
      return;
    }
    signal.addEventListener('abort', () => reject(new Error('aborted')), {
      once: true,
    });
  });
}

/** Owns one long-lived cua-driver child role and its JSON-RPC transport. */
export class CuaDriverService {
  private readonly childEnv: NodeJS.ProcessEnv;
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private buffer = '';
  private stderrTail = '';
  private starting?: Promise<void>;
  private disposed = false;
  private generation = 0;
  private state: CuaDriverRoleSnapshot['state'] = 'idle';
  private restartAttempts = 0;
  private nextRestartAt?: number;
  private readonly sessionContext = new AsyncLocalStorage<string>();

  constructor(private readonly opts: CuaDriverServiceOptions) {
    this.childEnv = { ...(opts.childEnv ?? process.env) };
  }

  snapshot(): CuaDriverRoleSnapshot {
    return {
      role: this.opts.role,
      state: this.state,
      generation: this.generation,
      restartAttempts: this.restartAttempts,
      ...(this.nextRestartAt === undefined ? {} : { nextRestartAt: this.nextRestartAt }),
    };
  }

  async withSession<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    return this.sessionContext.run(sessionId, operation);
  }

  private assertActive(): void {
    if (this.disposed) {
      throw new CuaDriverLifecycleError(
        'service_unavailable',
        'cua-driver service disposed',
        this.opts.role,
        this.generation,
      );
    }
  }

  private emitRelease(
    reason: CuaDriverReleaseEvent['reason'],
    sessionIds: readonly string[],
    outcomeUnknown: boolean,
    generationReleased: boolean,
  ): void {
    this.opts.onRelease?.({
      role: this.opts.role,
      generation: this.generation,
      generationReleased,
      reason,
      sessionIds: [...new Set(sessionIds)],
      outcomeUnknown,
    });
  }

  private async ensureStarted(signal?: AbortSignal): Promise<void> {
    this.assertActive();
    if (this.child && !this.child.killed && this.state === 'ready') return;
    if (!this.starting) {
      this.starting = this.startWithBudget().finally(() => {
        this.starting = undefined;
      });
    }
    const starting = this.starting;
    if (!signal) {
      await starting;
      return;
    }
    await Promise.race([starting, abortPromise(signal)]);
  }

  private async startWithBudget(): Promise<void> {
    const maxAttempts = this.opts.maxRestartAttempts ?? DEFAULT_MAX_RESTART_ATTEMPTS;
    let lastError: unknown;
    while (this.restartAttempts < maxAttempts) {
      this.assertActive();
      if (this.nextRestartAt !== undefined) {
        const delayMs = Math.max(0, this.nextRestartAt - Date.now());
        if (delayMs > 0) {
          this.state = 'backing_off';
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          this.assertActive();
        }
      }
      this.restartAttempts += 1;
      try {
        await this.start();
        this.restartAttempts = 0;
        this.nextRestartAt = undefined;
        return;
      } catch (error) {
        lastError = error;
        if (this.disposed) throw error;
        if (error instanceof CuaDriverLifecycleError && error.code === 'service_mismatch') {
          this.state = 'unavailable';
          throw error;
        }
        const backoff =
          (this.opts.restartBackoffMs ?? DEFAULT_RESTART_BACKOFF_MS) *
          2 ** (this.restartAttempts - 1);
        this.nextRestartAt = Date.now() + backoff;
      }
    }
    this.state = 'unavailable';
    this.emitRelease('restart_exhausted', [], false, false);
    throw new CuaDriverLifecycleError(
      'service_unavailable',
      `cua-driver ${this.opts.role} restart budget exhausted: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
      this.opts.role,
      this.generation,
    );
  }

  private async start(): Promise<void> {
    this.assertActive();
    this.state = 'starting';
    const executablePath = await this.verifyExecutable();
    try {
      const dir = join(this.opts.homeDir, '.cua-driver');
      await mkdir(dir, { recursive: true });
      this.assertActive();
      await writeFile(join(dir, '.installation_recorded'), '1', { flag: 'wx' });
      this.assertActive();
    } catch {
      this.assertActive();
    }

    const child = spawn(
      executablePath,
      [
        'mcp',
        '--embedded',
        '--no-daemon-relaunch',
        '--no-overlay',
        '--host-bundle-id',
        this.opts.hostBundleId,
      ],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...this.childEnv,
          HOME: this.opts.homeDir,
          CUA_DRIVER_EMBEDDED: '1',
          CUA_DRIVER_HOST_BUNDLE_ID: this.opts.hostBundleId,
          CUA_DRIVER_RS_TELEMETRY_ENABLED: 'false',
          CUA_DRIVER_RS_UPDATE_CHECK: 'false',
          CUA_DRIVER_RS_MCP_NO_RELAUNCH: '1',
        },
      },
    );
    this.generation += 1;
    this.child = child;
    this.buffer = '';
    this.stderrTail = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onStdout(child, chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => this.onStderr(child, chunk));
    child.stdin.on('error', () => this.onExit(child, 'child_exit'));
    child.on('exit', () => this.onExit(child, 'child_exit'));
    child.on('error', () => this.onExit(child, 'child_exit'));

    const timeoutMs = this.opts.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    try {
      const initialized = await this.request(
        'initialize',
        {
          protocolVersion: this.opts.expectedProtocolVersion ?? '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'maka', version: '0.1' },
        },
        { timeoutMs, retrySafe: true },
      );
      const protocolVersion = initialized.result?.protocolVersion;
      const serverName = initialized.result?.serverInfo?.name;
      const serverVersion = initialized.result?.serverInfo?.version;
      if (
        protocolVersion !== (this.opts.expectedProtocolVersion ?? '2025-06-18') ||
        typeof serverName !== 'string' ||
        serverName.length === 0 ||
        typeof serverVersion !== 'string' ||
        serverVersion.length === 0 ||
        (this.opts.expectedServerName && serverName !== this.opts.expectedServerName) ||
        (this.opts.expectedServerVersion && serverVersion !== this.opts.expectedServerVersion)
      ) {
        throw new CuaDriverLifecycleError(
          'service_mismatch',
          `unexpected cua-driver identity ${serverName ?? 'unknown'}@${serverVersion ?? 'unknown'} protocol=${protocolVersion ?? 'unknown'}`,
          this.opts.role,
          this.generation,
        );
      }
      this.assertActive();
      this.notify('notifications/initialized');
      const config = await this.request(
        'tools/call',
        {
          name: 'set_config',
          arguments: { capture_scope: this.opts.captureScope },
        },
        { timeoutMs, retrySafe: true },
      );
      this.assertActive();
      if (config.error || config.result?.isError) {
        throw new Error(
          `set_config capture_scope=${this.opts.captureScope} failed: ${
            config.error?.message ?? 'tool returned isError'
          }`,
        );
      }
      this.state = 'ready';
    } catch (error) {
      this.kill('child_exit');
      throw error;
    }
  }

  private async verifyExecutable(): Promise<string> {
    try {
      const resolved = await realpath(this.opts.binaryPath);
      await access(resolved, fsConstants.X_OK);
      if (this.opts.expectedBinarySha256) {
        const actual = createHash('sha256')
          .update(await readFile(resolved))
          .digest('hex');
        if (actual !== this.opts.expectedBinarySha256) {
          throw new Error(
            `binary sha256 mismatch: expected ${this.opts.expectedBinarySha256}, got ${actual}`,
          );
        }
      }
      return resolved;
    } catch (error) {
      this.state = 'unavailable';
      throw new CuaDriverLifecycleError(
        'service_mismatch',
        error instanceof Error ? error.message : String(error),
        this.opts.role,
        this.generation,
      );
    }
  }

  private onStdout(child: ChildProcessWithoutNullStreams, chunk: string): void {
    if (this.child !== child) return;
    this.buffer += chunk;
    if (this.buffer.length > MAX_STDOUT_BUFFER) {
      this.kill('child_exit');
      return;
    }
    let index: number;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let message: CuaDriverJsonRpcResponse;
      try {
        message = JSON.parse(line) as CuaDriverJsonRpcResponse;
      } catch {
        continue;
      }
      if (typeof message.id !== 'number') continue;
      this.pending.get(message.id)?.resolve(message);
    }
  }

  private onStderr(child: ChildProcessWithoutNullStreams, chunk: string): void {
    if (this.child !== child) return;
    this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_CAP);
  }

  private onExit(
    child: ChildProcessWithoutNullStreams,
    reason: CuaDriverReleaseEvent['reason'],
  ): void {
    if (this.child !== child) return;
    const requests = [...this.pending.values()];
    this.pending.clear();
    const potentiallyDelivered = requests.filter(
      (request) => request.stage === 'writing' || request.stage === 'delivered',
    );
    const sessionIds = potentiallyDelivered.flatMap((request) =>
      request.sessionId ? [request.sessionId] : [],
    );
    // Say why it died. The service has been buffering the child's stderr all
    // along and then threw it away at the one moment it was worth reading: a
    // driver that exits mid-request produced "cua-driver action exited after
    // request delivery", which names the event and not one thing about the
    // cause. On a real desktop chain that message reached the model, which
    // concluded Computer Use was unavailable and finished the task by
    // shelling out to AppleScript instead.
    //
    // One line, bounded. The driver's stderr is its own diagnostics, not
    // application content.
    const why = this.stderrTail.trim().replace(/\s+/g, ' ').slice(-200);
    const because = why ? `: ${why}` : '';
    for (const request of requests) {
      request.reject(
        request.stage === 'writing' || request.stage === 'delivered'
          ? new CuaDriverLifecycleError(
              'outcome_unknown',
              `cua-driver ${this.opts.role} exited after request delivery${because}`,
              this.opts.role,
              this.generation,
              request.stage,
            )
          : new CuaDriverLifecycleError(
              'service_unavailable',
              `cua-driver ${this.opts.role} exited before request delivery${because}`,
              this.opts.role,
              this.generation,
              request.stage,
            ),
      );
    }
    this.child = undefined;
    this.buffer = '';
    if (!this.disposed) {
      this.state = 'idle';
      const backoff = this.opts.restartBackoffMs ?? DEFAULT_RESTART_BACKOFF_MS;
      this.nextRestartAt = Date.now() + backoff;
    }
    this.emitRelease(reason, sessionIds, potentiallyDelivered.length > 0, true);
  }

  private notify(method: string, params?: unknown): void {
    try {
      this.child?.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    } catch {
      // The child event handlers own teardown.
    }
  }

  private request(
    method: string,
    params: unknown,
    opts: {
      timeoutMs?: number;
      signal?: AbortSignal;
      retrySafe?: boolean;
    } = {},
  ): Promise<CuaDriverJsonRpcResponse> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const child = this.child;
      if (!child || child.killed) {
        reject(
          new CuaDriverLifecycleError(
            'service_unavailable',
            'cua-driver not running',
            this.opts.role,
            this.generation,
            'queued',
          ),
        );
        return;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        if (onAbort && opts.signal) {
          opts.signal.removeEventListener('abort', onAbort);
        }
        this.pending.delete(id);
      };
      const entry: PendingRequest = {
        sessionId: this.sessionContext.getStore(),
        stage: 'queued',
        resolve: (response) => {
          entry.stage = 'settled';
          cleanup();
          resolve(response);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      };
      this.pending.set(id, entry);
      if (opts.signal) {
        if (opts.signal.aborted) {
          entry.reject(
            new CuaDriverLifecycleError(
              'aborted',
              'request aborted before delivery',
              this.opts.role,
              this.generation,
              entry.stage,
            ),
          );
          return;
        }
        onAbort = () => {
          if (entry.stage === 'writing' || entry.stage === 'delivered') {
            this.kill('request_aborted');
          } else {
            entry.reject(
              new CuaDriverLifecycleError(
                'aborted',
                'request aborted before delivery',
                this.opts.role,
                this.generation,
                entry.stage,
              ),
            );
          }
        };
        opts.signal.addEventListener('abort', onAbort, { once: true });
      }
      if (opts.timeoutMs) {
        timer = setTimeout(() => {
          if ((entry.stage === 'writing' || entry.stage === 'delivered') && !opts.retrySafe) {
            this.kill('request_timeout');
            return;
          }
          entry.reject(new Error('timeout'));
          if (opts.retrySafe) this.kill('child_exit');
        }, opts.timeoutMs);
      }
      try {
        entry.stage = 'writing';
        child.stdin.write(
          `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`,
          (error) => {
            if (error) {
              entry.reject(error);
              return;
            }
            if (this.pending.has(id)) entry.stage = 'delivered';
          },
        );
      } catch (error) {
        entry.reject(error as Error);
      }
    });
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<CuaDriverJsonRpcResponse['result']> {
    this.assertActive();
    await this.ensureStarted(signal);
    this.assertActive();
    const response = await this.request(
      'tools/call',
      { name, arguments: args },
      {
        timeoutMs: this.opts.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
        signal,
      },
    );
    if (response.error) {
      throw new Error(`cua-driver ${name}: ${response.error.message}`);
    }
    return response.result;
  }

  clearSession(sessionId: string): void {
    const ownsPending = [...this.pending.values()].some(
      (request) =>
        request.sessionId === sessionId &&
        (request.stage === 'writing' || request.stage === 'delivered'),
    );
    if (ownsPending) {
      this.kill('session_cleared');
      return;
    }
    this.emitRelease('session_cleared', [sessionId], false, false);
  }

  private kill(reason: CuaDriverReleaseEvent['reason']): void {
    const child = this.child;
    if (!child) return;
    child.kill('SIGKILL');
    this.onExit(child, reason);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.state = 'disposed';
    const starting = this.starting;
    try {
      this.kill('disposed');
    } catch {
      // Disposal is best-effort; the sibling role still needs cleanup.
    }
    try {
      this.emitRelease('disposed', [], false, false);
    } catch {
      // Release observers must not interrupt process cleanup.
    }
    const removeHome = () => {
      try {
        rmSync(this.opts.homeDir, { recursive: true, force: true });
      } catch {
        // Temporary-home cleanup must not make host shutdown fail.
      }
    };
    removeHome();
    void starting?.then(removeHome, removeHome);
  }
}

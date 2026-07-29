import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { access, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CuaDriverLifecycleError,
  type CuaDriverReleaseEvent,
  type CuaDriverRequestStage,
  type CuaDriverRole,
  type CuaDriverRoleSnapshot,
} from './cua-driver-release.js';

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
/** How long to wait for `serve --embedded` to publish its socket before failing the start. */
const DAEMON_READY_TIMEOUT_MS = 10_000;
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
  /** The driver's own agent cursor could not be suppressed; ours is not the only one drawn. */
  onCursorSuppressionFailed?: (event: { role: CuaDriverRole; reason: string }) => void;
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
  /**
   * cua-driver >= 0.9 splits embedded hosting in two: a `serve --embedded`
   * daemon that owns the runtime, and an `mcp --embedded` proxy that speaks
   * JSON-RPC over stdio. Both are our direct children so the host app's TCC
   * grants still apply; the daemon is spawned first and torn down with the
   * proxy so a crash on either side never leaves an orphan holding the socket.
   */
  private daemon?: ChildProcess;
  private daemonSocketPath?: string;
  /**
   * Session id declared to cua-driver at handshake. One per process, minted
   * fresh on every (re)start so a restarted runtime never inherits state that
   * a previous generation registered under the same name.
   */
  private runtimeSessionId = randomUUID();
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

    // Fresh session identity per generation: a restart must not resume a
    // session the previous runtime registered.
    this.runtimeSessionId = randomUUID();
    const socketPath = await this.startDaemon(executablePath);
    this.assertActive();

    const child = spawn(
      executablePath,
      [
        'mcp',
        '--embedded',
        '--socket',
        socketPath,
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
      // cua-driver >= 0.12 retired the process-wide `set_config capture_scope`
      // in favour of a per-session declaration. This service still owns exactly
      // one scope for its whole lifetime (one process per role), so it declares
      // a single long-lived session at handshake time and every later call
      // rides on it.
      const config = await this.request(
        'tools/call',
        {
          name: 'start_session',
          arguments: {
            session: this.runtimeSessionId,
            capture_scope: this.opts.captureScope,
          },
        },
        { timeoutMs, retrySafe: true },
      );
      this.assertActive();
      if (config.error || config.result?.isError) {
        throw new Error(
          `start_session capture_scope=${this.opts.captureScope} failed: ${
            config.error?.message ?? 'tool returned isError'
          }`,
        );
      }
      // Declaring a session also gives it a driver-drawn agent cursor, which
      // appears on the session's first action. Maka draws its own, so leaving
      // the driver's on means two cursors for one agent — and the driver's is
      // positioned from its own geometry, which lands on the wrong display in a
      // multi-monitor setup. Best-effort: this is presentation, and failing to
      // turn it off is not a reason to refuse to start.
      try {
        const cursorOff = await this.request(
          'tools/call',
          {
            name: 'set_agent_cursor_enabled',
            arguments: { session: this.runtimeSessionId, enabled: false },
          },
          { timeoutMs, retrySafe: true },
        );
        // A tool that answers with isError does not throw, so silence here
        // would look identical to success. The cursor is cosmetic and must not
        // fail the handshake — but a cursor we believe is off while it is
        // actually drawing on the user's screen is worth a line in the log.
        if (cursorOff.error || cursorOff.result?.isError) {
          this.noteCursorSuppressionFailed(
            cursorOff.error?.message ?? 'set_agent_cursor_enabled returned isError',
          );
        }
      } catch (error) {
        // An older driver may not expose this tool at all.
        this.noteCursorSuppressionFailed(error instanceof Error ? error.message : String(error));
      }
      this.assertActive();
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
    for (const request of requests) {
      request.reject(
        request.stage === 'writing' || request.stage === 'delivered'
          ? new CuaDriverLifecycleError(
              'outcome_unknown',
              `cua-driver ${this.opts.role} exited after request delivery`,
              this.opts.role,
              this.generation,
              request.stage,
            )
          : new CuaDriverLifecycleError(
              'service_unavailable',
              `cua-driver ${this.opts.role} exited before request delivery`,
              this.opts.role,
              this.generation,
              request.stage,
            ),
      );
    }
    this.child = undefined;
    this.buffer = '';
    // The daemon exists only to serve this proxy. Nothing tells it the proxy is
    // gone — its stdin is 'ignore', so there is no EOF to notice — and a
    // restart brings up a fresh pair, so leaving it running accumulates one
    // orphaned process per crash.
    this.stopDaemon();
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

  /**
   * Spawn the `serve --embedded` daemon that owns the runtime and wait for its
   * socket to appear.
   *
   * The socket does NOT live under the role's private HOME: those paths are
   * already long temp directories, and a Unix socket path must fit in
   * `sun_path` (~104 bytes on macOS) or `bind` fails outright. A short
   * dedicated directory keeps us well inside that budget while still giving
   * each role its own runtime.
   */
  private async startDaemon(executablePath: string): Promise<string> {
    const socketDir = join(tmpdir(), 'maka-cud');
    await mkdir(socketDir, { recursive: true, mode: 0o700 });
    const socketPath = join(socketDir, `${randomUUID().slice(0, 8)}.sock`);
    this.assertActive();

    const daemon = spawn(executablePath, ['serve', '--embedded', '--socket', socketPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...this.childEnv,
        HOME: this.opts.homeDir,
        CUA_DRIVER_EMBEDDED: '1',
        CUA_DRIVER_HOST_BUNDLE_ID: this.opts.hostBundleId,
        CUA_DRIVER_RS_TELEMETRY_ENABLED: 'false',
        CUA_DRIVER_RS_UPDATE_CHECK: 'false',
      },
    });
    this.daemon = daemon;
    this.daemonSocketPath = socketPath;

    let daemonStderr = '';
    daemon.stderr?.setEncoding('utf8');
    daemon.stderr?.on('data', (chunk: string) => {
      daemonStderr = `${daemonStderr}${chunk}`.slice(-4096);
    });
    // A daemon exit invalidates the proxy: fail the same way a proxy crash
    // does rather than leaving requests hanging on a dead socket.
    daemon.on('exit', () => {
      if (this.daemon === daemon) this.onDaemonLost();
    });
    daemon.on('error', () => {
      if (this.daemon === daemon) this.onDaemonLost();
    });

    const deadline = Date.now() + DAEMON_READY_TIMEOUT_MS;
    try {
      while (Date.now() < deadline) {
        this.assertActive();
        if (daemon.exitCode !== null || daemon.signalCode !== null) {
          throw new Error(
            `cua-driver serve exited before its socket was ready${daemonStderr.trim() ? `: ${daemonStderr.trim()}` : ''}`,
          );
        }
        try {
          await stat(socketPath);
          return socketPath;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
      throw new Error('cua-driver serve did not publish its socket in time');
    } catch (error) {
      // A daemon that never became usable must not outlive the attempt. Both
      // the timeout path and an abort mid-wait would otherwise leak a live
      // process holding its stdio pipes open.
      this.stopDaemon();
      throw error;
    }
  }

  private onDaemonLost(): void {
    this.daemon = undefined;
    const child = this.child;
    if (child) this.onExit(child, 'child_exit');
  }

  private stopDaemon(): void {
    const daemon = this.daemon;
    this.daemon = undefined;
    if (daemon && daemon.exitCode === null && daemon.signalCode === null) {
      daemon.kill('SIGKILL');
    }
    const socketPath = this.daemonSocketPath;
    this.daemonSocketPath = undefined;
    if (socketPath) {
      rm(socketPath, { force: true }).catch(() => {
        // The daemon usually unlinks it; a leftover socket is harmless.
      });
    }
  }

  private kill(reason: CuaDriverReleaseEvent['reason']): void {
    const child = this.child;
    this.stopDaemon();
    if (!child) return;
    child.kill('SIGKILL');
    this.onExit(child, reason);
  }

  /**
   * Close the driver-side session before tearing the process down.
   *
   * `start_session` gives the session an agent cursor, and only `end_session`
   * takes it away. Killing the proxy without this can leave that cursor drawn
   * on the user's screen, outliving the run that created it — which is exactly
   * what a leaked daemon did during real-machine testing.
   *
   * Best-effort by construction: it runs on a process that is already going
   * away, so nothing here may block or throw into disposal.
   */
  /**
   * Record that the driver's own agent cursor could not be turned off.
   *
   * Maka draws its own cursor, so the driver's is a duplicate — and it is
   * positioned from the driver's geometry, which has been observed landing on
   * the wrong display in a multi-monitor setup. Leaving one drawn on the user's
   * screen with no way to notice is the failure mode this exists to surface.
   */
  private noteCursorSuppressionFailed(reason: string): void {
    this.opts.onCursorSuppressionFailed?.({ role: this.opts.role, reason });
  }

  private endSessionBestEffort(): void {
    const child = this.child;
    if (!child) return;
    try {
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: `end-${this.runtimeSessionId}`,
          method: 'tools/call',
          params: { name: 'end_session', arguments: { session: this.runtimeSessionId } },
        })}\n`,
      );
    } catch {
      // The child is already gone; the cursor dies with the process.
    }
  }

  dispose(): void {
    if (this.disposed) return;
    // Close the session while the child is still usable — flipping to
    // 'disposed' first would skip the cursor teardown entirely.
    if (this.state === 'ready') {
      try {
        this.endSessionBestEffort();
      } catch {
        // Cursor cleanup must never prevent process cleanup.
      }
    }
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

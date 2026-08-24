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

// Supervises one `maka-cu` executor child and speaks `maka.cu/2` to it over
// line-delimited JSON-RPC 2.0 on stdio (`maka-cu`'s docs/HOST_PROTOCOL.md §1).
//
// The framing decoder and the lifecycle vocabulary are shared with the
// cua-driver service (stdio-json-rpc.ts). The supervision policy is not, and
// that is deliberate: this executor cancels with `$/cancel` and waits for its
// own answer instead of being killed (§7.2), shuts down on SIGTERM with a
// declared grace window (§11), owns its image directory (§8), and has one child
// rather than a role pair. Folding those into the cua-driver supervisor would
// mean a constructor flag per divergence, and every flag is a chance to run
// maka-cu's teardown against cua-driver.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import {
  MAKA_CU_ALLOW_GLOBAL_POINTER,
  MAKA_CU_PROTOCOL_VERSION,
  MAKA_CU_RPC_ERROR,
  isRecord,
  MakaCuProtocolViolation,
  type MakaCuEnvelope,
  type MakaCuRpcErrorBody,
  type MakaCuRpcResponse,
  readEnvelope,
} from './maka-cu-protocol.js';
import {
  abortPromise,
  decodeJsonLines,
  type HostLifecycleErrorCode,
  type HostRequestStage,
} from './stdio-json-rpc.js';

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_RESTART_ATTEMPTS = 3;
const DEFAULT_RESTART_BACKOFF_MS = 50;
/** No image ever crosses stdout (§8), so the only large payload left is the AX
 *  tree, itself bounded by `limits.maxResponseBytes`. Until that is negotiated
 *  there is no declared bound, and this floor is what a handshake needs. */
const MIN_STDOUT_BUFFER = 4 * 1024 * 1024;
/** Headroom above two whole responses, for the partial third in the pipe. */
const STDOUT_BUFFER_SLACK = 1024 * 1024;
const STDERR_TAIL_CAP = 4096;
/** §1: three non-JSON stdout lines in one generation are grounds for teardown. */
const MAX_NON_JSON_LINES = 3;
/** Used only until the handshake declares `limits.shutdownGraceMs` (§2). */
const FALLBACK_SHUTDOWN_GRACE_MS = 3_000;
/**
 * §7.2/§7.3: how long a `$/cancel` is given to be answered.
 *
 * A cancelled request that has been delivered may already have driven the
 * screen, so the host cannot settle it locally without lying about what
 * happened — it has to ask and wait. What it must not do is wait the whole
 * request deadline: measured, an abort at t=120ms against a 4s deadline settled
 * the caller at t=4022ms, and at the shipping default that is twenty seconds of
 * a blocked executor lane after the user pressed stop.
 *
 * It also has to be a wait at all. The timeout path notified `$/cancel` and
 * killed the child in the same tick, so the buffered stdin write never
 * flushed — verified against the mock, whose read log shows the cancel on the
 * abort path and nothing on the timeout path. §7.3's graceful cancel never
 * happened, and the executor never got to end its sessions, remove its agent
 * cursor or clear its image directory.
 */
const CANCEL_GRACE_MS = 2_000;

export type MakaCuServiceState =
  | 'idle'
  | 'starting'
  | 'ready'
  | 'backing_off'
  | 'unavailable'
  | 'disposed';

export interface MakaCuServiceSnapshot {
  state: MakaCuServiceState;
  generation: number;
  restartAttempts: number;
  executor?: MakaCuExecutorInfo;
}

export interface MakaCuReleaseEvent {
  generation: number;
  generationReleased: boolean;
  reason:
    | 'child_exit'
    | 'request_timeout'
    | 'protocol_violation'
    | 'session_cleared'
    | 'restart_exhausted'
    | 'disposed';
  sessionIds: readonly string[];
  outcomeUnknown: boolean;
}

export class MakaCuLifecycleError extends Error {
  constructor(
    readonly code: HostLifecycleErrorCode,
    message: string,
    readonly generation: number,
    readonly requestStage?: HostRequestStage,
    /** Respawning cannot change this answer, so the restart budget is skipped. */
    readonly fatal: boolean = false,
  ) {
    super(`${code}: ${message}`);
    this.name = 'MakaCuLifecycleError';
  }
}

export function isMakaCuLifecycleError(
  error: unknown,
  code?: HostLifecycleErrorCode,
): error is MakaCuLifecycleError {
  return error instanceof MakaCuLifecycleError && (code === undefined || error.code === code);
}

/** A JSON-RPC `error` (§1.1): the request was unusable, not a fact about the world. */
export class MakaCuRpcError extends Error {
  constructor(
    readonly method: string,
    readonly body: MakaCuRpcErrorBody,
  ) {
    super(`maka-cu ${method}: ${body.message} (${body.code})`);
    this.name = 'MakaCuRpcError';
  }
}

export interface MakaCuExecutorInfo {
  name: string;
  version: string;
  commit?: string;
}

export interface MakaCuCapabilities {
  captureStream: boolean;
  elementActions: readonly string[];
  pointActions: readonly string[];
  keyActions: readonly string[];
  imageFormats: readonly string[];
}

/**
 * §2's declared limits.
 *
 * Four of these have a host consumer: `snapshotsPerSession` bounds the host's
 * mirror of the executor's snapshot table, `snapshotTtlMs` expires it,
 * `maxResponseBytes` sizes the stdout budget, and `shutdownGraceMs` is how long
 * SIGTERM is given before SIGKILL.
 *
 * The other five — `maxElements`, `maxDepth`, `maxTextChars`,
 * `settleCeilingMs`, `imageDirBudgetBytes` — are read from the wire, validated
 * and held, and nothing consumes them: they bound work the executor does on its
 * own side, and the host has no decision that turns on them. This comment used
 * to claim every one had a host consumer, which is the kind of statement that
 * stops a reviewer from checking. They are still validated, because a limit the
 * host does not act on today is still a number an executor may start acting on.
 */
export interface MakaCuLimits {
  snapshotsPerSession: number;
  snapshotTtlMs: number;
  maxElements: number;
  maxDepth: number;
  maxTextChars: number;
  maxResponseBytes: number;
  settleCeilingMs: number;
  shutdownGraceMs: number;
  imageDirBudgetBytes: number;
}

export interface MakaCuHandshake {
  executor: MakaCuExecutorInfo;
  pid: number;
  capabilities: MakaCuCapabilities;
  limits: MakaCuLimits;
}

export interface MakaCuServiceOptions {
  /** Absolute path to the `maka-cu` executable; spawned as a DIRECT child (§11). */
  binaryPath: string;
  /** Host-owned image directory, purged before every spawn (§8, §11). */
  imageDir: string;
  hostVersion: string;
  timeoutMs?: number;
  handshakeTimeoutMs?: number;
  maxRestartAttempts?: number;
  restartBackoffMs?: number;
  childEnv?: NodeJS.ProcessEnv;
  expectedBinarySha256?: string;
  /** Test seam: the protocol string sent in `host.hello`. */
  protocolVersion?: string;
  onRelease?: (event: MakaCuReleaseEvent) => void;
}

interface PendingRequest {
  sessionId?: string;
  stage: HostRequestStage;
  resolve: (response: MakaCuRpcResponse) => void;
  reject: (error: Error) => void;
  /** §7.2: ask the executor to cancel this request and start the grace window. */
  cancel: () => void;
  cancelRequested?: boolean;
}

export class MakaCuService {
  private readonly childEnv: NodeJS.ProcessEnv;
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private buffer = '';
  private stderrTail = '';
  private nonJsonLines = 0;
  private starting?: Promise<void>;
  private disposed = false;
  private generation = 0;
  private state: MakaCuServiceState = 'idle';
  private restartAttempts = 0;
  private lastStartError?: unknown;
  private childError?: Error;
  private nextRestartAt?: number;
  private handshake?: MakaCuHandshake;
  private readonly sessionContext = new AsyncLocalStorage<string>();

  constructor(private readonly opts: MakaCuServiceOptions) {
    this.childEnv = { ...(opts.childEnv ?? process.env) };
  }

  snapshot(): MakaCuServiceSnapshot {
    return {
      state: this.state,
      generation: this.generation,
      restartAttempts: this.restartAttempts,
      ...(this.handshake ? { executor: this.handshake.executor } : {}),
    };
  }

  /** Handshake facts (§2). Undefined until the first successful start. */
  negotiated(): MakaCuHandshake | undefined {
    return this.handshake;
  }

  async withSession<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    return this.sessionContext.run(sessionId, operation);
  }

  private assertActive(): void {
    if (this.disposed) {
      throw new MakaCuLifecycleError(
        'service_unavailable',
        'maka-cu service disposed',
        this.generation,
      );
    }
  }

  private emitRelease(
    reason: MakaCuReleaseEvent['reason'],
    sessionIds: readonly string[],
    outcomeUnknown: boolean,
    generationReleased: boolean,
  ): void {
    this.opts.onRelease?.({
      generation: this.generation,
      generationReleased,
      reason,
      sessionIds: [...new Set(sessionIds)],
      outcomeUnknown,
    });
  }

  async ensureStarted(signal?: AbortSignal): Promise<MakaCuHandshake> {
    this.assertActive();
    if (this.child && !this.child.killed && this.state === 'ready' && this.handshake) {
      return this.handshake;
    }
    if (!this.starting) {
      this.starting = this.startWithBudget().finally(() => {
        this.starting = undefined;
      });
    }
    const starting = this.starting;
    if (signal) await Promise.race([starting, abortPromise(signal)]);
    else await starting;
    if (!this.handshake) {
      throw new MakaCuLifecycleError(
        'service_unavailable',
        'maka-cu is not ready',
        this.generation,
      );
    }
    return this.handshake;
  }

  private async startWithBudget(): Promise<void> {
    const maxAttempts = this.opts.maxRestartAttempts ?? DEFAULT_MAX_RESTART_ATTEMPTS;
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
        this.lastStartError = undefined;
        this.nextRestartAt = undefined;
        return;
      } catch (error) {
        this.lastStartError = error;
        if (this.disposed) throw error;
        // §2: a protocol version mismatch is fatal and loud. Retrying it would
        // only re-spawn an executor that has already declared it cannot talk.
        // So is an unusable executable, and so is a handshake whose shape the
        // protocol forbids: all three answer the same way every time.
        if (
          isMakaCuLifecycleError(error, 'service_mismatch') ||
          (isMakaCuLifecycleError(error) && error.fatal) ||
          error instanceof MakaCuProtocolViolation
        ) {
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
    // `restartAttempts` only resets on a success, so every call after the
    // budget runs out re-enters here with the loop already false. Reading the
    // reason out of a loop-local left those later calls saying "restart budget
    // exhausted: undefined" for the whole process lifetime — the first failure
    // is remembered on the instance instead.
    const lastError = this.lastStartError;
    throw new MakaCuLifecycleError(
      'service_unavailable',
      // §1 sends every executor diagnostic to stderr, so the tail is the only
      // account of why an executor that never completed a handshake gave up.
      `maka-cu restart budget exhausted: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }${this.stderrTail ? ` (stderr: ${this.stderrTail.slice(-400)})` : ''}`,
      this.generation,
    );
  }

  private async start(): Promise<void> {
    this.assertActive();
    this.state = 'starting';
    const executablePath = await this.verifyExecutable();
    // §8/§11: after a crash the executor's images leak, and the host owns the
    // directory, so it is purged here rather than trusted to be empty.
    await rm(this.opts.imageDir, { recursive: true, force: true });
    await mkdir(this.opts.imageDir, { recursive: true, mode: 0o700 });
    this.assertActive();

    // `host` is not optional. The same executable also serves `doctor`,
    // `list-apps` and `snapshot` for a human at a terminal, and a bare
    // invocation prints help and exits — which is what happened the first time
    // this ran against a real executor: the child died before the handshake and
    // the host reported an exhausted restart budget rather than a wrong argv.
    // §11 said "spawns the executor as a direct child" and did not say with
    // what, so the two sides each picked, and disagreed.
    const child = spawn(executablePath, ['host'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      // §13: no env-var behaviour switches. Everything behavioural is a
      // `host.hello` parameter, so the wire says what the executor will do.
      env: this.childEnv,
    });
    this.generation += 1;
    this.child = child;
    this.buffer = '';
    this.stderrTail = '';
    this.nonJsonLines = 0;
    this.childError = undefined;
    this.handshake = undefined;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onStdout(child, chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => this.onStderr(child, chunk));
    child.stdin.on('error', () => this.onExit(child, 'child_exit'));
    child.on('exit', () => this.onExit(child, 'child_exit'));
    // The `Error` is the whole diagnosis on the one path this binary actually
    // fails: maka-cu is unsigned, hand-built and not distributed, so ENOENT,
    // EACCES and EFTYPE are the expected case, and discarding it here left the
    // host reporting a child exit for a child that never existed.
    child.on('error', (error: Error) => {
      if (this.child === child) this.childError = error;
      this.onExit(child, 'child_exit');
    });

    try {
      this.handshake = await this.hello();
      this.assertActive();
      this.state = 'ready';
    } catch (error) {
      this.kill('child_exit');
      throw error;
    }
  }

  private async hello(): Promise<MakaCuHandshake> {
    const timeoutMs = this.opts.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    const protocol = this.opts.protocolVersion ?? MAKA_CU_PROTOCOL_VERSION;
    const response = await this.request(
      'host.hello',
      {
        protocol,
        host: { name: 'maka', version: this.opts.hostVersion },
        hostPid: process.pid,
        imageDir: this.opts.imageDir,
        allowGlobalPointer: MAKA_CU_ALLOW_GLOBAL_POINTER,
      },
      { timeoutMs },
    );
    if (response.error) {
      const supported = response.error.data?.supported;
      throw new MakaCuLifecycleError(
        response.error.code === MAKA_CU_RPC_ERROR.protocolVersionMismatch
          ? 'service_mismatch'
          : 'service_unavailable',
        `host.hello rejected: ${response.error.message}${
          Array.isArray(supported) ? ` (executor supports ${supported.join(', ')})` : ''
        }`,
        this.generation,
      );
    }
    const envelope = readEnvelope('host.hello', response.result);
    if (!envelope.ok) {
      throw new MakaCuLifecycleError(
        'service_mismatch',
        `host.hello refused: ${envelope.error.code}`,
        this.generation,
      );
    }
    if (envelope.protocol !== protocol) {
      throw new MakaCuLifecycleError(
        'service_mismatch',
        `executor answered protocol ${String(envelope.protocol)}, host speaks ${protocol}`,
        this.generation,
      );
    }
    return {
      executor: readExecutorInfo(envelope.executor),
      pid: readNumber(envelope.pid, 'pid'),
      capabilities: readCapabilities(envelope.capabilities),
      limits: readLimits(envelope.limits),
    };
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
          // A file that is there and is the wrong one. This is the only
          // mismatch in this method: the two sides disagree about which build
          // is installed, which is what `service_mismatch` means everywhere
          // else and what maps to the model-facing protocol_violation sentence.
          throw new MakaCuLifecycleError(
            'service_mismatch',
            `binary sha256 mismatch: expected ${this.opts.expectedBinarySha256}, got ${actual}`,
            this.generation,
            undefined,
            true,
          );
        }
      }
      return resolved;
    } catch (error) {
      this.state = 'unavailable';
      if (isMakaCuLifecycleError(error)) throw error;
      // Absent, unreadable or not executable. Nothing about it is a version
      // skew, and coding it `service_mismatch` sent every "the binary is not
      // there" straight to a sentence about two builds disagreeing. Fatal all
      // the same: respawning a path that does not resolve cannot start working.
      throw new MakaCuLifecycleError(
        'service_unavailable',
        `maka-cu executable is not usable at ${this.opts.binaryPath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        this.generation,
        undefined,
        true,
      );
    }
  }

  private onStdout(child: ChildProcessWithoutNullStreams, chunk: string): void {
    if (this.child !== child) return;
    const rest = decodeJsonLines(this.buffer, chunk, {
      // §1: the cap is the negotiated `limits.maxResponseBytes` once the
      // executor has declared one, so an executor allowed to send an 8 MiB tree
      // is not torn down in the middle of a response it was told it could send.
      // Before the handshake there is no declared bound, so the floor applies.
      maxBufferBytes: this.stdoutBufferCap(),
      // An unparseable tail past the cap is the peer having stopped framing,
      // which is §1's protocol violation and not an ordinary child exit — the
      // report said "exited after request delivery" for a host-initiated kill.
      onOverflow: () => this.kill('protocol_violation'),
      onMessage: (value) => {
        // `decodeJsonLines` hands over any JSON value, and `null`, `4` and
        // `"x"` are all valid JSON lines that are not responses. Reading `.id`
        // off `null` threw a TypeError inside this stdout `data` listener,
        // where no caller is on the stack to catch it, and took the Electron
        // main process down. A Rust executor serialising `Option::None` on an
        // error path emits exactly those five bytes.
        //
        // Counted under the same budget as a non-JSON line rather than
        // dropped: a peer emitting non-messages on the response stream has
        // stopped speaking the protocol, whether or not the bytes parse.
        if (!isRecord(value)) {
          this.countNonProtocolLine();
          return;
        }
        const message = value as unknown as MakaCuRpcResponse;
        // §1: responses MAY arrive out of order; correlation is by id only.
        if (typeof message.id !== 'number') return;
        this.pending.get(message.id)?.resolve(message);
      },
      onNonJsonLine: () => this.countNonProtocolLine(),
    });
    if (this.child === child) this.buffer = rest;
  }

  /** §1: the stdout budget, once the executor has declared what it may send. */
  private stdoutBufferCap(): number {
    const declared = this.handshake?.limits.maxResponseBytes;
    if (declared === undefined) return MIN_STDOUT_BUFFER;
    // Two whole responses plus slack, the same headroom the fixed cap carried,
    // and never below the floor a handshake itself needs.
    return Math.max(MIN_STDOUT_BUFFER, declared * 2 + STDOUT_BUFFER_SLACK);
  }

  /** §1: three stdout lines that are not protocol messages are grounds for teardown. */
  private countNonProtocolLine(): void {
    this.nonJsonLines += 1;
    if (this.nonJsonLines >= MAX_NON_JSON_LINES) this.kill('protocol_violation');
  }

  private onStderr(child: ChildProcessWithoutNullStreams, chunk: string): void {
    if (this.child !== child) return;
    this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_CAP);
  }

  /** §11: classify in-flight requests by stage. Delivered means outcome unknown. */
  private onExit(
    child: ChildProcessWithoutNullStreams,
    reason: MakaCuReleaseEvent['reason'],
  ): void {
    if (this.child !== child) return;
    const requests = [...this.pending.values()];
    this.pending.clear();
    // An exec that never happened delivered nothing, whatever stage the write
    // reached: `spawn` resolves the write against a pipe that has no process on
    // the other end. Reporting those as outcome_unknown sent whoever read it
    // looking for an executor that had died mid-action, when the truth was a
    // file that could not be executed.
    const execFailed = this.childError !== undefined;
    const potentiallyDelivered = execFailed
      ? []
      : requests.filter((request) => request.stage === 'writing' || request.stage === 'delivered');
    const sessionIds = potentiallyDelivered.flatMap((request) =>
      request.sessionId ? [request.sessionId] : [],
    );
    const delivered = new Set(potentiallyDelivered);
    for (const request of requests) {
      request.reject(
        delivered.has(request)
          ? new MakaCuLifecycleError(
              'outcome_unknown',
              this.terminationReason(reason, true),
              this.generation,
              request.stage,
            )
          : new MakaCuLifecycleError(
              'service_unavailable',
              this.terminationReason(reason, false),
              this.generation,
              request.stage,
            ),
      );
    }
    this.child = undefined;
    this.buffer = '';
    this.handshake = undefined;
    if (!this.disposed) {
      this.state = 'idle';
      this.nextRestartAt = Date.now() + (this.opts.restartBackoffMs ?? DEFAULT_RESTART_BACKOFF_MS);
    }
    this.emitRelease(reason, sessionIds, potentiallyDelivered.length > 0, true);
  }

  /**
   * Why the child is gone, not just that it is.
   *
   * Every host-initiated kill except `request_timeout` used to report "exited
   * after request delivery" — a stdout framing overflow, three lines that were
   * not protocol messages, a session being cleared and the host's own
   * `dispose()` all read as "the executor died", which sends whoever is looking
   * at it to the wrong side. And `child.on('error')` discarded its `Error`, so
   * ENOENT, EACCES and EFTYPE — the expected failures for an unsigned,
   * hand-built binary that is not distributed — were thrown away entirely:
   * verified against a 0755 file whose interpreter does not exist, the report
   * was "maka-cu exited after request delivery" for a child that never execed.
   */
  private terminationReason(reason: MakaCuReleaseEvent['reason'], delivered: boolean): string {
    if (this.childError) {
      return `maka-cu could not be executed: ${this.childError.message}`;
    }
    switch (reason) {
      case 'request_timeout':
        return 'maka-cu did not answer within the host deadline and was terminated';
      case 'protocol_violation':
        return 'maka-cu sent stdout that is not this protocol and was terminated';
      case 'session_cleared':
        return 'maka-cu was terminated while clearing a session with a request in flight';
      case 'disposed':
        return 'the host shut maka-cu down';
      case 'restart_exhausted':
        return 'maka-cu could not be started within the restart budget';
      default:
        return delivered
          ? 'maka-cu exited after request delivery'
          : 'maka-cu exited before request delivery';
    }
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
    opts: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<MakaCuRpcResponse> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const child = this.child;
      if (!child || child.killed) {
        reject(
          new MakaCuLifecycleError(
            'service_unavailable',
            'maka-cu is not running',
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
        if (onAbort && opts.signal) opts.signal.removeEventListener('abort', onAbort);
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
        cancel: () => {},
      };
      this.pending.set(id, entry);
      // §7.2: a delivered request is cancelled by asking, not by killing the
      // child. The executor answers `aborted` if it has not dispatched yet and
      // the real outcome if it has — killing here would turn every cancelled
      // pre-dispatch request into outcome_unknown and lose the action's fate.
      //
      // The ask is bounded. If the executor does not answer inside
      // CANCEL_GRACE_MS the request is torn down the way an unanswered deadline
      // is, because a cancel the executor ignores is an executor that is not
      // answering, and a caller left hanging on it blocks the whole lane.
      const requestCancel = () => {
        if (entry.cancelRequested) return;
        entry.cancelRequested = true;
        this.notify('$/cancel', { id });
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => this.kill('request_timeout'), CANCEL_GRACE_MS);
      };
      entry.cancel = requestCancel;
      if (opts.signal) {
        if (opts.signal.aborted) {
          entry.reject(
            new MakaCuLifecycleError(
              'aborted',
              'request aborted before delivery',
              this.generation,
              entry.stage,
            ),
          );
          return;
        }
        onAbort = () => {
          if (entry.stage === 'writing' || entry.stage === 'delivered') {
            requestCancel();
            return;
          }
          entry.reject(
            new MakaCuLifecycleError(
              'aborted',
              'request aborted before delivery',
              this.generation,
              entry.stage,
            ),
          );
        };
        opts.signal.addEventListener('abort', onAbort, { once: true });
      }
      const timeoutMs = opts.timeoutMs ?? this.opts.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
      timer = setTimeout(() => {
        // §7.3: the host owns the deadline and enforces it with `$/cancel`,
        // followed by teardown when the request had already been delivered.
        // The teardown waits for the cancel to be answered — killing in the
        // same tick left the notify sitting in an unflushed stdin buffer.
        if (entry.stage === 'writing' || entry.stage === 'delivered') {
          requestCancel();
          return;
        }
        this.notify('$/cancel', { id });
        entry.reject(
          new MakaCuLifecycleError(
            'service_unavailable',
            `maka-cu ${method} timed out before delivery`,
            this.generation,
            entry.stage,
          ),
        );
      }, timeoutMs);
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

  /**
   * One request/response round trip. JSON-RPC `error` becomes MakaCuRpcError;
   * the `result` envelope is handed back whole so the caller can act on the
   * domain arm (§1.1) without this layer inventing a meaning for it.
   */
  async call(method: string, params: unknown, signal?: AbortSignal): Promise<MakaCuEnvelope> {
    this.assertActive();
    await this.ensureStarted(signal);
    this.assertActive();
    const response = await this.request(method, params, { ...(signal ? { signal } : {}) });
    if (response.error) throw new MakaCuRpcError(method, response.error);
    return readEnvelope(method, response.result);
  }

  clearSession(sessionId: string): void {
    // §7.2: cancel this session's in-flight work by asking, not by killing.
    //
    // Killing the child ended every other session with it, and the executor
    // never got its `$/cancel` or its `session.end` — so one session's stop
    // took down a sibling session's observation and left the executor's agent
    // cursor and images behind. The cancel is bounded by CANCEL_GRACE_MS, and
    // an executor that ignores it is torn down there, which is the only case
    // that still costs the generation.
    const owned = [...this.pending.values()].filter(
      (request) =>
        request.sessionId === sessionId &&
        (request.stage === 'writing' || request.stage === 'delivered'),
    );
    for (const request of owned) request.cancel();
    // Delivered means the executor may already have driven the screen, so what
    // happened to it is unknown even though this session is being dropped.
    this.emitRelease('session_cleared', [sessionId], owned.length > 0, false);
  }

  /** The executor stated a path or a shape the protocol forbids (§6.3). */
  reportProtocolViolation(): void {
    this.kill('protocol_violation');
  }

  private kill(reason: MakaCuReleaseEvent['reason']): void {
    const child = this.child;
    if (!child) return;
    child.kill('SIGKILL');
    this.onExit(child, reason);
  }

  dispose(): void {
    if (this.disposed) return;
    // Captured before `disposed` is set, because `assertActive()` is what makes
    // an in-flight `start()` reject, and the rejection is what this has to wait
    // for. `dispose()` during startup ran its purge, then `start()` carried on
    // to `mkdir` the image directory it had just deleted and left it on disk
    // for good — nothing ever purges it again, because the next spawn purges
    // the directory of a service that no longer exists. cua-driver's supervisor
    // already had this exact guard and maka-cu's copy dropped it.
    const starting = this.starting;
    this.disposed = true;
    this.state = 'disposed';
    const child = this.child;
    const grace = this.handshake?.limits.shutdownGraceMs ?? FALLBACK_SHUTDOWN_GRACE_MS;
    const purge = () => {
      void rm(this.opts.imageDir, { recursive: true, force: true }).catch(() => {
        // Image-directory cleanup must not make host shutdown fail; the next
        // spawn purges it again anyway (§8).
      });
    };
    if (child) {
      // §11: SIGTERM lets in-flight mutating dispatches finish and every session
      // end — which is what removes the executor-drawn cursor and the images.
      // SIGKILL first would leak both.
      try {
        child.kill('SIGTERM');
      } catch {
        // Already gone.
      }
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // Already gone.
        }
        purge();
      }, grace);
      timer.unref?.();
      child.once('exit', () => {
        clearTimeout(timer);
        purge();
      });
      this.onExit(child, 'disposed');
    } else {
      purge();
    }
    // An in-flight `start()` outlives this call and will `mkdir` the directory
    // again on its way to rejecting. Purge once more when it has finished doing
    // so, whichever way it ends.
    void starting?.then(purge, purge);
    try {
      this.emitRelease('disposed', [], false, false);
    } catch {
      // Release observers must not interrupt process cleanup.
    }
  }
}

/**
 * A handshake reader that rejects the value it was given.
 *
 * These throw `MakaCuProtocolViolation` rather than a plain `Error` so the one
 * classifier that exists actually sees them: `backendFailure` matches on the
 * type, and on a plain `Error` it matched nothing, `reportProtocolViolation()`
 * never fired, and `startWithBudget` read a structurally broken handshake as a
 * transient failure and respawned the same binary three times to be told the
 * same thing.
 */
function violation(what: string, reason: string): MakaCuProtocolViolation {
  return new MakaCuProtocolViolation('host.hello', `${what} ${reason}`);
}

function readNumber(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw violation(what, 'is not a finite number');
  }
  return value;
}

/**
 * §2: a limit is a positive whole number, and the host runs on it.
 *
 * "Is it a number" was not enough, because the host does arithmetic and loops
 * with these. `snapshotsPerSession: 0` — the conventional spelling of
 * "unlimited", and a plausible executor default — wedged the main process in an
 * infinite synchronous loop: the eviction loop is `while (ids.length >=
 * snapshotsPerSession)`, a fresh session has no ids, `0 >= 0` holds, the
 * forget is a no-op on an id that is not there, and nothing in the condition
 * can change. No abort, no timeout and no `dispose()` can run, because the
 * event loop is the thing that is blocked. `snapshotTtlMs: -1` expires every
 * snapshot the moment it is stored, so the click after an observe is refused
 * with a `stale_frame` sentence that is false about what happened. And
 * `shutdownGraceMs: 0` SIGKILLs the executor immediately, leaking the
 * executor-drawn cursor and the image directory that SIGTERM exists to clean
 * up.
 *
 * None of those is a number the host can honour, so none of them is accepted.
 */
function readLimit(value: unknown, what: string): number {
  const parsed = readNumber(value, what);
  if (!Number.isSafeInteger(parsed)) throw violation(what, 'is not a whole number');
  if (parsed < 1) throw violation(what, `must be at least 1, got ${parsed}`);
  return parsed;
}

function readStringArray(value: unknown, what: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw violation(what, 'is not a string array');
  }
  return value as string[];
}

function readExecutorInfo(value: unknown): MakaCuExecutorInfo {
  const record = (value ?? {}) as Record<string, unknown>;
  if (typeof record.name !== 'string' || typeof record.version !== 'string') {
    throw violation('executor', 'identity is missing');
  }
  return {
    name: record.name,
    version: record.version,
    ...(typeof record.commit === 'string' ? { commit: record.commit } : {}),
  };
}

function readCapabilities(value: unknown): MakaCuCapabilities {
  const record = (value ?? {}) as Record<string, unknown>;
  if (typeof record.captureStream !== 'boolean') {
    throw violation('capabilities.captureStream', 'is missing');
  }
  return {
    captureStream: record.captureStream,
    elementActions: readStringArray(record.elementActions, 'capabilities.elementActions'),
    pointActions: readStringArray(record.pointActions, 'capabilities.pointActions'),
    keyActions: readStringArray(record.keyActions, 'capabilities.keyActions'),
    imageFormats: readStringArray(record.imageFormats, 'capabilities.imageFormats'),
  };
}

function readLimits(value: unknown): MakaCuLimits {
  if (!isRecord(value)) throw violation('limits', 'is not an object');
  return {
    snapshotsPerSession: readLimit(value.snapshotsPerSession, 'limits.snapshotsPerSession'),
    snapshotTtlMs: readLimit(value.snapshotTtlMs, 'limits.snapshotTtlMs'),
    maxElements: readLimit(value.maxElements, 'limits.maxElements'),
    maxDepth: readLimit(value.maxDepth, 'limits.maxDepth'),
    maxTextChars: readLimit(value.maxTextChars, 'limits.maxTextChars'),
    maxResponseBytes: readLimit(value.maxResponseBytes, 'limits.maxResponseBytes'),
    settleCeilingMs: readLimit(value.settleCeilingMs, 'limits.settleCeilingMs'),
    shutdownGraceMs: readLimit(value.shutdownGraceMs, 'limits.shutdownGraceMs'),
    imageDirBudgetBytes: readLimit(value.imageDirBudgetBytes, 'limits.imageDirBudgetBytes'),
  };
}

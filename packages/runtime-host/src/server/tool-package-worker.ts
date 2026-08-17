import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { PermissionProfileManaged } from '@maka/core/permission-profile';
import { createDefaultSandboxManager } from '@maka/runtime/sandbox';
import type { MakaTool, MakaToolContext } from '@maka/runtime/tool-runtime';
import { z } from 'zod';
import type { InstalledToolPackage, ToolPackageManifest } from './tool-package-store.js';
import type { ExtensionConfigurationScalar } from '../protocol/extension.js';

const WORKER_MAIN = fileURLToPath(new URL('../tool-package-worker-main.js', import.meta.url));
const HEALTH_TIMEOUT_MS = 10_000;
const INVOCATION_TIMEOUT_MS = 120_000;
const DRAIN_TIMEOUT_MS = 30_000;
const MAX_DIAGNOSTIC_BYTES = 64 * 1024;
const MAX_PROTOCOL_BYTES = 2 * 1024 * 1024;

export interface PackageWorkerInvocationContext {
  readonly sessionId: string;
  readonly runId?: string;
  readonly turnId: string;
  readonly cwd: string;
  readonly toolCallId: string;
  readonly operationId?: string;
  readonly abortSignal: AbortSignal;
  readonly permissionMode?: string;
  readonly origin?: 'provider' | 'code_mode' | 'host';
  readonly eventDepth?: number;
  readonly emitOutput?: (stream: 'stdout' | 'stderr', chunk: string) => void;
}

export type PackageWorkerEventEmitter = (
  event: string,
  payload: unknown,
  context: PackageWorkerInvocationContext,
) => Promise<unknown>;

type WorkerRequest =
  | { readonly kind: 'health'; readonly handlers: readonly string[] }
  | {
      readonly kind: 'invoke';
      readonly handler: string;
      readonly args: unknown;
      readonly context: {
        readonly sessionId: string;
        readonly runId?: string;
        readonly turnId: string;
        readonly cwd: string;
        readonly toolCallId: string;
        readonly operationId?: string;
        readonly configuration: Readonly<Record<string, ExtensionConfigurationScalar>>;
      };
    };

interface WorkerOutputFrame {
  readonly kind: 'output';
  readonly stream: 'stdout' | 'stderr';
  readonly chunk: string;
}

interface WorkerResultFrame {
  readonly kind: 'result';
  readonly result: unknown;
}

interface WorkerErrorFrame {
  readonly kind: 'error';
  readonly error: { readonly name: string; readonly message: string; readonly stack?: string };
}

type WorkerFrame = WorkerOutputFrame | WorkerResultFrame | WorkerErrorFrame;

export class ToolPackageWorkerError extends Error {
  readonly name = 'ToolPackageWorkerError';

  constructor(
    readonly code:
      | 'sandbox_unavailable'
      | 'worker_failed'
      | 'worker_crashed'
      | 'timed_out'
      | 'aborted'
      | 'retired',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/** One activation generation. Invocations use isolated one-shot workers and are lease-drained. */
export class ToolPackageActivation {
  readonly #children = new Set<ChildProcess>();
  readonly #invocations = new Set<Promise<unknown>>();
  #retired = false;

  constructor(
    readonly packageRevision: InstalledToolPackage,
    readonly configuration: Readonly<Record<string, ExtensionConfigurationScalar>> = Object.freeze(
      {},
    ),
    private readonly environment: Readonly<Record<string, string>> = Object.freeze({}),
    private readonly emitEvent?: PackageWorkerEventEmitter,
  ) {}

  tools(): readonly MakaTool[] {
    return Object.freeze(
      this.packageRevision.manifest.tools.map((declaration) => {
        let parameters: unknown;
        try {
          parameters = z.fromJSONSchema(declaration.inputSchema);
        } catch (error) {
          throw new ToolPackageWorkerError(
            'worker_failed',
            `Tool package JSON Schema is unsupported: ${declaration.name}`,
            { cause: error },
          );
        }
        const tool: MakaTool = {
          name: declaration.name,
          description: declaration.description,
          parameters,
          ...(declaration.displayName ? { displayName: declaration.displayName } : {}),
          categoryHint: effectiveCategory(this.packageRevision.manifest, declaration.category),
          recoveryMode: declaration.recoveryMode ?? 'never_auto_retry',
          executionFacts: executionFacts(this.packageRevision.manifest),
          permissionArgs: (args) => args,
          impl: (args, context) => this.invoke(declaration.handler, args, context),
        };
        return Object.freeze(tool);
      }),
    );
  }

  async healthCheck(): Promise<void> {
    this.#assertActive();
    await this.#run(
      {
        kind: 'health',
        handlers: this.packageRevision.manifest.tools.map(({ handler }) => handler),
      },
      this.packageRevision.root,
      undefined,
      HEALTH_TIMEOUT_MS,
    );
  }

  invoke(handler: string, args: unknown, context: MakaToolContext): Promise<unknown> {
    return this.invokeRaw(handler, args, context, INVOCATION_TIMEOUT_MS);
  }

  invokeRaw(
    handler: string,
    args: unknown,
    context: PackageWorkerInvocationContext,
    timeoutMs: number,
  ): Promise<unknown> {
    this.#assertActive();
    const invocation = this.#run(
      {
        kind: 'invoke',
        handler,
        args,
        context: {
          sessionId: context.sessionId,
          ...(context.runId ? { runId: context.runId } : {}),
          turnId: context.turnId,
          cwd: context.cwd,
          toolCallId: context.toolCallId,
          ...(context.operationId ? { operationId: context.operationId } : {}),
          configuration: this.configuration,
        },
      },
      context.cwd,
      context,
      timeoutMs,
    );
    this.#invocations.add(invocation);
    void invocation.then(
      () => this.#invocations.delete(invocation),
      () => this.#invocations.delete(invocation),
    );
    return invocation;
  }

  async dispose(): Promise<void> {
    if (this.#retired) return;
    this.#retired = true;
    if (this.#invocations.size === 0) return;
    let timer: NodeJS.Timeout | undefined;
    const drained = Promise.allSettled([...this.#invocations]);
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), DRAIN_TIMEOUT_MS);
      timer.unref();
    });
    try {
      if ((await Promise.race([drained, timedOut])) === 'timeout') {
        for (const child of this.#children) terminate(child);
        await Promise.allSettled([...this.#invocations]);
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async #run(
    request: WorkerRequest,
    cwd: string,
    context: PackageWorkerInvocationContext | undefined,
    timeoutMs: number,
  ): Promise<unknown> {
    this.#assertActive();
    const canonicalCwd = canonicalPath(cwd);
    const transformed = createDefaultSandboxManager().transform({
      command: {
        program: process.execPath,
        args: [WORKER_MAIN, this.packageRevision.entry],
        cwd: canonicalCwd,
        env: workerEnvironment(this.environment),
        profile: workerProfile(this.packageRevision.manifest),
        pathContext: {
          workspaceRoots: [canonicalCwd],
          tmpdir: tmpdir(),
          slashTmp: '/tmp',
          runtimeReadableRoots: [
            canonicalPath(dirname(WORKER_MAIN)),
            canonicalPath(this.packageRevision.root),
          ],
          executableRoots: runtimeExecutableRoots(process.execPath),
          ...(process.platform === 'linux'
            ? { minimalRoots: linuxExecutableRoots({ execPath: process.execPath }) }
            : {}),
        },
      },
      preference: 'require',
    });
    if (!transformed.ok) {
      throw new ToolPackageWorkerError(
        'sandbox_unavailable',
        transformed.message ?? `Tool package sandbox is unavailable: ${transformed.reason}`,
      );
    }
    const [program, ...args] = transformed.exec.argv;
    if (!program)
      throw new ToolPackageWorkerError('sandbox_unavailable', 'Sandbox launch is empty');
    const child = spawn(program, args, {
      cwd: transformed.exec.cwd,
      env: normalizedEnvironment(transformed.exec.env),
      stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
    });
    this.#children.add(child);
    try {
      return await exchange(child, request, context, timeoutMs, this.emitEvent);
    } finally {
      this.#children.delete(child);
    }
  }

  #assertActive(): void {
    if (this.#retired) {
      throw new ToolPackageWorkerError(
        'retired',
        `Tool package activation is retired: ${this.packageRevision.extensionId}@${this.packageRevision.revision}`,
      );
    }
  }
}

async function exchange(
  child: ChildProcess,
  request: WorkerRequest,
  context: PackageWorkerInvocationContext | undefined,
  timeoutMs: number,
  emitEvent: PackageWorkerEventEmitter | undefined,
): Promise<unknown> {
  const auth = randomBytes(32).toString('hex');
  const input = child.stdio[3] as Writable | null;
  const output = child.stdio[4] as Readable | null;
  const childStdio = child.stdio as Array<Readable | Writable | null | undefined>;
  const callbackInput = childStdio[5] as Readable | null | undefined;
  const callbackOutput = childStdio[6] as Writable | null | undefined;
  if (!input || !output || !callbackInput || !callbackOutput) {
    terminate(child);
    throw new ToolPackageWorkerError(
      'worker_failed',
      'Tool package protocol pipes are unavailable',
    );
  }
  input.on('error', () => terminate(child));
  output.on('error', () => terminate(child));
  callbackInput.on('error', () => terminate(child));
  callbackOutput.on('error', () => terminate(child));
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  child.stdout?.on('data', (chunk: Buffer) => {
    stdoutBytes = appendBounded(stdout, stdoutBytes, chunk, MAX_DIAGNOSTIC_BYTES);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrBytes = appendBounded(stderr, stderrBytes, chunk, MAX_DIAGNOSTIC_BYTES);
  });
  child.stdout?.on('error', () => terminate(child));
  child.stderr?.on('error', () => terminate(child));

  let protocol = '';
  let protocolBytes = 0;
  let terminal: WorkerResultFrame | WorkerErrorFrame | undefined;
  let protocolFailure: Error | undefined;
  output.on('data', (chunk: Buffer) => {
    if (protocolFailure) return;
    protocolBytes += chunk.byteLength;
    if (protocolBytes > MAX_PROTOCOL_BYTES) {
      protocolFailure = new Error('Tool package protocol output exceeds its size limit');
      terminate(child);
      return;
    }
    protocol += chunk.toString('utf8');
    let newline: number;
    while ((newline = protocol.indexOf('\n')) >= 0) {
      const encoded = protocol.slice(0, newline);
      protocol = protocol.slice(newline + 1);
      if (!encoded) continue;
      try {
        const frame = decodeFrame(JSON.parse(encoded), auth);
        if (frame.kind === 'output') context?.emitOutput?.(frame.stream, frame.chunk);
        else if (terminal) throw new Error('Tool package worker emitted multiple terminal frames');
        else {
          terminal = frame;
          // No callback can be initiated after the handler's terminal frame.
          // Closing the parent-to-worker lane lets the worker's callback reader
          // observe EOF and release its final event-loop handle.
          callbackOutput.end();
        }
      } catch (error) {
        protocolFailure = error instanceof Error ? error : new Error(String(error));
        terminate(child);
        return;
      }
    }
  });

  let callbackProtocol = '';
  let callbackBytes = 0;
  callbackInput.on('data', (chunk: Buffer) => {
    if (protocolFailure) return;
    callbackBytes += chunk.byteLength;
    if (callbackBytes > MAX_PROTOCOL_BYTES) {
      protocolFailure = new Error('Tool package callback protocol exceeds its size limit');
      terminate(child);
      return;
    }
    callbackProtocol += chunk.toString('utf8');
    let newline: number;
    while ((newline = callbackProtocol.indexOf('\n')) >= 0) {
      const encoded = callbackProtocol.slice(0, newline);
      callbackProtocol = callbackProtocol.slice(newline + 1);
      if (!encoded) continue;
      let frame: { id: string; event: string; payload: unknown };
      try {
        frame = decodeCallbackFrame(JSON.parse(encoded), auth);
      } catch (error) {
        protocolFailure = error instanceof Error ? error : new Error(String(error));
        terminate(child);
        return;
      }
      void Promise.resolve()
        .then(async () => {
          if (!context || !emitEvent) throw new Error('Extension Event emission is unavailable');
          return await emitEvent(frame.event, frame.payload, context);
        })
        .then(
          (result) =>
            writeCallbackFrame(callbackOutput, auth, {
              kind: 'emit_event_result',
              id: frame.id,
              ok: true,
              result,
            }),
          (error) =>
            writeCallbackFrame(callbackOutput, auth, {
              kind: 'emit_event_result',
              id: frame.id,
              ok: false,
              error: boundedCallbackError(error),
            }),
        )
        .catch((error) => {
          protocolFailure = error instanceof Error ? error : new Error(String(error));
          terminate(child);
        });
    }
  });

  const encodedRequest = JSON.stringify({ ...request, auth });
  if (Buffer.byteLength(encodedRequest, 'utf8') > 512 * 1024) {
    terminate(child);
    throw new ToolPackageWorkerError('worker_failed', 'Tool package invocation input is too large');
  }
  input.end(encodedRequest);

  return new Promise<unknown>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown, value?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      context?.abortSignal.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve(value);
    };
    const onAbort = (): void => {
      terminate(child);
      finish(
        new ToolPackageWorkerError('aborted', 'Tool package invocation was aborted', {
          cause: context?.abortSignal.reason,
        }),
      );
    };
    const timeout = setTimeout(() => {
      terminate(child);
      finish(new ToolPackageWorkerError('timed_out', 'Tool package invocation timed out'));
    }, timeoutMs);
    timeout.unref();
    context?.abortSignal.addEventListener('abort', onAbort, { once: true });
    if (context?.abortSignal.aborted) return onAbort();

    child.once('error', (error) => {
      finish(
        new ToolPackageWorkerError('worker_crashed', 'Unable to launch Tool package worker', {
          cause: error,
        }),
      );
    });
    child.once('close', (code, signal) => {
      if (protocolFailure) {
        return finish(
          new ToolPackageWorkerError('worker_failed', protocolFailure.message, {
            cause: protocolFailure,
          }),
        );
      }
      if (!terminal) {
        return finish(
          new ToolPackageWorkerError(
            'worker_crashed',
            workerExitMessage(code, signal, stdout, stderr),
          ),
        );
      }
      if (terminal.kind === 'error') {
        return finish(
          new ToolPackageWorkerError('worker_failed', terminal.error.message, {
            cause: Object.assign(new Error(terminal.error.message), {
              name: terminal.error.name,
              stack: terminal.error.stack,
            }),
          }),
        );
      }
      if (code !== 0) {
        return finish(
          new ToolPackageWorkerError(
            'worker_crashed',
            workerExitMessage(code, signal, stdout, stderr),
          ),
        );
      }
      return finish(undefined, terminal.result);
    });
  });
}

function decodeFrame(value: unknown, expectedAuth: string): WorkerFrame {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Tool package worker frame is invalid');
  }
  const frame = value as Record<string, unknown>;
  if (
    typeof frame.auth !== 'string' ||
    frame.auth.length !== expectedAuth.length ||
    !timingSafeEqual(Buffer.from(frame.auth), Buffer.from(expectedAuth))
  ) {
    throw new Error('Tool package worker frame authentication failed');
  }
  if (frame.kind === 'output') {
    exactFrameKeys(frame, ['kind', 'stream', 'chunk', 'auth']);
    if (
      (frame.stream !== 'stdout' && frame.stream !== 'stderr') ||
      typeof frame.chunk !== 'string' ||
      Buffer.byteLength(frame.chunk, 'utf8') > 256 * 1024
    ) {
      throw new Error('Tool package worker output frame is invalid');
    }
    return { kind: 'output', stream: frame.stream, chunk: frame.chunk };
  }
  if (frame.kind === 'result') {
    exactFrameKeys(frame, ['kind', 'result', 'auth']);
    return { kind: 'result', result: frame.result };
  }
  if (frame.kind === 'error') {
    exactFrameKeys(frame, ['kind', 'error', 'auth']);
    if (!frame.error || typeof frame.error !== 'object' || Array.isArray(frame.error)) {
      throw new Error('Tool package worker error frame is invalid');
    }
    const error = frame.error as Record<string, unknown>;
    if (Object.keys(error).some((key) => !['name', 'message', 'stack'].includes(key))) {
      throw new Error('Tool package worker error fields are invalid');
    }
    if (typeof error.name !== 'string' || typeof error.message !== 'string') {
      throw new Error('Tool package worker error is invalid');
    }
    return {
      kind: 'error',
      error: {
        name: error.name,
        message: error.message,
        ...(typeof error.stack === 'string' ? { stack: error.stack } : {}),
      },
    };
  }
  throw new Error('Tool package worker frame kind is invalid');
}

function decodeCallbackFrame(
  value: unknown,
  expectedAuth: string,
): { id: string; event: string; payload: unknown } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Tool package callback frame is invalid');
  }
  const frame = value as Record<string, unknown>;
  exactFrameKeys(frame, ['kind', 'id', 'event', 'payload', 'auth']);
  if (
    frame.kind !== 'emit_event' ||
    typeof frame.auth !== 'string' ||
    frame.auth.length !== expectedAuth.length ||
    !timingSafeEqual(Buffer.from(frame.auth), Buffer.from(expectedAuth)) ||
    typeof frame.id !== 'string' ||
    !/^[a-f0-9]{32}$/u.test(frame.id) ||
    typeof frame.event !== 'string' ||
    !/^[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z][A-Za-z0-9_-]*)+$/u.test(frame.event) ||
    Buffer.byteLength(frame.event, 'utf8') > 192
  ) {
    throw new Error('Tool package Event callback is invalid');
  }
  return { id: frame.id, event: frame.event, payload: frame.payload };
}

function writeCallbackFrame(output: Writable, auth: string, frame: object): void {
  const encoded = `${JSON.stringify({ ...frame, auth })}\n`;
  if (Buffer.byteLength(encoded, 'utf8') > 1024 * 1024) {
    throw new Error('Tool package callback response exceeds its size limit');
  }
  output.write(encoded);
}

function boundedCallbackError(error: unknown): { name: string; message: string } {
  const value = error instanceof Error ? error : new Error(String(error));
  return {
    name: boundedText(value.name || 'Error', 128),
    message: boundedText(value.message || 'Extension Event emission failed', 4096),
  };
}

function boundedText(value: string, maxBytes: number): string {
  const encoded = Buffer.from(value, 'utf8');
  if (encoded.byteLength <= maxBytes) return value;
  return `${encoded
    .subarray(0, maxBytes - 3)
    .toString('utf8')
    .replace(/\uFFFD$/u, '')}...`;
}

function exactFrameKeys(frame: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(frame).length !== keys.length || keys.some((key) => !Object.hasOwn(frame, key))) {
    throw new Error('Tool package worker frame fields are invalid');
  }
}

function workerProfile(manifest: ToolPackageManifest): PermissionProfileManaged {
  const workspace = manifest.permissions.workspace;
  return {
    type: 'managed',
    name: 'custom',
    fileSystem: {
      kind: 'restricted',
      entries: [
        ...(workspace === 'none'
          ? []
          : [
              {
                kind: 'special' as const,
                access: workspace,
                special: ':workspace_roots' as const,
              },
            ]),
      ],
    },
    network: { kind: manifest.permissions.network ? 'enabled' : 'restricted' },
  };
}

function executionFacts(manifest: ToolPackageManifest): MakaTool['executionFacts'] {
  return Object.freeze({
    isolation: 'container',
    writesAffectHost: manifest.permissions.workspace === 'write',
    writeBack: 'direct',
    network: manifest.permissions.network ? 'sandbox' : 'disabled',
    secrets: 'none',
  });
}

function workerEnvironment(
  overrides: Readonly<Record<string, string>>,
): Readonly<Record<string, string | undefined>> {
  return Object.freeze({
    PATH: process.env.PATH,
    LANG: process.env.LANG ?? 'C.UTF-8',
    LC_ALL: process.env.LC_ALL,
    TMPDIR: tmpdir(),
    NODE_NO_WARNINGS: '1',
    ELECTRON_RUN_AS_NODE: process.versions.electron ? '1' : undefined,
    ...overrides,
  });
}

function normalizedEnvironment(
  env: Readonly<Record<string, string | undefined>> | undefined,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env ?? {}).filter((item): item is [string, string] => item[1] !== undefined),
  );
}

function runtimeExecutableRoots(execPath: string): readonly string[] {
  const appContents = execPath.match(/^(.*\.app\/Contents)\//u)?.[1];
  return [
    ...linuxExecutableRoots({ execPath }),
    ...(appContents ? [appContents] : []),
    ...(execPath.startsWith('/opt/homebrew/') ? ['/opt/homebrew'] : []),
    ...(execPath.startsWith('/usr/local/') ? ['/usr/local'] : []),
  ];
}

function effectiveCategory(
  manifest: ToolPackageManifest,
  declared: MakaTool['categoryHint'],
): NonNullable<MakaTool['categoryHint']> {
  if (manifest.permissions.workspace === 'write') {
    return declared === 'fs_destructive' ||
      declared === 'git_destructive' ||
      declared === 'shell_unsafe'
      ? declared
      : 'shell_unsafe';
  }
  if (manifest.permissions.network) {
    return declared === 'shell_unsafe' || declared === 'network_send' ? declared : 'network_send';
  }
  return declared ?? 'read';
}

function linuxExecutableRoots(input: { execPath: string; path?: string }): readonly string[] {
  const roots: string[] = [];
  const executableDirectory = dirname(input.execPath);
  roots.push(
    executableDirectory.endsWith('/bin') ? dirname(executableDirectory) : executableDirectory,
  );
  for (const entry of input.path?.split(':') ?? []) {
    if (entry.startsWith('/') && entry !== '/') roots.push(entry);
  }
  return roots.filter(
    (root, index) =>
      roots.indexOf(root) === index &&
      !roots.some(
        (parent, parentIndex) =>
          parentIndex !== index && root.startsWith(`${parent.replace(/\/$/u, '')}/`),
      ),
  );
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function terminate(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const forced = setTimeout(() => child.kill('SIGKILL'), 1_000);
  forced.unref();
  child.once('close', () => clearTimeout(forced));
}

function appendBounded(chunks: Buffer[], bytes: number, chunk: Buffer, limit: number): number {
  if (bytes >= limit) return bytes;
  const remaining = limit - bytes;
  chunks.push(chunk.subarray(0, remaining));
  return bytes + Math.min(chunk.byteLength, remaining);
}

function workerExitMessage(
  code: number | null,
  signal: NodeJS.Signals | null,
  stdout: readonly Buffer[],
  stderr: readonly Buffer[],
): string {
  const diagnostic = Buffer.concat([...stderr, ...stdout])
    .toString('utf8')
    .trim();
  const suffix = diagnostic ? `: ${diagnostic}` : '';
  return `Tool package worker exited without a result (code=${String(code)}, signal=${String(signal)})${suffix}`;
}

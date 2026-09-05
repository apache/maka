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

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { lstat, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import {
  client,
  ndJsonStream,
  type ClientApp,
  type ClientConnection,
  type ClientContext,
} from '@agentclientprotocol/sdk';
import type { ThinkingLevel } from '@maka/core/model-thinking';
import {
  startExecutionRuntimeHostService,
  type RuntimeHostKernel,
} from '@maka/runtime-host/server';
import { openInteractiveRuntimePolicyStoresForWrite } from '@maka/storage/runtime-policy-stores';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import { STORAGE_ROOT_MARKER_FILE } from '@maka/storage/root-authority';
import { deriveMakaDataRoots, resolveMakaClientDataRoot } from '../workspace-root.js';

const DEFAULT_TIMEOUT_MS = 15_000;

export interface AcpChildProcessHarnessOptions {
  readonly timeoutMs?: number;
  readonly startRuntimeHost?: boolean;
  readonly model?: {
    readonly id: string;
    readonly thinkingLevels: readonly ThinkingLevel[];
    readonly baseUrl?: string;
  };
}

export interface AcpChildProcessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface AcpChildProcessClient {
  readonly context: ClientContext;
  readonly connection: ClientConnection;
}

export type ConfigureAcpClient = (app: ClientApp) => ClientApp;

/**
 * An isolated, real ACP process boundary. Follow-up protocol tests can opt into
 * a real in-process Runtime Host without allowing the child to spawn one.
 */
export class AcpChildProcessHarness {
  readonly #root: string;
  readonly #workspaceRoot: string;
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #host: RuntimeHostKernel | undefined;
  readonly #stdout: StdoutCaptureBridge;
  readonly #stderr: Buffer[] = [];
  readonly #exit: Promise<AcpChildProcessExit>;
  readonly #spawn: Promise<void>;
  readonly #timeoutMs: number;
  #connection: ClientConnection | undefined;
  #clientOpened = false;
  #stdinClosed = false;
  #closePromise: Promise<void> | undefined;

  constructor(input: {
    root: string;
    workspaceRoot: string;
    child: ChildProcessWithoutNullStreams;
    host?: RuntimeHostKernel;
    stdoutTap: PassThrough;
    timeoutMs: number;
  }) {
    this.#root = input.root;
    this.#workspaceRoot = input.workspaceRoot;
    this.#child = input.child;
    this.#host = input.host;
    this.#stdout = new StdoutCaptureBridge(input.stdoutTap);
    this.#timeoutMs = input.timeoutMs;
    this.#child.stderr.on('data', (chunk: Buffer) => this.#stderr.push(Buffer.from(chunk)));
    this.#spawn = waitForChildSpawn(this.#child);
    this.#exit = new Promise<AcpChildProcessExit>((resolve, reject) => {
      const onError = (error: Error) => {
        this.#child.off('close', onClose);
        reject(error);
      };
      const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
        this.#child.off('error', onError);
        resolve({ code, signal });
      };
      this.#child.once('error', onError);
      this.#child.once('close', onClose);
    });
    void this.#exit.catch(() => undefined);
  }

  get workspaceRoot(): string {
    return this.#workspaceRoot;
  }

  get stdout(): string {
    return this.#stdout.text;
  }

  get stderr(): string {
    return Buffer.concat(this.#stderr).toString('utf8');
  }

  async hasRuntimeHostRootMarker(): Promise<boolean> {
    try {
      await lstat(join(this.#workspaceRoot, STORAGE_ROOT_MARKER_FILE));
      return true;
    } catch (error) {
      if (isErrorWithCode(error, 'ENOENT')) return false;
      throw error;
    }
  }

  async withClient<T>(
    operation: (client: AcpChildProcessClient) => Promise<T> | T,
    configureClient: ConfigureAcpClient = (app) => app,
  ): Promise<T> {
    if (this.#clientOpened)
      throw new Error('ACP child-process harness supports one client connection');
    this.#clientOpened = true;
    const app = configureClient(client({ name: 'maka-acp-child-process-test' }));
    const stream = ndJsonStream(
      Writable.toWeb(this.#child.stdin) as WritableStream<Uint8Array>,
      this.#stdout.protocolInput(),
    );
    const connection = app.connect(stream);
    this.#connection = connection;
    let operationFailed = false;
    try {
      return await this.withTimeout(
        operation({ context: connection.agent, connection }),
        'ACP client operation',
      );
    } catch (error) {
      operationFailed = true;
      throw error;
    } finally {
      try {
        connection.close();
        await this.withTimeout(connection.closed, 'ACP client connection close');
      } catch (error) {
        if (!operationFailed) throw error;
      } finally {
        this.#connection = undefined;
      }
    }
  }

  async closeStdin(): Promise<void> {
    if (this.#stdinClosed || this.#child.stdin.destroyed) return;
    this.#stdinClosed = true;
    const finished = waitForWritableFinish(this.#child.stdin);
    this.#child.stdin.end();
    await this.withTimeout(finished, 'ACP child stdin EOF');
  }

  async waitForExit(): Promise<AcpChildProcessExit> {
    return this.withTimeout(this.#exit, 'ACP child process exit');
  }

  async waitForSpawn(): Promise<void> {
    try {
      await this.withTimeout(this.#spawn, 'ACP child process spawn');
    } catch (error) {
      throw new Error(
        `ACP child process failed to start: ${errorMessage(error)}\n${this.diagnostics}`,
      );
    }
  }

  close(): Promise<void> {
    this.#closePromise ??= this.closeOnce();
    return this.#closePromise;
  }

  private async closeOnce(): Promise<void> {
    let failure: unknown;
    for (const cleanup of [
      () => this.closeConnection(),
      () => this.stopChild(),
      () => this.#host?.close(),
    ]) {
      try {
        await cleanup();
      } catch (error) {
        failure ??= error;
      }
    }
    await rm(this.#root, { recursive: true, force: true });
    if (failure !== undefined) throw failure;
  }

  private async closeConnection(): Promise<void> {
    if (!this.#connection) return;
    this.#connection.close();
    await this.withTimeout(this.#connection.closed, 'ACP client connection close during teardown');
    this.#connection = undefined;
  }

  private async stopChild(): Promise<void> {
    let failure: unknown;
    try {
      await this.closeStdin();
    } catch (error) {
      failure = error;
    }
    try {
      await this.waitForExit();
    } catch (error) {
      failure ??= error;
      if (this.#child.exitCode === null && this.#child.signalCode === null)
        this.#child.kill('SIGTERM');
      try {
        await this.withTimeout(this.#exit, 'ACP child process SIGTERM exit');
      } catch (terminationError) {
        failure ??= terminationError;
        if (this.#child.exitCode === null && this.#child.signalCode === null)
          this.#child.kill('SIGKILL');
        try {
          await this.withTimeout(this.#exit, 'ACP child process SIGKILL exit');
        } catch (killError) {
          failure ??= killError;
        }
      }
    }
    if (failure !== undefined) throw failure;
  }

  private async withTimeout<T>(promise: Promise<T> | T, label: string): Promise<T> {
    return withTimeout(promise, this.#timeoutMs, () => this.timeoutError(label));
  }

  private timeoutError(label: string): Error {
    return new Error(`${label} timed out after ${this.#timeoutMs}ms; ${this.diagnostics}`);
  }

  private get diagnostics(): string {
    return (
      `exitCode=${this.#child.exitCode ?? 'null'} signal=${this.#child.signalCode ?? 'null'}\n` +
      `stdout:\n${this.stdout}\nstderr:\n${this.stderr}`
    );
  }
}

export async function startAcpChildProcessHarness(
  options: AcpChildProcessHarnessOptions = {},
): Promise<AcpChildProcessHarness> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const root = await mkdtemp(join(tmpdir(), 'maka-acp-child-process-'));
  const home = join(root, 'home');
  const applicationData = join(root, 'application-data');
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: applicationData,
    XDG_CONFIG_HOME: applicationData,
    XDG_DATA_HOME: join(root, 'xdg-data'),
    XDG_STATE_HOME: join(root, 'xdg-state'),
    XDG_CACHE_HOME: join(root, 'xdg-cache'),
  };
  const clientDataRoot = resolveMakaClientDataRoot({
    env,
    homeDir: home,
    profileName: 'Maka Dev',
  });
  const dataRoots = deriveMakaDataRoots(clientDataRoot);
  const workspaceRoot = dataRoots.workspaceRoot;
  let host: RuntimeHostKernel | undefined;
  let hostStartup: Promise<RuntimeHostKernel> | undefined;
  let harness: AcpChildProcessHarness | undefined;
  let rootCleanupFollowsHostStartup = false;
  try {
    await mkdir(workspaceRoot, { recursive: true });
    if (options.model) await seedModelConnection(workspaceRoot, options.model);
    if (options.startRuntimeHost) {
      hostStartup = startExecutionRuntimeHostService({ rootPath: workspaceRoot });
      try {
        host = await withStartupTimeout(
          hostStartup,
          timeoutMs,
          'Runtime Host startup',
          workspaceRoot,
        );
      } catch (error) {
        if (error instanceof StartupTimeoutError) {
          rootCleanupFollowsHostStartup = true;
          void hostStartup
            .then(
              async (lateHost) => {
                await lateHost.close().catch(() => undefined);
              },
              () => undefined,
            )
            .then(() => rm(root, { recursive: true, force: true }).catch(() => undefined))
            .catch(() => undefined);
        }
        throw error;
      }
    }
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL('../dev-cli.js', import.meta.url)), '--acp'],
      { cwd: workspaceRoot, env, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const stdoutTap = new PassThrough();
    pipeCapturedStdout(child.stdout, stdoutTap);
    harness = new AcpChildProcessHarness({
      root,
      workspaceRoot,
      child,
      ...(host ? { host } : {}),
      stdoutTap,
      timeoutMs,
    });
    await harness.waitForSpawn();
    return harness;
  } catch (error) {
    await harness?.close().catch(() => undefined);
    await host?.close().catch(() => undefined);
    if (!rootCleanupFollowsHostStartup) await rm(root, { recursive: true, force: true });
    throw new Error(
      `ACP child-process harness startup failed; root=${workspaceRoot}: ${errorMessage(error)}`,
    );
  }
}

async function seedModelConnection(
  rootPath: string,
  model: NonNullable<AcpChildProcessHarnessOptions['model']>,
): Promise<void> {
  const capability = await resolveStorageRoot({ path: rootPath, kind: 'interactive' });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  if (!owner) throw new Error('Unable to acquire ACP model fixture root');
  try {
    const policy = await openInteractiveRuntimePolicyStoresForWrite(owner.lease);
    const created = await policy.connectionCatalog.create({
      expectedCatalogRevision: 0,
      connection: {
        slug: 'acp-fixture-model',
        name: 'ACP fixture model',
        providerType: 'openai-compatible',
        baseUrl: model.baseUrl ?? 'https://acp-model.invalid/v1',
        enabled: true,
        enabledModelIds: [model.id],
        relayModelProfiles: {
          [model.id]: { thinkingLevels: model.thinkingLevels },
        },
      },
    });
    if (created.kind !== 'committed') throw new Error('ACP model fixture did not commit');
    const connection = created.snapshot.connections[0];
    if (!connection) throw new Error('ACP model fixture connection was not persisted');
    const credential = await policy.credentialVault.set({
      locator: {
        scope: 'connection',
        connectionId: connection.connectionId,
        kind: 'api_key',
      },
      expected: null,
      secret: 'acp-fixture-key',
    });
    if (credential.kind !== 'committed') throw new Error('ACP model fixture key did not commit');
    const defaulted = await policy.connectionCatalog.setDefaultTarget({
      expectedCatalogRevision: created.snapshot.revision,
      target: { connectionId: connection.connectionId, modelId: model.id },
    });
    if (defaulted.kind !== 'committed') throw new Error('ACP model fixture was not selected');
  } finally {
    await owner.close();
  }
}

export async function withAcpChildProcessHarness<T>(
  operation: (harness: AcpChildProcessHarness) => Promise<T> | T,
  options: AcpChildProcessHarnessOptions = {},
): Promise<T> {
  const harness = await startAcpChildProcessHarness(options);
  let operationFailed = false;
  try {
    return await operation(harness);
  } catch (error) {
    operationFailed = true;
    throw error;
  } finally {
    try {
      await harness.close();
    } catch (error) {
      if (!operationFailed) throw error;
    }
  }
}

export class StdoutCaptureBridge {
  readonly #chunks: Buffer[] = [];
  #controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  #ended = false;
  #error: Error | undefined;
  #protocolInputCreated = false;

  constructor(stream: Readable) {
    stream.on('data', (chunk: Buffer) => {
      const captured = Buffer.from(chunk);
      this.#chunks.push(captured);
      this.#controller?.enqueue(new Uint8Array(captured));
    });
    stream.once('end', () => {
      this.#ended = true;
      this.#controller?.close();
      this.#controller = undefined;
    });
    stream.once('error', (error: Error) => {
      this.#error = error;
      this.#flushTerminalError();
    });
    stream.resume();
  }

  get text(): string {
    return Buffer.concat(this.#chunks).toString('utf8');
  }

  get snapshot(): readonly Uint8Array[] {
    return this.#chunks.map((chunk) => new Uint8Array(chunk));
  }

  get ended(): boolean {
    return this.#ended;
  }

  get error(): Error | undefined {
    return this.#error;
  }

  protocolInput(): ReadableStream<Uint8Array> {
    if (this.#protocolInputCreated)
      throw new Error('ACP stdout capture supports one protocol reader');
    this.#protocolInputCreated = true;
    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        for (const chunk of this.#chunks) controller.enqueue(new Uint8Array(chunk));
        if (this.#ended) {
          controller.close();
        } else {
          this.#controller = controller;
          this.#flushTerminalError();
        }
      },
      pull: () => {
        this.#flushTerminalError();
      },
      cancel: () => {
        this.#controller = undefined;
      },
    });
  }

  #flushTerminalError(): void {
    if (
      this.#error &&
      this.#controller &&
      (this.#controller.desiredSize === null || this.#controller.desiredSize > 0)
    ) {
      this.#controller.error(this.#error);
      this.#controller = undefined;
    }
  }
}

export function pipeCapturedStdout(source: Readable, destination: PassThrough): void {
  source.once('error', (error: Error) => destination.destroy(error));
  source.pipe(destination);
}

function waitForWritableFinish(stream: Writable): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      stream.off('finish', onFinish);
      stream.off('error', onError);
    };
    const onFinish = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    stream.once('finish', onFinish);
    stream.once('error', onError);
  });
}

function waitForChildSpawn(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      child.off('spawn', onSpawn);
      child.off('error', onError);
      child.off('close', onClose);
    };
    const onSpawn = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(
        new Error(
          `ACP child exited before spawn: code=${code ?? 'null'} signal=${signal ?? 'null'}`,
        ),
      );
    };
    child.once('spawn', onSpawn);
    child.once('error', onError);
    child.once('close', onClose);
  });
}

async function withStartupTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
  workspaceRoot: string,
): Promise<T> {
  return withTimeout(
    promise,
    timeoutMs,
    () => new StartupTimeoutError(`${label} timed out after ${timeoutMs}ms; root=${workspaceRoot}`),
  );
}

async function withTimeout<T>(
  promise: Promise<T> | T,
  timeoutMs: number,
  createTimeoutError: () => Error,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(createTimeoutError()), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

class StartupTimeoutError extends Error {}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isErrorWithCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

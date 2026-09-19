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
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import {
  client,
  methods,
  ndJsonStream,
  type ClientApp,
  type ClientConnection,
  type RequestPermissionRequest,
  type SessionConfigOption,
  type SessionUpdate,
  type ToolCall,
  type ToolCallContent,
  type ToolCallUpdate,
} from '@agentclientprotocol/sdk';
import type { PluginStorageService } from '@maka/runtime/plugin-data-services';
import type {
  PluginExecutorContext,
  PluginExecutorProvider,
  PluginExecutorRequest,
  PluginExecutorResult,
  PluginExecutorToolResultContent,
} from '@maka/runtime/plugin-executor-service';
import type { Context, Disposable } from '@maka/runtime/plugin-kernel';
import { terminateChildProcessTree } from '@maka/runtime/process-tree-terminator';

declare module '@maka/runtime/plugin-kernel' {
  interface Context {
    readonly acp: AcpRuntimeService;
  }
}

const CANCEL_TIMEOUT_MS = 15_000;
const INITIALIZE_TIMEOUT_MS = 30_000;
const PROCESS_EXIT_TIMEOUT_MS = 2_000;
const MAX_TEXT_FILE_BYTES = 8 * 1024 * 1024;
const MAX_EVENT_TEXT = 8_192;
const MAX_TOOL_RESULT_DIFF = 1024 * 1024;

export interface AcpLaunchSpec {
  readonly executable: string;
  readonly args?: readonly string[];
  /** Sidecar binaries the adapter requires before the ACP process may start. */
  readonly requiredExecutables?: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly initialConfig?: Readonly<Record<string, string>>;
}

export interface AcpConfiguredAgent {
  readonly launch: AcpLaunchSpec;
  readonly supportsAttachments?: boolean;
}

/** Product-specific code ends at this interface. */
export interface AcpAgentAdapter<TConfig = unknown> {
  readonly id: string;
  readonly displayName: string;
  readonly clientName?: string;
  configure(config: TConfig): AcpConfiguredAgent;
}

export interface AcpConnectionFactoryInput extends AcpLaunchSpec {
  readonly clientName: string;
  readonly executable: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly configureClient: (app: ClientApp) => void;
}

export interface AcpConnectionOwner {
  readonly connection: ClientConnection;
  readonly failed: Promise<never>;
  dispose(): Promise<void>;
}

export type AcpConnectionFactory = (input: AcpConnectionFactoryInput) => AcpConnectionOwner;

export interface AcpConversationStateStore {
  has(conversationKey: string, cwd: string): Promise<boolean>;
  mark(conversationKey: string, cwd: string): Promise<void>;
}

interface ActivePrompt {
  readonly context: PluginExecutorContext;
  readonly tools: Map<string, ToolSnapshot>;
  text: string;
}

interface ToolSnapshot {
  readonly id: string;
  title: string;
  name?: string;
  kind?: ToolCall['kind'];
  status?: ToolCall['status'];
  content: ToolCallContent[];
  rawInput?: unknown;
  rawOutput?: unknown;
  started: boolean;
  terminal: boolean;
}

interface RetainedSession {
  readonly conversationKey: string;
  readonly cwd: string;
  owner?: AcpConnectionOwner;
  connection?: ClientConnection;
  acpSessionId?: string;
  configOptions: readonly SessionConfigOption[];
  initialization?: Promise<void>;
  active?: ActivePrompt;
  lost: boolean;
  loss?: Promise<void>;
}

export class AcpExecutor implements PluginExecutorProvider {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities = Object.freeze({ thinking: true, toolActivity: true });
  readonly #adapter: AcpAgentAdapter;
  readonly #configured: AcpConfiguredAgent;
  readonly #createConnection: AcpConnectionFactory;
  readonly #state?: AcpConversationStateStore;
  readonly #sessions = new Map<string, RetainedSession>();
  #disposed = false;

  constructor(
    adapter: AcpAgentAdapter,
    config: unknown,
    options: {
      readonly createConnection?: AcpConnectionFactory;
      readonly state?: AcpConversationStateStore;
    } = {},
  ) {
    this.#adapter = validateAdapter(adapter);
    this.id = adapter.id;
    this.displayName = adapter.displayName;
    this.#configured = validateConfiguredAgent(adapter.configure(config));
    this.#createConnection = options.createConnection ?? createAcpConnection;
    this.#state = options.state;
  }

  async execute(
    request: Readonly<PluginExecutorRequest>,
    context: PluginExecutorContext,
  ): Promise<PluginExecutorResult> {
    if (this.#disposed) return failure('ACP executor is unavailable', 'acp_unavailable');
    if (request.attachments?.length && !this.#configured.supportsAttachments) {
      return failure(
        `${this.displayName} ACP supports project files and text only`,
        'acp_attachments_unsupported',
      );
    }
    let session: RetainedSession;
    try {
      session = this.#session(request);
    } catch (error) {
      return failure(safeErrorMessage(error), errorCode(error));
    }
    if (session.active) return failure(`${this.displayName} ACP Session is busy`, 'acp_busy', true);
    const active: ActivePrompt = { context, tools: new Map(), text: '' };
    session.active = active;
    try {
      await this.#ensureInitialized(session, context.signal);
      context.signal.throwIfAborted();
      const prompt = session.connection!.agent.request(methods.agent.session.prompt, {
        sessionId: session.acpSessionId!,
        prompt: [{ type: 'text', text: promptText(request) }],
      });
      const response = await this.#awaitPrompt(session, prompt, context.signal);
      if (!response) return { status: 'cancelled', reason: 'timeout' };
      if (response === 'cancelled' || response.stopReason === 'cancelled') {
        return { status: 'cancelled' };
      }
      if (active.text.trimStart().startsWith('Agent execution error:')) {
        return failure(`${this.displayName} reported an execution failure`, 'acp_prompt_failed');
      }
      if (response.stopReason !== 'end_turn') {
        return failure(
          `${this.displayName} stopped before completing (${response.stopReason})`,
          'acp_prompt_incomplete',
        );
      }
      return { status: 'completed', text: active.text };
    } catch (error) {
      if (context.signal.aborted) {
        await this.#lose(session);
        return { status: 'cancelled' };
      }
      await this.#lose(session);
      return failure(safeErrorMessage(error), errorCode(error));
    } finally {
      if (session.active === active) session.active = undefined;
    }
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    const sessions = [...this.#sessions.values()];
    this.#sessions.clear();
    const settlements = await Promise.allSettled(
      sessions.map((session) => session.loss ?? this.#disposeSession(session)),
    );
    const failures = settlements.flatMap((settlement) =>
      settlement.status === 'rejected' ? [settlement.reason] : [],
    );
    if (failures.length) throw new AggregateError(failures, 'ACP process cleanup failed');
  }

  #session(request: Readonly<PluginExecutorRequest>): RetainedSession {
    const cwd = resolve(request.cwd);
    const existing = this.#sessions.get(request.conversationKey);
    if (existing) {
      if (existing.cwd !== cwd)
        throw new AcpRuntimeError('ACP conversation cannot change workspace', 'acp_cwd_changed');
      if (existing.lost)
        throw new AcpRuntimeError(
          'ACP conversation is history-only because its external process was lost',
          'acp_history_only',
        );
      return existing;
    }
    const created: RetainedSession = {
      conversationKey: request.conversationKey,
      cwd,
      configOptions: [],
      lost: false,
    };
    this.#sessions.set(request.conversationKey, created);
    return created;
  }

  async #ensureInitialized(session: RetainedSession, signal: AbortSignal): Promise<void> {
    if (session.initialization) return await session.initialization;
    const initialization = this.#initialize(session, signal);
    session.initialization = initialization;
    try {
      await initialization;
    } catch (error) {
      session.initialization = undefined;
      throw error;
    }
  }

  async #initialize(session: RetainedSession, signal: AbortSignal): Promise<void> {
    if (await this.#state?.has(session.conversationKey, session.cwd)) {
      throw new AcpRuntimeError(
        'ACP conversation is history-only after the Plugin or Host was restarted',
        'acp_history_only',
      );
    }
    const timeout = AbortSignal.timeout(INITIALIZE_TIMEOUT_MS);
    const startupSignal = AbortSignal.any([signal, timeout]);
    startupSignal.throwIfAborted();
    const launch = this.#configured.launch;
    const executable = await checkedExecutable(launch.executable);
    await Promise.all((launch.requiredExecutables ?? []).map(checkedExecutable));
    const owner = this.#createConnection({
      ...launch,
      executable,
      args: launch.args ?? [],
      cwd: launch.cwd ?? dirname(executable),
      env: launch.env ?? process.env,
      clientName: this.#adapter.clientName ?? `maka-${this.id}`,
      configureClient: (app) => this.#configureClient(session, app),
    });
    session.owner = owner;
    session.connection = owner.connection;
    void owner.failed.catch(() => this.#lose(session)).catch(() => undefined);
    const initialized = await Promise.race([
      owner.connection.agent.request(
        methods.agent.initialize,
        {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: true, writeTextFile: true },
            terminal: false,
          },
        },
        { cancellationSignal: startupSignal },
      ),
      owner.failed,
    ]);
    if (initialized.protocolVersion !== 1) throw new Error('Unsupported ACP protocol version');
    const created = await Promise.race([
      owner.connection.agent.request(
        methods.agent.session.new,
        { cwd: session.cwd, mcpServers: [] },
        { cancellationSignal: startupSignal },
      ),
      owner.failed,
    ]);
    session.acpSessionId = created.sessionId;
    session.configOptions = created.configOptions ?? [];
    await this.#applyInitialConfig(session, launch.initialConfig ?? {}, startupSignal);
    await this.#state?.mark(session.conversationKey, session.cwd);
  }

  async #applyInitialConfig(
    session: RetainedSession,
    values: Readonly<Record<string, string>>,
    signal: AbortSignal,
  ): Promise<void> {
    for (const [key, value] of Object.entries(values)) {
      const option = session.configOptions.find(
        (candidate) =>
          candidate.type === 'select' && (candidate.id === key || candidate.category === key),
      );
      if (!option || option.type !== 'select')
        throw new AcpRuntimeError(
          `ACP configuration is unavailable: ${key}`,
          'acp_config_unavailable',
        );
      const options = option.options.flatMap((entry) =>
        'options' in entry ? entry.options : [entry],
      );
      if (!options.some((entry) => entry.value === value))
        throw new AcpRuntimeError(
          `ACP configuration value is unavailable: ${key}`,
          'acp_config_invalid',
        );
      if (option.currentValue === value) continue;
      const updated = await session.connection!.agent.request(
        methods.agent.session.setConfigOption,
        { sessionId: session.acpSessionId!, configId: option.id, value },
        { cancellationSignal: signal },
      );
      session.configOptions = updated.configOptions;
    }
  }

  #configureClient(session: RetainedSession, app: ClientApp): void {
    app
      .onNotification(methods.client.session.update, ({ params }) => {
        if (params.sessionId === session.acpSessionId) this.#acceptUpdate(session, params.update);
      })
      .onRequest(methods.client.fs.readTextFile, async ({ params }) => {
        this.#assertSession(session, params.sessionId);
        const path = await checkedWorkspacePath(session.cwd, params.path, false);
        const info = await stat(path);
        if (info.size > MAX_TEXT_FILE_BYTES) throw new Error('ACP text file is too large');
        const text = await readFile(path, 'utf8');
        const start = params.line ? params.line - 1 : 0;
        return {
          content:
            params.line || params.limit
              ? text
                  .split('\n')
                  .slice(start, params.limit ? start + params.limit : undefined)
                  .join('\n')
              : text,
        };
      })
      .onRequest(methods.client.fs.writeTextFile, async ({ params }) => {
        this.#assertSession(session, params.sessionId);
        if (Buffer.byteLength(params.content) > MAX_TEXT_FILE_BYTES)
          throw new Error('ACP text file is too large');
        const path = await checkedWorkspacePath(session.cwd, params.path, true);
        await writeFile(path, params.content, 'utf8');
        return {};
      })
      .onRequest(methods.client.session.requestPermission, ({ params }) =>
        this.#requestPermission(session, params),
      );
  }

  async #requestPermission(session: RetainedSession, request: RequestPermissionRequest) {
    this.#assertSession(session, request.sessionId);
    const active = session.active;
    if (!active) return { outcome: { outcome: 'cancelled' as const } };
    const outcome = await active.context.requestPermission({
      toolCallId: request.toolCall.toolCallId,
      title: request.toolCall.title || `${this.displayName} requests permission`,
      options: request.options.map((option) => ({ optionId: option.optionId, name: option.name })),
    });
    return { outcome };
  }

  #acceptUpdate(session: RetainedSession, update: SessionUpdate): void {
    const active = session.active;
    if (!active) return;
    if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
      active.text += update.content.text;
      emitText(active.context, 'output_delta', update.content.text);
      return;
    }
    if (update.sessionUpdate === 'agent_thought_chunk' && update.content.type === 'text') {
      emitText(active.context, 'thinking_delta', update.content.text);
      return;
    }
    if (update.sessionUpdate === 'tool_call') this.#acceptTool(active, update, false);
    if (update.sessionUpdate === 'tool_call_update') this.#acceptTool(active, update, true);
  }

  #acceptTool(active: ActivePrompt, update: ToolCall | ToolCallUpdate, partial: boolean): void {
    const snapshot = active.tools.get(update.toolCallId) ?? {
      id: update.toolCallId,
      title: 'External tool',
      content: [],
      started: false,
      terminal: false,
    };
    if ('title' in update && update.title != null) snapshot.title = update.title;
    if (update.name != null) snapshot.name = update.name;
    if (update.kind != null) snapshot.kind = update.kind;
    if (update.status != null) snapshot.status = update.status;
    if (update.content != null) snapshot.content = [...update.content];
    if (update.rawInput !== undefined) snapshot.rawInput = update.rawInput;
    if (update.rawOutput !== undefined) snapshot.rawOutput = update.rawOutput;
    active.tools.set(snapshot.id, snapshot);
    if (!snapshot.started) {
      snapshot.started = true;
      active.context.emit({
        type: 'tool_start',
        toolCallId: snapshot.id,
        name: snapshot.name ?? snapshot.kind ?? 'external_tool',
        displayName: snapshot.title,
        input: snapshot.rawInput ?? {},
        activityKind: activityKind(snapshot.kind),
      });
    }
    if (partial && snapshot.status !== 'completed' && snapshot.status !== 'failed') {
      emitText(
        active.context,
        'tool_progress',
        summarizeToolContent(snapshot.content),
        snapshot.id,
      );
    }
    if (!snapshot.terminal && (snapshot.status === 'completed' || snapshot.status === 'failed')) {
      snapshot.terminal = true;
      active.context.emit({
        type: 'tool_result',
        toolCallId: snapshot.id,
        content: projectToolResult(snapshot.content, snapshot.rawOutput),
        ...(snapshot.status === 'failed' ? { isError: true } : {}),
      });
    }
  }

  async #awaitPrompt<T>(
    session: RetainedSession,
    prompt: Promise<T>,
    signal: AbortSignal,
  ): Promise<T | 'cancelled' | undefined> {
    const running = Promise.race([prompt, session.owner!.failed]);
    if (!signal.aborted) {
      let onAbort!: () => void;
      const aborted = new Promise<void>((resolveAbort) => {
        onAbort = resolveAbort;
        signal.addEventListener('abort', onAbort, { once: true });
      });
      try {
        await Promise.race([running.then(() => undefined), aborted]);
      } finally {
        signal.removeEventListener('abort', onAbort);
      }
    }
    if (!signal.aborted) return await running;
    await session.connection?.agent
      .notify(methods.agent.session.cancel, { sessionId: session.acpSessionId! })
      .catch(() => undefined);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const completed = await Promise.race([
      running.then(
        () => true,
        () => true,
      ),
      new Promise<false>((resolveTimeout) => {
        timeout = setTimeout(() => resolveTimeout(false), CANCEL_TIMEOUT_MS);
      }),
    ]).finally(() => clearTimeout(timeout));
    if (!completed) await this.#lose(session);
    return completed ? 'cancelled' : undefined;
  }

  #assertSession(session: RetainedSession, sessionId: string): void {
    if (!session.acpSessionId || session.acpSessionId !== sessionId)
      throw new Error('Unknown ACP Session');
  }

  async #lose(session: RetainedSession): Promise<void> {
    if (!session.loss) {
      session.lost = true;
      session.loss = this.#disposeSession(session);
    }
    await session.loss;
  }

  async #disposeSession(session: RetainedSession): Promise<void> {
    const owner = session.owner;
    session.owner = undefined;
    session.connection = undefined;
    if (owner) await owner.dispose();
  }
}

/**
 * Shared ACP registration surface.
 *
 * Installed Plugin packages are self-contained bundles, so this class must not
 * rely on `instanceof Service` across package generations. The adapter passes
 * its own Context explicitly; that preserves the child Entry identity used by
 * PluginExecutorService even when the ACP runtime was loaded from another
 * immutable package generation.
 */
export class AcpRuntimeService {
  constructor(ctx: Context) {
    ctx.provide('acp', this);
  }

  register<TConfig>(
    consumer: Context,
    adapter: AcpAgentAdapter<TConfig>,
    config: TConfig,
  ): Disposable<Promise<void>> {
    const storage = consumer.get<PluginStorageService>('storage');
    const provider = new AcpExecutor(adapter as AcpAgentAdapter, config, {
      ...(storage ? { state: pluginStateStore(storage, adapter.id) } : {}),
    });
    consumer.effect(() => () => provider.dispose(), `acp.dispose(${JSON.stringify(adapter.id)})`);
    return consumer.executors.register(provider);
  }
}

export function createAcpConnection(input: AcpConnectionFactoryInput): AcpConnectionOwner {
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(input.executable, [...(input.args ?? [])], {
      cwd: input.cwd,
      env: input.env,
      stdio: 'pipe',
      detached: true,
      shell: false,
    });
  } catch {
    throw new AcpRuntimeError('ACP executable is unavailable', 'acp_executable_unavailable');
  }
  let disposing = false;
  let disposed = false;
  let disposal: Promise<void> | undefined;
  let rejectFailure!: (error: Error) => void;
  const failed = new Promise<never>((_resolve, reject) => {
    rejectFailure = reject;
  });
  void failed.catch(() => undefined);
  const fail = () => {
    if (!disposing) rejectFailure(new Error('ACP connection failed'));
  };
  child.once('error', fail);
  child.stdin.once('error', fail);
  child.stderr.once('error', fail);
  child.stderr.on('data', () => undefined);
  child.once('close', fail);
  const app = client({ name: input.clientName });
  input.configureClient(app);
  const connection = app.connect(
    ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    ),
  );
  void connection.closed.then(fail, fail);
  return {
    connection,
    failed,
    dispose() {
      if (disposed) return Promise.resolve();
      if (disposal) return disposal;
      disposing = true;
      disposal = terminate(child, connection).then(
        () => {
          disposed = true;
        },
        (error) => {
          disposal = undefined;
          throw error;
        },
      );
      return disposal;
    },
  };
}

async function terminate(
  child: ChildProcessWithoutNullStreams,
  connection: ClientConnection,
): Promise<void> {
  connection.close();
  child.stdin.destroy();
  child.stdout.destroy();
  child.stderr.destroy();
  const alive = () => child.exitCode === null && child.signalCode === null;
  if (!child.pid || !alive()) return;
  await terminateChildProcessTree(child, 'SIGTERM');
  for (let attempt = 0; attempt < 40 && alive(); attempt += 1) await delay(50);
  if (alive()) {
    await terminateChildProcessTree(child, 'SIGKILL');
    for (let elapsed = 0; elapsed < PROCESS_EXIT_TIMEOUT_MS && alive(); elapsed += 50)
      await delay(50);
  }
  if (alive()) throw new Error('ACP process cleanup failed');
}

function pluginStateStore(
  storage: PluginStorageService,
  executorId: string,
): AcpConversationStateStore {
  const key = (conversationKey: string) =>
    `acp/${executorId}/${createHash('sha256').update(conversationKey).digest('hex')}`;
  return {
    async has(conversationKey) {
      const value = (await storage.get<{ version?: unknown; cwd?: unknown }>(key(conversationKey)))
        .value;
      return value?.version === 1;
    },
    async mark(conversationKey, cwd) {
      await storage.set(key(conversationKey), { version: 1, cwd });
    },
  };
}

function validateAdapter<T>(adapter: AcpAgentAdapter<T>): AcpAgentAdapter<T> {
  if (
    !adapter ||
    typeof adapter !== 'object' ||
    typeof adapter.id !== 'string' ||
    !/^[a-z][a-z0-9]*(?:[-_.][a-z0-9]+)*$/u.test(adapter.id) ||
    typeof adapter.displayName !== 'string' ||
    !adapter.displayName.trim() ||
    (adapter.clientName !== undefined &&
      (typeof adapter.clientName !== 'string' || !adapter.clientName.trim())) ||
    typeof adapter.configure !== 'function'
  ) {
    throw new TypeError('Invalid ACP Agent adapter');
  }
  return adapter;
}

function validateConfiguredAgent(value: AcpConfiguredAgent): AcpConfiguredAgent {
  if (!value || typeof value !== 'object' || !value.launch || typeof value.launch !== 'object')
    throw new TypeError('Invalid ACP Agent configuration');
  if (value.launch.args !== undefined && !Array.isArray(value.launch.args))
    throw new TypeError('ACP launch arguments are invalid');
  if (
    value.launch.requiredExecutables !== undefined &&
    !Array.isArray(value.launch.requiredExecutables)
  )
    throw new TypeError('ACP required executables are invalid');
  if (value.supportsAttachments !== undefined && typeof value.supportsAttachments !== 'boolean')
    throw new TypeError('ACP attachment capability is invalid');
  const executable = absolutePath(value.launch.executable, 'executable');
  const args = value.launch.args?.map((argument) => {
    if (typeof argument !== 'string' || /[\0\r\n]/u.test(argument))
      throw new TypeError('ACP launch argument is invalid');
    return argument;
  });
  const requiredExecutables = value.launch.requiredExecutables?.map((path) =>
    absolutePath(path, 'required executable'),
  );
  const cwd = value.launch.cwd === undefined ? undefined : absolutePath(value.launch.cwd, 'cwd');
  const initialConfig = validateInitialConfig(value.launch.initialConfig);
  return Object.freeze({
    launch: Object.freeze({
      ...value.launch,
      executable,
      ...(args ? { args: Object.freeze(args) } : {}),
      ...(requiredExecutables ? { requiredExecutables: Object.freeze(requiredExecutables) } : {}),
      ...(cwd ? { cwd } : {}),
      ...(value.launch.env ? { env: Object.freeze({ ...value.launch.env }) } : {}),
      ...(initialConfig ? { initialConfig } : {}),
    }),
    ...(value.supportsAttachments === undefined
      ? {}
      : { supportsAttachments: value.supportsAttachments === true }),
  });
}

function validateInitialConfig(
  value: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('ACP initial configuration is invalid');
  const entries = Object.entries(value);
  if (
    entries.length > 64 ||
    entries.some(
      ([key, item]) =>
        !/^[a-z][a-z0-9]*(?:[-_.][a-z0-9]+)*$/u.test(key) ||
        typeof item !== 'string' ||
        /[\0\r\n]/u.test(item),
    )
  )
    throw new TypeError('ACP initial configuration is invalid');
  return Object.freeze(Object.fromEntries(entries));
}

function absolutePath(value: unknown, label: string): string {
  if (typeof value !== 'string' || !isAbsolute(value) || /[\0\r\n]/u.test(value))
    throw new TypeError(`ACP ${label} must be an absolute path`);
  return resolve(value);
}

async function checkedExecutable(path: string): Promise<string> {
  const resolved = await realpath(path);
  if (!(await stat(resolved)).isFile()) throw new Error('ACP executable is not a file');
  await access(resolved, constants.X_OK);
  return resolved;
}

async function checkedWorkspacePath(cwd: string, path: string, forWrite: boolean): Promise<string> {
  if (!isAbsolute(path)) throw new Error('ACP file path must be absolute');
  const candidate = resolve(path);
  let resolvedPath: string;
  if (!forWrite) resolvedPath = await realpath(candidate);
  else {
    try {
      resolvedPath = await realpath(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      resolvedPath = resolve(await realpath(dirname(candidate)), basename(candidate));
    }
  }
  const relation = relative(await realpath(cwd), resolvedPath);
  if (relation === '..' || relation.startsWith('../') || isAbsolute(relation))
    throw new Error('ACP file path leaves the workspace');
  if (!forWrite) await access(resolvedPath, constants.R_OK);
  return resolvedPath;
}

function promptText(request: Readonly<PluginExecutorRequest>): string {
  const sections = [request.text];
  if (request.instructions) sections.push(`Agent instructions:\n${request.instructions}`);
  for (const quote of request.quotes ?? []) sections.push(`Quoted context:\n${quote.text}`);
  for (const reference of request.directoryReferences ?? [])
    sections.push(`Project directory reference: ${reference.path}`);
  return sections.filter(Boolean).join('\n\n');
}

function emitText(
  context: PluginExecutorContext,
  type: 'output_delta' | 'thinking_delta' | 'tool_progress',
  text: string,
  toolCallId?: string,
): void {
  const safeText = text.replaceAll('\r', '');
  for (let offset = 0; offset < safeText.length; offset += MAX_EVENT_TEXT) {
    const chunk = safeText.slice(offset, offset + MAX_EVENT_TEXT);
    if (type === 'output_delta' || type === 'thinking_delta') context.emit({ type, text: chunk });
    else context.emit({ type, toolCallId: toolCallId!, text: chunk });
  }
}

function projectToolResult(
  content: readonly ToolCallContent[],
  rawOutput: unknown,
): PluginExecutorToolResultContent {
  const diffs = content.flatMap((item) =>
    item.type === 'diff'
      ? [
          {
            path: item.path,
            diff: createWholeFileDiff(item.path, item.oldText ?? '', item.newText ?? ''),
          },
        ]
      : [],
  );
  const combinedDiff = diffs.map(({ diff }) => diff).join('\n');
  if (diffs.length && combinedDiff.length <= MAX_TOOL_RESULT_DIFF)
    return {
      kind: 'file_diff',
      paths: diffs.map(({ path }) => path),
      diff: combinedDiff,
    };
  if (diffs.length)
    return {
      kind: 'text',
      text: boundedText(
        `${diffs.map(({ path }) => `Updated ${path}`).join('\n')}\nDiff omitted because it exceeds the executor event limit.`,
      ),
    };
  return { kind: 'text', text: boundedText(summarizeToolResult(content, rawOutput)) };
}

function createWholeFileDiff(path: string, oldText: string, newText: string): string {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  return [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
  ].join('\n');
}

function summarizeToolContent(content: readonly ToolCallContent[]): string {
  return content
    .map((item) => {
      if (item.type === 'diff') return `Updated ${item.path}`;
      if (item.type === 'terminal') return item.terminalId ? `Terminal ${item.terminalId}` : '';
      return item.content.type === 'text' ? item.content.text : '';
    })
    .filter(Boolean)
    .join('\n');
}

function summarizeToolResult(content: readonly ToolCallContent[], rawOutput: unknown): string {
  const summary = summarizeToolContent(content);
  if (summary) return summary;
  if (rawOutput === undefined) return '';
  try {
    return JSON.stringify(rawOutput);
  } catch {
    return 'External tool completed';
  }
}

function boundedText(value: string): string {
  const safe = value.replaceAll('\r', '');
  return safe.length <= MAX_EVENT_TEXT ? safe : `${safe.slice(0, MAX_EVENT_TEXT - 1)}…`;
}

function activityKind(kind: ToolCall['kind'] | undefined) {
  if (kind === 'read') return 'read' as const;
  if (kind === 'edit' || kind === 'delete' || kind === 'move') return 'edit' as const;
  if (kind === 'search') return 'search' as const;
  if (kind === 'fetch') return 'webfetch' as const;
  if (kind === 'execute') return 'command' as const;
  if (kind === 'think') return 'explore' as const;
  return 'tool' as const;
}

class AcpRuntimeError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'AcpRuntimeError';
  }
}

function failure(
  message: string,
  code: string,
  recoverable = false,
): Extract<PluginExecutorResult, { status: 'failed' }> {
  return { status: 'failed', message, code, recoverable };
}

function errorCode(error: unknown): string {
  if (error instanceof AcpRuntimeError) return error.code;
  if (error instanceof DOMException && error.name === 'TimeoutError')
    return 'acp_initialize_timed_out';
  return 'acp_execution_failed';
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof AcpRuntimeError) return error.message;
  return 'ACP execution failed';
}

const host = Object.freeze({
  apply(ctx: Context) {
    new AcpRuntimeService(ctx);
  },
});

export default Object.freeze({
  packageId: 'acp-executor',
  contributions: Object.freeze([{ id: 'acp', kind: 'service' }]),
  host,
});

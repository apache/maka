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

import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdtemp, rm, realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { ExecutorCatalogEntry, ExecutorConfiguration } from '@maka/core/executor-catalog';
import { dirname, isAbsolute, resolve } from 'node:path';
import {
  methods,
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
} from '@maka/runtime/plugin-executor-service';
import type { Context, Disposable } from '@maka/runtime/plugin-kernel';
import { AcpRuntimeError } from './acp-errors.js';
import { readWorkspaceTextFile, writeWorkspaceTextFile } from './acp-filesystem.js';
import { createAcpConnection, type AcpConnectionOwner } from './acp-process.js';
import {
  activityKind,
  boundedText,
  emitText,
  emitToolOutput,
  projectToolResult,
  promptText,
  summarizeToolContent,
  toolName,
} from './acp-projection.js';

declare module '@maka/runtime/plugin-kernel' {
  interface Context {
    readonly acp: AcpRuntimeService;
  }
}

const CANCEL_TIMEOUT_MS = 15_000;
const INITIALIZE_TIMEOUT_MS = 30_000;

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
}

/** Product-specific code ends at this interface. */
export interface AcpAgentAdapter<TConfig = unknown> {
  readonly id: string;
  readonly displayName: string;
  readonly clientName?: string;
  configure(config: TConfig): AcpConfiguredAgent;
  permissionKind?(request: RequestPermissionRequest): 'permission' | 'question';
  executionFailed?(text: string): boolean;
  describeModels?(
    models: ExecutorCatalogEntry['models'],
  ): Pick<ExecutorCatalogEntry, 'models' | 'modelGroups'>;
}

export interface AcpConnectionFactoryInput extends AcpLaunchSpec {
  readonly clientName: string;
  readonly executable: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly configureClient: (app: ClientApp) => void;
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
  output: string;
  outputText: string;
  started: boolean;
  terminal: boolean;
}

interface RetainedSession {
  readonly conversationKey: string;
  readonly configuration?: ExecutorConfiguration;
  readonly cwd: string;
  owner?: AcpConnectionOwner;
  connection?: ClientConnection;
  acpSessionId?: string;
  continuityReserved?: boolean;
  configOptions: readonly SessionConfigOption[];
  initialization?: Promise<void>;
  active?: ActivePrompt;
  configuring?: boolean;
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
  #catalog?: ExecutorCatalogEntry;
  #discovery?: Promise<ExecutorCatalogEntry>;

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

  async discover(input: { cwd: string; signal: AbortSignal }): Promise<ExecutorCatalogEntry> {
    if (this.#disposed) return this.#catalogEntry('unavailable');
    if (this.#catalog) return this.#catalog;
    if (this.#discovery) return this.#discovery;
    const probe = async () => {
      // A bounded disposable ACP probe never creates a Maka task or joins the retained-session map.
      const cwd = await mkdtemp(resolve(tmpdir(), 'maka-acp-catalog-'));
      const session: RetainedSession = {
        conversationKey: 'catalog-probe',
        cwd,
        configOptions: [],
        lost: false,
      };
      try {
        await this.#initialize(session, input.signal, true);
        const result = this.#catalogEntry('ready', session.configOptions);
        this.#catalog = result;
        return result;
      } catch (error) {
        return this.#catalogEntry(
          (error as { code?: unknown })?.code === -32000
            ? 'authentication_required'
            : 'unavailable',
        );
      } finally {
        await this.#disposeSession(session);
        await rm(cwd, { recursive: true, force: true });
      }
    };
    this.#discovery = probe().finally(() => {
      this.#discovery = undefined;
    });
    return this.#discovery;
  }

  async inspectConversation(input: {
    conversationKey: string;
    cwd: string;
    configuration?: ExecutorConfiguration;
  }): Promise<ExecutorCatalogEntry> {
    const session = this.#sessions.get(input.conversationKey);
    if (this.#disposed) return this.#catalogEntry('unavailable');
    if (session?.lost || (!session && (await this.#state?.has(input.conversationKey, input.cwd))))
      return this.#catalogEntry('history_only');
    return this.#catalogEntry('ready', session?.configOptions ?? [], input.configuration?.model);
  }

  async configureConversation(
    input: { conversationKey: string; cwd: string; configuration?: ExecutorConfiguration },
    signal: AbortSignal,
  ): Promise<void> {
    const session = this.#sessions.get(input.conversationKey);
    if (
      !session?.connection ||
      session.lost ||
      session.active ||
      session.configuring ||
      !input.configuration?.model
    )
      throw new Error('ACP model change is unavailable');
    session.configuring = true;
    try {
      await this.#applyInitialConfig(session, { model: input.configuration.model }, signal, true);
    } finally {
      session.configuring = false;
    }
  }

  #catalogEntry(
    readiness: ExecutorCatalogEntry['readiness'],
    options: readonly SessionConfigOption[] = [],
    selected?: string,
  ): ExecutorCatalogEntry {
    const model = options.find(
      (option) =>
        option.type === 'select' && (option.category === 'model' || option.id === 'model'),
    );
    const models =
      model?.type === 'select'
        ? model.options
            .flatMap((entry) => ('options' in entry ? entry.options : [entry]))
            .map((entry) => ({ id: entry.value, name: entry.name }))
        : [];
    return {
      id: this.id,
      displayName: this.displayName,
      readiness,
      ...(this.#adapter.describeModels?.(models) ?? { models }),
      ...(model?.type === 'select'
        ? { currentModel: model.currentValue }
        : selected
          ? { currentModel: selected }
          : {}),
      supportsAttachments: false,
      supportsModelChange: model?.type === 'select',
    };
  }

  async execute(
    request: Readonly<PluginExecutorRequest>,
    context: PluginExecutorContext,
  ): Promise<PluginExecutorResult> {
    if (this.#disposed) return failure('ACP executor is unavailable', 'acp_unavailable');
    if (request.attachments?.length) {
      return failure(
        `${this.displayName} ACP supports project files and text only`,
        'acp_attachments_unsupported',
      );
    }
    if (
      request.configuration?.model &&
      request.model &&
      request.model !== this.id &&
      request.configuration.model !== request.model
    )
      return failure('Conflicting executor models', 'acp_config_invalid');
    const model =
      request.configuration?.model ?? (request.model === this.id ? undefined : request.model);
    if (model) request = { ...request, configuration: { model } };
    let session: RetainedSession;
    try {
      session = this.#session(request);
    } catch (error) {
      return failure(safeErrorMessage(error), errorCode(error));
    }
    if (session.active || session.configuring)
      return failure(`${this.displayName} ACP Session is busy`, 'acp_busy', true);
    const active: ActivePrompt = { context, tools: new Map(), text: '' };
    session.active = active;
    try {
      await this.#ensureInitialized(session, context.signal);
      context.signal.throwIfAborted();
      if (request.configuration?.model)
        await this.#applyInitialConfig(
          session,
          { model: request.configuration.model },
          context.signal,
        );
      const prompt = session.connection!.agent.request(methods.agent.session.prompt, {
        sessionId: session.acpSessionId!,
        prompt: [{ type: 'text', text: promptText(request) }],
      });
      const response = await this.#awaitPrompt(session, prompt, context.signal);
      if (!response) return { status: 'cancelled', reason: 'timeout' };
      if (context.signal.aborted || response.stopReason === 'cancelled') {
        return { status: 'cancelled', providerStopReason: response.stopReason };
      }
      if (this.#adapter.executionFailed?.(active.text)) {
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
      await this.#lose(session);
      // Retry only when no session/new was attempted. Once continuity is
      // reserved, a lost response may hide an established Agent Session.
      const retryable =
        !session.acpSessionId &&
        !session.continuityReserved &&
        errorCode(error) !== 'acp_history_only';
      if (retryable && this.#sessions.get(session.conversationKey) === session)
        this.#sessions.delete(session.conversationKey);
      if (context.signal.aborted) {
        if (
          error === context.signal.reason ||
          (error instanceof DOMException && error.name === 'AbortError')
        )
          return { status: 'cancelled' };
        return { status: 'cancelled', reason: 'crash', providerStopReason: errorCode(error) };
      }
      return failure(safeErrorMessage(error), errorCode(error), retryable);
    } finally {
      if (session.active === active) session.active = undefined;
    }
  }

  async disposeConversation(conversationKey: string): Promise<void> {
    const session = this.#sessions.get(conversationKey);
    if (session) await this.#lose(session);
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
      ...(request.configuration ? { configuration: request.configuration } : {}),
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

  async #initialize(session: RetainedSession, signal: AbortSignal, probe = false): Promise<void> {
    if (!probe && (await this.#state?.has(session.conversationKey, session.cwd))) {
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
            fs: { readTextFile: !probe, writeTextFile: !probe },
            terminal: false,
          },
        },
        { cancellationSignal: startupSignal },
      ),
      owner.failed,
    ]);
    if (initialized.protocolVersion !== 1) throw new Error('Unsupported ACP protocol version');
    if (!probe) {
      startupSignal.throwIfAborted();
      // Reserve continuity before asking the Agent to create a Session. A failed
      // or interrupted session/new may still have created one remotely.
      await this.#state?.mark(session.conversationKey, session.cwd);
      session.continuityReserved = true;
    }
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
    if (!probe) {
      await this.#applyInitialConfig(
        session,
        session.configuration?.model
          ? { model: session.configuration.model }
          : (launch.initialConfig ?? {}),
        startupSignal,
      );
    }
  }

  async #applyInitialConfig(
    session: RetainedSession,
    values: Readonly<Record<string, string>>,
    signal: AbortSignal,
    restoreOnFailure = false,
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
      signal.throwIfAborted();
      try {
        const updated = await session.connection!.agent.request(
          methods.agent.session.setConfigOption,
          { sessionId: session.acpSessionId!, configId: option.id, value },
          { cancellationSignal: signal },
        );
        const confirmed = updated.configOptions.find((candidate) => candidate.id === option.id);
        if (confirmed?.type !== 'select' || confirmed.currentValue !== value)
          throw new AcpRuntimeError(
            'Agent did not confirm the selected configuration',
            'acp_config_unconfirmed',
          );
        session.configOptions = updated.configOptions;
      } catch (error) {
        // A rejected/unconfirmed mutation can have reached the Agent. Restore the
        // previous real ID and require an acknowledgement before permitting retry.
        let restored = false;
        if (restoreOnFailure && !session.lost && !signal.aborted) {
          try {
            const rollback = await session.connection!.agent.request(
              methods.agent.session.setConfigOption,
              { sessionId: session.acpSessionId!, configId: option.id, value: option.currentValue },
              { cancellationSignal: AbortSignal.timeout(5_000) },
            );
            const confirmed = rollback.configOptions.find(
              (candidate) => candidate.id === option.id,
            );
            if (
              confirmed?.type === 'select' &&
              confirmed.currentValue === option.currentValue &&
              !session.lost
            ) {
              session.configOptions = rollback.configOptions;
              restored = true;
            }
          } catch {
            /* Uncertain configuration remains history-only. */
          }
        }
        if (!restored) await this.#lose(session);
        throw error;
      }
    }
  }

  #configureClient(session: RetainedSession, app: ClientApp): void {
    app
      .onNotification(methods.client.session.update, ({ params }) => {
        if (params.sessionId === session.acpSessionId) this.#acceptUpdate(session, params.update);
      })
      .onRequest(methods.client.fs.readTextFile, async ({ params }) => {
        this.#assertSession(session, params.sessionId);
        return {
          content: await readWorkspaceTextFile(session.cwd, params.path, params.line, params.limit),
        };
      })
      .onRequest(methods.client.fs.writeTextFile, async ({ params }) => {
        this.#assertSession(session, params.sessionId);
        await writeWorkspaceTextFile(session.cwd, params.path, params.content);
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
      kind: this.#adapter.permissionKind?.(request) ?? 'permission',
      toolCallId: request.toolCall.toolCallId,
      title: request.toolCall.title || `${this.displayName} requests permission`,
      options: request.options.map((option) => ({ optionId: option.optionId, name: option.name })),
    });
    return { outcome };
  }

  #acceptUpdate(session: RetainedSession, update: SessionUpdate): void {
    if (update.sessionUpdate === 'config_option_update') {
      // During our mutation, its response (or rollback response) is authoritative.
      if (!session.configuring && !session.lost) session.configOptions = update.configOptions;
      return;
    }
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
    if (update.sessionUpdate === 'tool_call') this.#acceptTool(active, update);
    if (update.sessionUpdate === 'tool_call_update') this.#acceptTool(active, update);
  }

  #acceptTool(active: ActivePrompt, update: ToolCall | ToolCallUpdate): void {
    const snapshot = active.tools.get(update.toolCallId) ?? {
      id: update.toolCallId,
      title: 'External tool',
      content: [],
      output: '',
      outputText: '',
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
      active.context.emit({
        type: 'tool_start',
        toolCallId: snapshot.id,
        name: toolName(snapshot.name ?? snapshot.kind ?? 'external_tool'),
        displayName: boundedText(snapshot.title),
        input: snapshot.rawInput ?? {},
        activityKind: activityKind(snapshot.kind),
      });
      snapshot.started = true;
    }
    if (snapshot.status !== 'completed' && snapshot.status !== 'failed') {
      const output = summarizeToolContent(snapshot.content);
      if (output.startsWith(snapshot.output) && output.length > snapshot.output.length) {
        emitToolOutput(active.context, snapshot.id, output.slice(snapshot.output.length));
        snapshot.output = output;
        snapshot.outputText = toolTextContent(snapshot.content);
      }
    }
    if (!snapshot.terminal && (snapshot.status === 'completed' || snapshot.status === 'failed')) {
      if (snapshot.content.some((item) => item.type === 'diff')) {
        const text = toolTextContent(snapshot.content);
        const remaining = text.startsWith(snapshot.outputText)
          ? text.slice(snapshot.outputText.length)
          : text;
        if (remaining) emitToolOutput(active.context, snapshot.id, remaining);
      }
      active.context.emit({
        type: 'tool_result',
        toolCallId: snapshot.id,
        content: projectToolResult(snapshot.content, snapshot.rawOutput),
        ...(snapshot.status === 'failed' ? { isError: true } : {}),
      });
      snapshot.terminal = true;
    }
  }

  async #awaitPrompt<T>(
    session: RetainedSession,
    prompt: Promise<T>,
    signal: AbortSignal,
  ): Promise<T | undefined> {
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
    let timeout: ReturnType<typeof setTimeout> | undefined;
    // Cancellation notification and settlement share one deadline; a blocked stdin cannot hang stop.
    const result = await Promise.race([
      (async () => {
        await session.connection?.agent
          .notify(methods.agent.session.cancel, { sessionId: session.acpSessionId! })
          .catch(() => undefined);
        return { response: await running };
      })(),
      new Promise<undefined>((resolveTimeout) => {
        timeout = setTimeout(() => resolveTimeout(undefined), CANCEL_TIMEOUT_MS);
      }),
    ]).finally(() => clearTimeout(timeout));
    if (!result) await this.#lose(session);
    return result?.response;
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

function toolTextContent(content: readonly ToolCallContent[]): string {
  return content
    .flatMap((item) =>
      item.type === 'content' && item.content.type === 'text' ? [item.content.text] : [],
    )
    .join('\n');
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
    if (!storage) throw new Error('ACP continuity storage is unavailable');
    const provider = new AcpExecutor(adapter as AcpAgentAdapter, config, {
      state: pluginStateStore(storage, adapter.id),
    });
    consumer.effect(() => () => provider.dispose(), `acp.dispose(${JSON.stringify(adapter.id)})`);
    return consumer.executors.register(provider);
  }
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

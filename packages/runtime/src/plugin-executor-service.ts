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

import {
  isExecutorConfiguration,
  normalizeCatalogEntry,
  type ExecutorConfiguration,
  type ExecutorCatalogEntry,
} from '@maka/core/executor-catalog';
import { createHash } from 'node:crypto';
import type {
  AttachmentRef,
  DirectoryReference,
  QuoteRef,
  ToolActivityKind,
  ToolOutputStream,
} from '@maka/core/events';
import { TOOL_ACTIVITY_KINDS, TOOL_OUTPUT_STREAMS } from '@maka/core/events';
import type { ThinkingLevel } from '@maka/core/model-thinking';
import { isExecutorId } from '@maka/core/executor-id';
import { Service, type Context, type Disposable } from './plugin-kernel.js';
import {
  MakaPluginRuntimeError,
  pluginIdentity,
  registerPluginContribution,
  type MakaContributionIdentity,
  type MakaPluginRootId,
} from './plugin-runtime.js';
import { PluginScopeRegistry } from './plugin-scope-registry.js';

const MAX_EXECUTOR_COMPLETION_TEXT_BYTES = 256 * 1024;

declare module './plugin-kernel.js' {
  interface Context {
    readonly executors: PluginExecutorService;
  }
}

export interface PluginExecutorRequest {
  readonly sessionId: string;
  readonly turnId: string;
  readonly runId?: string;
  /** Stable key a provider may use to retain its own external conversation. */
  readonly conversationKey: string;
  readonly text: string;
  readonly configuration?: ExecutorConfiguration;
  readonly cwd: string;
  /** Executor-specific model selected for this Session. */
  readonly model?: string;
  /** Executor-specific reasoning depth; null restores the provider default. */
  readonly reasoningEffort?: ThinkingLevel | null;
  /** Child-agent instruction when this request belongs to a linked child Session. */
  readonly instructions?: string;
  readonly attachments?: readonly AttachmentRef[];
  readonly directoryReferences?: readonly DirectoryReference[];
  readonly quotes?: readonly QuoteRef[];
}

/** Optional presentation capabilities. Text output and terminal results are always supported. */
export interface PluginExecutorCapabilities {
  readonly thinking?: boolean;
  readonly toolActivity?: boolean;
}

export type PluginExecutorOutputEvent =
  | { readonly type: 'output_delta'; readonly text: string }
  | { readonly type: 'thinking_delta'; readonly text: string }
  | {
      readonly type: 'tool_start';
      readonly toolCallId: string;
      readonly name: string;
      readonly input?: unknown;
      readonly displayName?: string;
      readonly activityKind?: ToolActivityKind;
    }
  | {
      readonly type: 'tool_output_delta';
      readonly toolCallId: string;
      readonly text: string;
      readonly stream?: ToolOutputStream;
    }
  | { readonly type: 'tool_progress'; readonly toolCallId: string; readonly text: string }
  | {
      readonly type: 'tool_result';
      readonly toolCallId: string;
      readonly content: PluginExecutorToolResultContent;
      readonly isError?: boolean;
    };

/** Durable tool-result shapes that an external executor may publish directly. */
export type PluginExecutorToolResultContent =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'file_diff'; readonly paths: readonly string[]; readonly diff: string };

export type PluginExecutorCancellationSource = 'provider' | 'caller' | 'executor_retired';

export interface PluginExecutorPermissionOption {
  readonly optionId: string;
  readonly name: string;
}

export interface PluginExecutorPermissionRequest {
  /** Questions preserve the same provider option identities and settlement path. */
  readonly kind?: 'permission' | 'question';
  readonly toolCallId: string;
  readonly title: string;
  readonly options: readonly PluginExecutorPermissionOption[];
}

export type PluginExecutorPermissionResult =
  | { readonly outcome: 'cancelled' }
  | { readonly outcome: 'selected'; readonly optionId: string };

export type PluginExecutorResult =
  | { readonly status: 'completed'; readonly text: string }
  | {
      readonly status: 'cancelled';
      readonly reason?: string;
      /** Provider terminal reason observed while cancellation drained. */
      readonly providerStopReason?: string;
      /** Service-owned provenance; provider-supplied values are ignored. */
      readonly source?: PluginExecutorCancellationSource;
    }
  | {
      readonly status: 'failed';
      readonly message: string;
      readonly code?: string;
      readonly recoverable?: boolean;
    };

export interface PluginExecutorContext {
  readonly signal: AbortSignal;
  emit(event: PluginExecutorOutputEvent): void;
  /** Request one provider-defined permission choice through Maka's hosted form authority. */
  requestPermission(
    request: PluginExecutorPermissionRequest,
  ): Promise<PluginExecutorPermissionResult>;
}

/** A black-box executor contributed by one Host plugin. */
export interface PluginExecutorDiscoveryInput {
  readonly cwd: string;
  readonly signal: AbortSignal;
}
export interface PluginExecutorConversationInput {
  readonly conversationKey: string;
  readonly cwd: string;
  readonly configuration?: ExecutorConfiguration;
}

export interface PluginExecutorProvider {
  readonly id: string;
  readonly displayName?: string;
  readonly capabilities?: PluginExecutorCapabilities;
  disposeConversation?(conversationKey: string): Promise<void>;
  discover?(input: PluginExecutorDiscoveryInput): Promise<ExecutorCatalogEntry>;
  configureConversation?(
    input: PluginExecutorConversationInput,
    signal: AbortSignal,
  ): Promise<void>;
  inspectConversation?(input: PluginExecutorConversationInput): Promise<ExecutorCatalogEntry>;
  execute(
    request: Readonly<PluginExecutorRequest>,
    context: PluginExecutorContext,
  ): Promise<PluginExecutorResult>;
}

export interface PluginExecutorExecutionOptions {
  readonly signal?: AbortSignal;
  readonly onEvent?: (event: PluginExecutorOutputEvent) => void;
  readonly onPermissionRequest?: (
    request: PluginExecutorPermissionRequest,
  ) => Promise<PluginExecutorPermissionResult>;
}

export interface PluginExecutorInspection extends MakaContributionIdentity {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: Readonly<Required<PluginExecutorCapabilities>>;
}

/** Generation-pinned handle used by one prepared backend instance. */
export interface PluginExecutorBinding {
  readonly identity: PluginExecutorInspection;
  readonly providerStateIdentity: `sha256:${string}`;
  execute(
    request: PluginExecutorRequest,
    options?: PluginExecutorExecutionOptions,
  ): Promise<PluginExecutorResult>;
}

export interface PluginExecutorServiceOptions {
  readonly onChanged?: (rootId: MakaPluginRootId) => void;
}

interface RegisteredExecutor extends MakaContributionIdentity {
  readonly provider: PluginExecutorProvider;
  readonly token: symbol;
  readonly active: Set<ActiveExecution>;
  retired: boolean;
}

interface ActiveExecution {
  readonly conversationKey?: string;
  readonly abort: AbortController;
  readonly settled: Promise<void>;
}

class ExecutorRetiredAbort extends Error {
  constructor(executorId: string) {
    super(`Executor was retired: ${executorId}`);
    this.name = 'ExecutorRetiredAbort';
  }
}

/**
 * Scoped black-box execution registry.
 *
 * The service owns only registration, visibility, cancellation, and result
 * validation. Protocol processes, credentials, external conversation ids, and
 * tools remain private to the contributing plugin.
 */
export class PluginExecutorService extends Service {
  private readonly registry = new PluginScopeRegistry<RegisteredExecutor>();
  private readonly onChanged: ((rootId: MakaPluginRootId) => void) | undefined;

  constructor(ctx: Context, options: PluginExecutorServiceOptions = {}) {
    super(ctx, 'executors');
    this.onChanged = options.onChanged;
  }

  register(provider: PluginExecutorProvider): Disposable<Promise<void>> {
    validateProvider(provider);
    const identity = pluginIdentity(this.ctx);
    return registerPluginContribution(this.ctx, `executors.register(${provider.id})`, () => {
      const rootId = identity.scopeId as MakaPluginRootId;
      const existing = this.registry.get(rootId, provider.id);
      if (existing && existing.entryId !== identity.entryId) {
        throw new MakaPluginRuntimeError(
          'activation_failed',
          `Executor is already registered in this scope: ${provider.id}`,
        );
      }
      const capabilities = normalizeCapabilities(provider.capabilities);
      const registeredProvider: PluginExecutorProvider = Object.freeze({
        id: provider.id,
        ...(provider.displayName === undefined ? {} : { displayName: provider.displayName }),
        capabilities,
        execute: provider.execute.bind(provider),
        ...(provider.disposeConversation
          ? { disposeConversation: provider.disposeConversation.bind(provider) }
          : {}),
        ...(provider.configureConversation
          ? { configureConversation: provider.configureConversation.bind(provider) }
          : {}),
        ...(provider.discover ? { discover: provider.discover.bind(provider) } : {}),
        ...(provider.inspectConversation
          ? { inspectConversation: provider.inspectConversation.bind(provider) }
          : {}),
      });
      const entry: RegisteredExecutor = {
        ...identity,
        provider: registeredProvider,
        token: Symbol(provider.id),
        active: new Set(),
        retired: false,
      };
      return this.registry.publish(rootId, provider.id, entry, {
        ...(this.onChanged ? { onChanged: this.onChanged } : {}),
        onRetired: async (retired) => {
          for (const execution of retired.active) {
            execution.abort.abort(new ExecutorRetiredAbort(retired.provider.id));
          }
          await Promise.allSettled([...retired.active].map((execution) => execution.settled));
        },
      });
    });
  }

  list(sessionId: string): readonly PluginExecutorInspection[] {
    assertSessionId(sessionId);
    return Object.freeze(
      [...this.registry.visible(sessionId).values()]
        .sort((left, right) => left.provider.id.localeCompare(right.provider.id))
        .map(({ provider, token: _token, active: _active, retired: _retired, ...identity }) =>
          Object.freeze({
            ...identity,
            id: provider.id,
            displayName: provider.displayName?.trim() || provider.id,
            capabilities: normalizeCapabilities(provider.capabilities),
          }),
        ),
    );
  }

  inspect(rootId?: MakaPluginRootId): readonly PluginExecutorInspection[] {
    const seen = new Set<RegisteredExecutor>();
    return Object.freeze(
      [...this.registry.entries(rootId)]
        .filter((entry) => !seen.has(entry) && Boolean(seen.add(entry)))
        .sort((left, right) => left.provider.id.localeCompare(right.provider.id))
        .map(({ provider, token: _token, active: _active, retired: _retired, ...identity }) =>
          Object.freeze({
            ...identity,
            id: provider.id,
            displayName: provider.displayName?.trim() || provider.id,
            capabilities: normalizeCapabilities(provider.capabilities),
          }),
        ),
    );
  }

  /** Captures registrations before awaiting provider code; retirement cancels and drains probes. */
  async catalog(
    input: {
      cwd: string;
      sessionId?: string;
      /** Discover within this Session's scope without inspecting a retained conversation. */
      discoverySessionId?: string;
      executorId?: string;
      configuration?: ExecutorConfiguration;
    },
    signal = AbortSignal.timeout(35_000),
  ): Promise<readonly ExecutorCatalogEntry[]> {
    const scopeSessionId = input.sessionId ?? input.discoverySessionId;
    const entries = scopeSessionId
      ? [...this.registry.visible(scopeSessionId).values()]
      : [...this.registry.entries('profile')];
    const selected = entries.filter(
      (entry) => !entry.retired && (!input.executorId || entry.provider.id === input.executorId),
    );
    if (input.executorId && !selected.length)
      return [
        {
          id: input.executorId,
          displayName: input.executorId,
          readiness: 'unavailable',
          models: [],
          supportsAttachments: false,
          supportsModelChange: false,
        },
      ];
    return await Promise.all(
      selected.map((entry) =>
        this.withActiveOperation(entry, { signal }, async (combined) => {
          const fallback: ExecutorCatalogEntry = {
            id: entry.provider.id,
            displayName: entry.provider.displayName ?? entry.provider.id,
            readiness: 'ready',
            models: [],
            supportsAttachments: false,
            supportsModelChange: false,
          };
          try {
            combined.throwIfAborted();
            const result = input.sessionId
              ? await entry.provider.inspectConversation?.({
                  conversationKey: input.sessionId,
                  cwd: input.cwd,
                  ...(input.configuration ? { configuration: input.configuration } : {}),
                })
              : await entry.provider.discover?.({ cwd: input.cwd, signal: combined });
            combined.throwIfAborted();
            if (!result) return fallback;
            return normalizeCatalogEntry(result, entry.provider.id);
          } catch {
            return { ...fallback, readiness: 'unavailable' as const };
          }
        }),
      ),
    );
  }

  async configureConversation(
    sessionId: string,
    executorId: string,
    input: PluginExecutorConversationInput,
  ): Promise<void> {
    const entry = this.entry(sessionId, executorId);
    const configure = entry.provider.configureConversation;
    if (
      [...entry.active].some((execution) => execution.conversationKey === input.conversationKey) ||
      !configure
    )
      throw new Error('Executor configuration is unavailable or busy');
    if (!isExecutorConfiguration(input.configuration))
      throw new TypeError('Invalid executor configuration');
    await this.withActiveOperation(
      entry,
      { conversationKey: input.conversationKey },
      async (signal) => {
        await configure(input, AbortSignal.any([signal, AbortSignal.timeout(30_000)]));
      },
    );
  }

  /** Task retirement releases retained provider resources; backend refresh must not. */
  async retireConversation(sessionId: string): Promise<void> {
    assertSessionId(sessionId);
    const outcomes = await Promise.allSettled(
      [...this.registry.visible(sessionId).values()].map(async (entry) => {
        const running = [...entry.active].filter((active) => active.conversationKey === sessionId);
        for (const active of running) active.abort.abort(new Error('Task retired'));
        await Promise.allSettled(running.map((active) => active.settled));
        await entry.provider.disposeConversation?.(sessionId);
      }),
    );
    const failures = outcomes.flatMap((outcome) =>
      outcome.status === 'rejected' ? [outcome.reason] : [],
    );
    if (failures.length) throw new AggregateError(failures, 'Executor conversation cleanup failed');
  }

  identity(sessionId: string, executorId: string): PluginExecutorInspection {
    return this.identityForEntry(this.entry(sessionId, executorId));
  }

  bind(sessionId: string, executorId: string): PluginExecutorBinding {
    const entry = this.entry(sessionId, executorId);
    const identity = this.identityForEntry(entry);
    return Object.freeze({
      identity,
      providerStateIdentity: providerStateIdentity(identity),
      execute: (request: PluginExecutorRequest, options: PluginExecutorExecutionOptions = {}) => {
        if (request.sessionId !== sessionId) {
          throw new Error('Executor binding cannot cross Session scope');
        }
        return this.executeEntry(entry, request, options);
      },
    });
  }

  async execute(
    executorId: string,
    request: PluginExecutorRequest,
    options: PluginExecutorExecutionOptions = {},
  ): Promise<PluginExecutorResult> {
    const normalizedRequest = normalizeRequest(request);
    return this.executeEntry(
      this.entry(normalizedRequest.sessionId, executorId),
      normalizedRequest,
      options,
    );
  }

  private async executeEntry(
    entry: RegisteredExecutor,
    request: PluginExecutorRequest,
    options: PluginExecutorExecutionOptions,
  ): Promise<PluginExecutorResult> {
    const normalizedRequest = normalizeRequest(request);
    return await this.withActiveOperation(
      entry,
      { conversationKey: normalizedRequest.conversationKey, signal: options.signal },
      async (signal) => {
        if (entry.retired) return cancelledResult(new ExecutorRetiredAbort(entry.provider.id));
        try {
          const result = await entry.provider.execute(normalizedRequest, {
            signal,
            emit: (event) => {
              if (entry.retired) return;
              const normalized = normalizeOutputEvent(event, entry.provider.capabilities);
              try {
                options.onEvent?.(normalized);
              } catch {
                // A presentation observer must not change external execution.
              }
            },
            requestPermission: async (request) => {
              if (signal.aborted || entry.retired) return Object.freeze({ outcome: 'cancelled' });
              const normalized = normalizePermissionRequest(request);
              const result = options.onPermissionRequest
                ? await options.onPermissionRequest(normalized)
                : ({ outcome: 'cancelled' } as const);
              if (signal.aborted || entry.retired) return Object.freeze({ outcome: 'cancelled' });
              return normalizePermissionResult(result, normalized);
            },
          });
          if (signal.aborted) {
            const cancelled = cancelledResult(signal.reason);
            const normalized = normalizeResult(result);
            return normalized.status === 'cancelled'
              ? {
                  ...normalized,
                  ...cancelled,
                  ...(normalized.reason ? { reason: normalized.reason } : {}),
                }
              : cancelled;
          }
          return normalizeResult(result);
        } catch (error) {
          if (signal.aborted) return cancelledResult(signal.reason);
          throw error;
        }
      },
    );
  }

  private async withActiveOperation<T>(
    entry: RegisteredExecutor,
    input: { readonly conversationKey?: string; readonly signal?: AbortSignal },
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const abort = new AbortController();
    const signal = input.signal ? AbortSignal.any([input.signal, abort.signal]) : abort.signal;
    let settle!: () => void;
    const active: ActiveExecution = {
      abort,
      ...(input.conversationKey ? { conversationKey: input.conversationKey } : {}),
      settled: new Promise<void>((resolve) => {
        settle = resolve;
      }),
    };
    entry.active.add(active);
    try {
      return await run(signal);
    } finally {
      entry.active.delete(active);
      settle();
    }
  }

  private entry(sessionId: string, executorId: string): RegisteredExecutor {
    assertSessionId(sessionId);
    if (!isExecutorId(executorId)) throw new TypeError('Executor id is invalid');
    const entry = this.registry.visible(sessionId).get(executorId);
    if (!entry || entry.retired) throw new Error(`Executor is unavailable: ${executorId}`);
    return entry;
  }

  private identityForEntry(entry: RegisteredExecutor): PluginExecutorInspection {
    return Object.freeze({
      entryId: entry.entryId,
      scopeId: entry.scopeId,
      extensionId: entry.extensionId,
      generation: entry.generation,
      id: entry.provider.id,
      displayName: entry.provider.displayName?.trim() || entry.provider.id,
      capabilities: normalizeCapabilities(entry.provider.capabilities),
    });
  }
}

function validateProvider(provider: PluginExecutorProvider): void {
  if (!provider || typeof provider !== 'object')
    throw new TypeError('Executor provider is required');
  if (!isExecutorId(provider.id)) throw new TypeError('Executor id is invalid');
  if (typeof provider.execute !== 'function') {
    throw new TypeError(`Executor implementation is invalid: ${provider.id}`);
  }
  if (
    provider.displayName !== undefined &&
    (typeof provider.displayName !== 'string' || !provider.displayName.trim())
  ) {
    throw new TypeError(`Executor display name is invalid: ${provider.id}`);
  }
}

function assertSessionId(value: string): void {
  if (!value || /[\0\r\n]/u.test(value)) throw new TypeError('Session id is invalid');
}

function normalizeRequest(request: PluginExecutorRequest): Readonly<PluginExecutorRequest> {
  if (!request || typeof request !== 'object') throw new TypeError('Executor request is required');
  assertSessionId(request.sessionId);
  for (const [label, value] of [
    ['turnId', request.turnId],
    ['conversationKey', request.conversationKey],
    ['cwd', request.cwd],
  ] as const) {
    if (!value || /[\0\r\n]/u.test(value)) throw new TypeError(`Executor ${label} is invalid`);
  }
  if (request.configuration !== undefined && !isExecutorConfiguration(request.configuration))
    throw new TypeError('Executor configuration is invalid');
  if (typeof request.text !== 'string') throw new TypeError('Executor request text is invalid');
  if (request.runId !== undefined && (!request.runId || /[\0\r\n]/u.test(request.runId))) {
    throw new TypeError('Executor runId is invalid');
  }
  if (request.instructions !== undefined && typeof request.instructions !== 'string') {
    throw new TypeError('Executor instructions are invalid');
  }
  return Object.freeze({
    ...request,
    ...(request.configuration
      ? { configuration: Object.freeze({ ...request.configuration }) }
      : {}),
    ...(request.attachments ? { attachments: Object.freeze([...request.attachments]) } : {}),
    ...(request.directoryReferences
      ? { directoryReferences: Object.freeze([...request.directoryReferences]) }
      : {}),
    ...(request.quotes ? { quotes: Object.freeze([...request.quotes]) } : {}),
  });
}

function normalizeCapabilities(
  value: PluginExecutorCapabilities | undefined,
): Readonly<Required<PluginExecutorCapabilities>> {
  if (
    value !== undefined &&
    (!value ||
      typeof value !== 'object' ||
      (value.thinking !== undefined && typeof value.thinking !== 'boolean') ||
      (value.toolActivity !== undefined && typeof value.toolActivity !== 'boolean'))
  ) {
    throw new TypeError('Executor capabilities are invalid');
  }
  return Object.freeze({
    thinking: value?.thinking === true,
    toolActivity: value?.toolActivity === true,
  });
}

function normalizeOutputEvent(
  event: PluginExecutorOutputEvent,
  capabilities: PluginExecutorCapabilities | undefined,
): PluginExecutorOutputEvent {
  if (!event || typeof event !== 'object') throw new TypeError('Executor output event is invalid');
  if (event.type === 'output_delta' && typeof event.text === 'string') {
    return Object.freeze({ type: event.type, text: event.text });
  }
  if (
    event.type === 'thinking_delta' &&
    capabilities?.thinking === true &&
    isSafeEventText(event.text)
  ) {
    return Object.freeze({ type: event.type, text: event.text });
  }
  if (
    event.type === 'tool_start' &&
    capabilities?.toolActivity === true &&
    isSafeEventId(event.toolCallId) &&
    isSafeEventId(event.name) &&
    (event.displayName === undefined || isSafeEventText(event.displayName)) &&
    (event.activityKind === undefined || TOOL_ACTIVITY_KINDS.includes(event.activityKind))
  ) {
    return Object.freeze({
      type: event.type,
      toolCallId: event.toolCallId,
      name: event.name,
      ...(event.input === undefined ? {} : { input: structuredClone(event.input) }),
      ...(event.displayName === undefined ? {} : { displayName: event.displayName }),
      ...(event.activityKind === undefined ? {} : { activityKind: event.activityKind }),
    });
  }
  if (
    event.type === 'tool_output_delta' &&
    capabilities?.toolActivity === true &&
    isSafeEventId(event.toolCallId) &&
    isSafeEventText(event.text) &&
    (event.stream === undefined || TOOL_OUTPUT_STREAMS.some((stream) => stream === event.stream))
  ) {
    return Object.freeze({
      type: event.type,
      toolCallId: event.toolCallId,
      text: event.text,
      ...(event.stream === undefined ? {} : { stream: event.stream }),
    });
  }
  if (
    event.type === 'tool_progress' &&
    capabilities?.toolActivity === true &&
    isSafeEventId(event.toolCallId) &&
    isSafeEventText(event.text)
  ) {
    return Object.freeze({ type: event.type, toolCallId: event.toolCallId, text: event.text });
  }
  if (
    event.type === 'tool_result' &&
    capabilities?.toolActivity === true &&
    isSafeEventId(event.toolCallId) &&
    isPluginToolResultContent(event.content) &&
    (event.isError === undefined || typeof event.isError === 'boolean')
  ) {
    return Object.freeze({
      type: event.type,
      toolCallId: event.toolCallId,
      content:
        event.content.kind === 'text'
          ? Object.freeze({ kind: 'text' as const, text: event.content.text })
          : Object.freeze({
              kind: 'file_diff' as const,
              paths: Object.freeze([...event.content.paths]),
              diff: event.content.diff,
            }),
      ...(event.isError === undefined ? {} : { isError: event.isError }),
    });
  }
  throw new TypeError('Executor output event is invalid or undeclared');
}

function isPluginToolResultContent(value: PluginExecutorToolResultContent): boolean {
  if (!value || typeof value !== 'object') return false;
  if (value.kind === 'text') return isSafeEventText(value.text);
  return (
    value.kind === 'file_diff' &&
    Array.isArray(value.paths) &&
    value.paths.length > 0 &&
    value.paths.length <= 64 &&
    value.paths.every((path) => isSafeEventText(path) && path.trim().length > 0) &&
    typeof value.diff === 'string' &&
    value.diff.length <= 1024 * 1024 &&
    !/[\0\r]/u.test(value.diff)
  );
}

function normalizeResult(result: PluginExecutorResult): PluginExecutorResult {
  if (!result || typeof result !== 'object') throw new TypeError('Executor result is invalid');
  if (result.status === 'completed' && typeof result.text === 'string') {
    if (Buffer.byteLength(result.text, 'utf8') > MAX_EXECUTOR_COMPLETION_TEXT_BYTES)
      throw new TypeError('Executor completion text exceeds the size limit');
    return Object.freeze({ status: result.status, text: result.text });
  }
  if (
    result.status === 'cancelled' &&
    (result.reason === undefined || typeof result.reason === 'string') &&
    (result.providerStopReason === undefined || isSafeEventText(result.providerStopReason))
  ) {
    return Object.freeze({
      status: result.status,
      ...(result.reason === undefined ? {} : { reason: result.reason }),
      ...(result.providerStopReason === undefined
        ? {}
        : { providerStopReason: result.providerStopReason }),
      source: 'provider',
    });
  }
  if (
    result.status === 'failed' &&
    typeof result.message === 'string' &&
    (result.code === undefined || typeof result.code === 'string') &&
    (result.recoverable === undefined || typeof result.recoverable === 'boolean')
  ) {
    return Object.freeze({
      status: result.status,
      message: result.message,
      ...(result.code === undefined ? {} : { code: result.code }),
      ...(result.recoverable === undefined ? {} : { recoverable: result.recoverable }),
    });
  }
  throw new TypeError('Executor result is invalid');
}

function normalizePermissionRequest(
  request: PluginExecutorPermissionRequest,
): PluginExecutorPermissionRequest {
  if (
    !request ||
    typeof request !== 'object' ||
    (request.kind !== undefined && request.kind !== 'permission' && request.kind !== 'question') ||
    !isSafeEventId(request.toolCallId) ||
    !isSafeEventText(request.title) ||
    !request.title.trim() ||
    !Array.isArray(request.options) ||
    request.options.length === 0 ||
    request.options.length > 64
  ) {
    throw new TypeError('Executor permission request is invalid');
  }
  const seen = new Set<string>();
  const options = request.options.map((option) => {
    if (
      !option ||
      typeof option !== 'object' ||
      !isSafeEventId(option.optionId) ||
      !isSafeEventText(option.name) ||
      !option.name.trim() ||
      seen.has(option.optionId)
    ) {
      throw new TypeError('Executor permission option is invalid');
    }
    seen.add(option.optionId);
    return Object.freeze({ optionId: option.optionId, name: option.name });
  });
  return Object.freeze({
    ...(request.kind ? { kind: request.kind } : {}),
    toolCallId: request.toolCallId,
    title: request.title,
    options: Object.freeze(options),
  });
}

function normalizePermissionResult(
  result: PluginExecutorPermissionResult,
  request: PluginExecutorPermissionRequest,
): PluginExecutorPermissionResult {
  if (result?.outcome === 'cancelled') return Object.freeze({ outcome: 'cancelled' });
  if (
    result?.outcome === 'selected' &&
    request.options.some((option) => option.optionId === result.optionId)
  ) {
    return Object.freeze({ outcome: 'selected', optionId: result.optionId });
  }
  throw new TypeError('Executor permission result is invalid');
}

function providerStateIdentity(identity: PluginExecutorInspection): `sha256:${string}` {
  return `sha256:${createHash('sha256')
    .update(
      JSON.stringify([
        'plugin-executor.v1',
        identity.id,
        identity.extensionId,
        identity.entryId,
        identity.generation,
      ]),
    )
    .digest('hex')}`;
}

function cancelledResult(reason: unknown): Extract<PluginExecutorResult, { status: 'cancelled' }> {
  const source: PluginExecutorCancellationSource =
    reason instanceof ExecutorRetiredAbort ? 'executor_retired' : 'caller';
  const message =
    reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : undefined;
  return Object.freeze({
    status: 'cancelled',
    source,
    ...(message ? { reason: message } : {}),
  });
}

function isSafeEventId(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\0\r\n]/u.test(value)
  );
}

function isSafeEventText(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 8_192 && !/[\0\r]/u.test(value);
}

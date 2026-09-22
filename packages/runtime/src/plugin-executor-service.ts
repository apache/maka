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
import type {
  AttachmentRef,
  DirectoryReference,
  QuoteRef,
  ToolActivityKind,
} from '@maka/core/events';
import { TOOL_ACTIVITY_KINDS } from '@maka/core/events';
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
  | { readonly type: 'tool_progress'; readonly toolCallId: string; readonly text: string }
  | {
      readonly type: 'tool_result';
      readonly toolCallId: string;
      readonly text: string;
      readonly isError?: boolean;
    };

export type PluginExecutorCancellationSource = 'provider' | 'caller' | 'executor_retired';

export type PluginExecutorResult =
  | { readonly status: 'completed'; readonly text: string }
  | {
      readonly status: 'cancelled';
      readonly reason?: string;
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
}

/** A black-box executor contributed by one Host plugin. */
export interface PluginExecutorProvider {
  readonly id: string;
  readonly displayName?: string;
  readonly capabilities?: PluginExecutorCapabilities;
  execute(
    request: Readonly<PluginExecutorRequest>,
    context: PluginExecutorContext,
  ): Promise<PluginExecutorResult>;
}

export interface PluginExecutorExecutionOptions {
  readonly signal?: AbortSignal;
  readonly onEvent?: (event: PluginExecutorOutputEvent) => void;
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
    const abort = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, abort.signal]) : abort.signal;
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const active: ActiveExecution = { abort, settled };
    entry.active.add(active);
    try {
      if (entry.retired) return cancelledResult(new ExecutorRetiredAbort(entry.provider.id));
      try {
        const result = await entry.provider.execute(normalizedRequest, {
          signal,
          emit: (event) => {
            if (signal.aborted || entry.retired) return;
            const normalized = normalizeOutputEvent(event, entry.provider.capabilities);
            try {
              options.onEvent?.(normalized);
            } catch {
              // A presentation observer must not change external execution.
            }
          },
        });
        if (signal.aborted) return cancelledResult(signal.reason);
        return normalizeResult(result);
      } catch (error) {
        if (signal.aborted) return cancelledResult(signal.reason);
        throw error;
      }
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
  if (typeof request.text !== 'string') throw new TypeError('Executor request text is invalid');
  if (request.runId !== undefined && (!request.runId || /[\0\r\n]/u.test(request.runId))) {
    throw new TypeError('Executor runId is invalid');
  }
  if (request.instructions !== undefined && typeof request.instructions !== 'string') {
    throw new TypeError('Executor instructions are invalid');
  }
  return Object.freeze({
    ...request,
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
    isSafeEventText(event.text) &&
    (event.isError === undefined || typeof event.isError === 'boolean')
  ) {
    return Object.freeze({
      type: event.type,
      toolCallId: event.toolCallId,
      text: event.text,
      ...(event.isError === undefined ? {} : { isError: event.isError }),
    });
  }
  throw new TypeError('Executor output event is invalid or undeclared');
}

function normalizeResult(result: PluginExecutorResult): PluginExecutorResult {
  if (!result || typeof result !== 'object') throw new TypeError('Executor result is invalid');
  if (result.status === 'completed' && typeof result.text === 'string') {
    return Object.freeze({ status: result.status, text: result.text });
  }
  if (
    result.status === 'cancelled' &&
    (result.reason === undefined || typeof result.reason === 'string')
  ) {
    return Object.freeze({
      status: result.status,
      ...(result.reason === undefined ? {} : { reason: result.reason }),
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

function cancelledResult(reason: unknown): PluginExecutorResult {
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

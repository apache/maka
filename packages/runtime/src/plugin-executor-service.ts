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

import type { AttachmentRef, DirectoryReference, QuoteRef } from '@maka/core/events';
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

const EXECUTOR_ID_PATTERN = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/u;

export interface PluginExecutorRequest {
  readonly sessionId: string;
  readonly turnId: string;
  readonly runId?: string;
  /** Stable key a provider may use to retain its own external conversation. */
  readonly conversationKey: string;
  readonly text: string;
  readonly cwd: string;
  /** Child-agent instruction when this request belongs to a linked child Session. */
  readonly instructions?: string;
  readonly attachments?: readonly AttachmentRef[];
  readonly directoryReferences?: readonly DirectoryReference[];
  readonly quotes?: readonly QuoteRef[];
}

export interface PluginExecutorOutputEvent {
  readonly type: 'output_delta';
  readonly text: string;
}

export type PluginExecutorResult =
  | { readonly status: 'completed'; readonly text: string }
  | { readonly status: 'cancelled'; readonly reason?: string }
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

/**
 * Scoped black-box execution registry.
 *
 * The service owns only registration, visibility, cancellation, and result
 * validation. Protocol processes, credentials, external conversation ids, and
 * tools remain private to the contributing plugin.
 */
export class PluginExecutorService extends Service {
  private readonly registry = new PluginScopeRegistry<RegisteredExecutor>();

  constructor(ctx: Context) {
    super(ctx, 'executors');
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
      const entry: RegisteredExecutor = {
        ...identity,
        provider: Object.freeze({ ...provider }),
        token: Symbol(provider.id),
        active: new Set(),
        retired: false,
      };
      return this.registry.publish(rootId, provider.id, entry, {
        onRetired: async (retired) => {
          for (const execution of retired.active) {
            execution.abort.abort(new Error(`Executor was retired: ${retired.provider.id}`));
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
          }),
        ),
    );
  }

  identity(sessionId: string, executorId: string): PluginExecutorInspection {
    const entry = this.entry(sessionId, executorId);
    return Object.freeze({
      entryId: entry.entryId,
      scopeId: entry.scopeId,
      extensionId: entry.extensionId,
      generation: entry.generation,
      id: entry.provider.id,
      displayName: entry.provider.displayName?.trim() || entry.provider.id,
    });
  }

  async execute(
    executorId: string,
    request: PluginExecutorRequest,
    options: PluginExecutorExecutionOptions = {},
  ): Promise<PluginExecutorResult> {
    const normalizedRequest = normalizeRequest(request);
    const entry = this.entry(normalizedRequest.sessionId, executorId);
    const abort = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, abort.signal]) : abort.signal;
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const active: ActiveExecution = { abort, settled };
    entry.active.add(active);
    try {
      if (entry.retired) throw new Error(`Executor is unavailable: ${executorId}`);
      const result = await entry.provider.execute(normalizedRequest, {
        signal,
        emit: (event) => {
          if (signal.aborted || entry.retired) return;
          const normalized = normalizeOutputEvent(event);
          try {
            options.onEvent?.(normalized);
          } catch {
            // A presentation observer must not change external execution.
          }
        },
      });
      return normalizeResult(result);
    } finally {
      entry.active.delete(active);
      settle();
    }
  }

  private entry(sessionId: string, executorId: string): RegisteredExecutor {
    assertSessionId(sessionId);
    assertExecutorId(executorId);
    const entry = this.registry.visible(sessionId).get(executorId);
    if (!entry || entry.retired) throw new Error(`Executor is unavailable: ${executorId}`);
    return entry;
  }
}

function validateProvider(provider: PluginExecutorProvider): void {
  if (!provider || typeof provider !== 'object')
    throw new TypeError('Executor provider is required');
  assertExecutorId(provider.id);
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

function assertExecutorId(value: string): void {
  if (typeof value !== 'string' || !EXECUTOR_ID_PATTERN.test(value)) {
    throw new TypeError('Executor id is invalid');
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

function normalizeOutputEvent(event: PluginExecutorOutputEvent): PluginExecutorOutputEvent {
  if (!event || event.type !== 'output_delta' || typeof event.text !== 'string') {
    throw new TypeError('Executor output event is invalid');
  }
  return Object.freeze({ type: 'output_delta', text: event.text });
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

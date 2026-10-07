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

import { Service, type Context, type Disposable } from './plugin-kernel.js';
import type { PluginAgentInvocation, PluginAgentService } from './plugin-agent-service.js';

declare module './plugin-kernel.js' {
  interface Context {
    readonly sessionQuery: PluginSessionQueryService;
  }
}

export interface PluginSessionSummary {
  readonly id: string;
  readonly title?: string;
  readonly cwd?: string;
  readonly status?: string;
  readonly parentSessionId?: string;
  readonly updatedAt?: string | number;
  /** Opaque durable content revision, independent of the event timestamp. */
  readonly historyRevision?: string;
}

export interface PluginSessionSnapshot {
  readonly session: PluginSessionSummary;
  readonly messages: readonly unknown[];
}

export interface PluginSessionSearchRequest {
  readonly query: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface PluginSessionSearchPage {
  readonly items: readonly PluginSessionSummary[];
  readonly cursor?: string;
}

export interface PluginSessionQueryCaller {
  readonly invocation?: PluginAgentInvocation;
  /** Session-root activation is confined even when it is outside an Agent Tool call. */
  readonly scopeSessionId?: string;
}

export interface PluginSessionQueryRuntime {
  /** Optional Recall-compatible cross-Session history capability. */
  historyList?(caller: PluginSessionQueryCaller): Promise<readonly PluginSessionSummary[]>;
  historyRead?(
    sessionId: string,
    caller: PluginSessionQueryCaller,
  ): Promise<PluginSessionSnapshot | undefined>;
  list(caller: PluginSessionQueryCaller): Promise<readonly PluginSessionSummary[]>;
  read(
    sessionId: string,
    caller: PluginSessionQueryCaller,
  ): Promise<PluginSessionSnapshot | undefined>;
  search(
    request: PluginSessionSearchRequest,
    caller: PluginSessionQueryCaller,
  ): Promise<PluginSessionSearchPage>;
}

export interface PluginHistorySource {
  readonly id: string;
  readonly description: string;
  /** Must enforce source permissions and return stable IDs with opaque revisions. */
  list(caller: PluginSessionQueryCaller): Promise<readonly PluginSessionSummary[]>;
  read(id: string, caller: PluginSessionQueryCaller): Promise<PluginSessionSnapshot | undefined>;
}

/** Read-only, paged Session projection. It never exposes the mutable Session Store. */
export class PluginSessionQueryService extends Service {
  private queryRuntime?: PluginSessionQueryRuntime;
  private readonly historySourcesById = new Map<string, PluginHistorySource>();

  constructor(
    ctx: Context,
    private readonly agents: PluginAgentService,
  ) {
    super(ctx, 'sessionQuery');
  }

  bindRuntime(runtime: PluginSessionQueryRuntime): Disposable<Promise<void>> {
    if (this.ctx.maka) throw new Error('Only the Host may bind the Session Query Runtime');
    if (this.queryRuntime) throw new Error('Plugin Session Query Runtime is already bound');
    this.queryRuntime = runtime;
    return this.ctx.effect(
      () => () => {
        if (this.queryRuntime === runtime) this.queryRuntime = undefined;
      },
      'sessionQuery.bindRuntime()',
    );
  }

  list(): Promise<readonly PluginSessionSummary[]> {
    return this.runtime().list(this.caller());
  }

  read(sessionId: string): Promise<PluginSessionSnapshot | undefined> {
    return this.runtime().read(assertSessionId(sessionId), this.caller());
  }

  search(request: PluginSessionSearchRequest): Promise<PluginSessionSearchPage> {
    if (!request.query.trim()) throw new TypeError('Session query must not be empty');
    if (
      request.limit !== undefined &&
      (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 100)
    ) {
      throw new TypeError('Session query limit must be an integer from 1 to 100');
    }
    return this.runtime().search(
      Object.freeze({ ...request, query: request.query.trim() }),
      this.caller(),
    );
  }

  historyList(): Promise<readonly PluginSessionSummary[]> {
    this.agents.requireInvocation();
    const runtime = this.runtime();
    if (!runtime.historyList) throw new Error('Host does not support cross-Session history');
    return runtime.historyList(this.caller());
  }

  historyRead(sessionId: string): Promise<PluginSessionSnapshot | undefined> {
    this.agents.requireInvocation();
    const runtime = this.runtime();
    if (!runtime.historyRead) throw new Error('Host does not support cross-Session history');
    return runtime.historyRead(assertSessionId(sessionId), this.caller());
  }

  registerHistorySource(source: PluginHistorySource): Disposable<Promise<void>> {
    if (this.ctx.maka && this.ctx.maka.rootId !== 'profile')
      throw new Error('History sources require profile scope');
    if (!/^[a-z][a-z0-9._-]{0,79}$/.test(source.id) || source.id === 'maka')
      throw new TypeError('Invalid or reserved history source ID');
    const sources = this.historySourcesById;
    return this.ctx.effect(() => {
      if (sources.has(source.id)) throw new Error('History source already registered');
      sources.set(source.id, source);
      return () => {
        if (sources.get(source.id) === source) sources.delete(source.id);
      };
    }, `historySource:${source.id}`);
  }

  historySources(): readonly { id: string; description: string }[] {
    this.agents.requireInvocation();
    return [
      { id: 'maka', description: 'Recall-visible Maka Session history' },
      ...[...this.historySourcesById.values()].map(({ id, description }) => ({ id, description })),
    ];
  }

  sourceList(sourceId: string): Promise<readonly PluginSessionSummary[]> {
    this.agents.requireInvocation();
    if (sourceId === 'maka') return this.historyList();
    const source = this.historySourcesById.get(sourceId);
    if (!source) throw new Error('History source is unavailable');
    return source.list(this.caller());
  }

  sourceRead(sourceId: string, id: string): Promise<PluginSessionSnapshot | undefined> {
    this.agents.requireInvocation();
    if (sourceId === 'maka') return this.historyRead(id);
    const source = this.historySourcesById.get(sourceId);
    if (!source) throw new Error('History source is unavailable');
    return source.read(assertSessionId(id), this.caller());
  }

  /** Query a permitted source using the same typed message projection as cached history. */
  async sourceQuery(sourceId: string, id: string, request: PluginHistoryMessageQuery = {}) {
    const snapshot = await this.sourceRead(sourceId, id);
    return snapshot
      ? { session: snapshot.session, ...selectSessionMessages(snapshot.messages, request) }
      : undefined;
  }

  /** Pure projection for a plugin's immutable cached source snapshot; does not fetch history. */
  selectMessages(messages: readonly unknown[], request: PluginHistoryMessageQuery = {}) {
    return selectSessionMessages(messages, request);
  }

  private runtime(): PluginSessionQueryRuntime {
    if (!this.queryRuntime) throw new Error('Plugin Session Query Runtime is unavailable');
    return this.queryRuntime;
  }

  private caller(): PluginSessionQueryCaller {
    const invocation = this.agents.currentInvocation();
    if (invocation) return Object.freeze({ invocation });
    const rootId = this.ctx.maka?.rootId;
    return Object.freeze(
      rootId?.startsWith('session:') ? { scopeSessionId: rootId.slice('session:'.length) } : {},
    );
  }
}

function assertSessionId(value: string): string {
  if (!value || /[\0\r\n]/u.test(value)) throw new TypeError('Session id is invalid');
  return value;
}

export interface PluginHistoryMessageQuery {
  readonly view?: 'conversation' | 'all';
  readonly types?: readonly string[];
  readonly messageId?: string;
  readonly query?: string;
  readonly since?: number;
  readonly until?: number;
  readonly after?: number;
  readonly limit?: number;
}

/** Filter before paging; the cursor is a source position, never a processed/coverage claim. */
export function selectSessionMessages(
  messages: readonly unknown[],
  request: PluginHistoryMessageQuery = {},
) {
  const limit = request.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
    throw new TypeError('Invalid history query limit');
  if (request.after !== undefined && (!Number.isSafeInteger(request.after) || request.after < -1))
    throw new TypeError('Invalid history query position');
  if (request.view !== undefined && !['conversation', 'all'].includes(request.view))
    throw new TypeError('Invalid history view');
  for (const time of [request.since, request.until])
    if (time !== undefined && (!Number.isFinite(time) || time < 0))
      throw new TypeError('Invalid history time');
  if (
    request.types &&
    (!Array.isArray(request.types) || request.types.some((t) => typeof t !== 'string'))
  )
    throw new TypeError('Invalid message types');
  const types = request.types;
  const matches: { position: number; message: Record<string, unknown> }[] = [];
  const typeCounts: Record<string, number> = {};
  for (let position = 0; position < messages.length; position++) {
    const value = messages[position];
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const message = value as Record<string, unknown>;
    const type = String(message.type ?? 'unknown');
    typeCounts[type] = (typeCounts[type] ?? 0) + 1;
    if (types && !types.includes(type)) continue;
    if (request.view === 'conversation' && !['user', 'assistant'].includes(type)) continue;
    const options = message.providerOptions as { openai?: { phase?: string } } | undefined;
    const phase = options?.openai?.phase;
    if (
      request.view === 'conversation' &&
      type === 'assistant' &&
      (phase === 'commentary' || typeof message.text !== 'string' || !message.text.trim())
    )
      continue;
    if (request.messageId && message.id !== request.messageId) continue;
    if (request.since !== undefined && !(Number(message.ts) >= request.since)) continue;
    if (request.until !== undefined && !(Number(message.ts) <= request.until)) continue;
    const projected: Record<string, unknown> =
      request.view !== 'conversation'
        ? message
        : Object.fromEntries(
            Object.entries({
              id: message.id,
              type: message.type,
              turnId: message.turnId,
              ts: message.ts,
              text: message.displayText ?? message.text,
              phase: type === 'assistant' ? (phase ?? 'unspecified') : undefined,
            }).filter(([, v]) => v !== undefined),
          );
    if (
      request.query &&
      !JSON.stringify(projected).toLowerCase().includes(request.query.toLowerCase())
    )
      continue;
    matches.push({ position, message: projected });
  }
  const remaining = matches.filter((m) => m.position > (request.after ?? -1));
  const items = remaining.slice(0, limit);
  return {
    items,
    next: remaining.length > limit ? items.at(-1)!.position : null,
    total: matches.length,
    sourceMessages: messages.length,
    typeCounts,
    view: request.view ?? 'all',
    notice:
      'Conversation view omits explicit commentary, thinking-only messages and process types. Legacy assistant messages without phase metadata remain visible; unspecified does not mean verified final answer. Use view=all and types to inspect process evidence.',
  };
}

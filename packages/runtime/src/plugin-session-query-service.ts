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

/** Read-only, paged Session projection. It never exposes the mutable Session Store. */
export class PluginSessionQueryService extends Service {
  private queryRuntime?: PluginSessionQueryRuntime;

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

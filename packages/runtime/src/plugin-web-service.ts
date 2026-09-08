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

import type { WebSearchResponse } from '@maka/core/web-search';
import {
  WEB_SEARCH_DEFAULT_LIMIT,
  normalizeWebSearchLimit,
  normalizeWebSearchQuery,
} from '@maka/core/web-search';
import { Service, type Context, type Disposable } from './plugin-kernel.js';
import type { PluginAgentService } from './plugin-agent-service.js';

declare module './plugin-kernel.js' {
  interface Context {
    readonly web: PluginWebService;
  }
}

export interface PluginWebRuntime {
  search(input: {
    readonly query: string;
    readonly limit: number;
    readonly sessionId: string;
    readonly abortSignal?: AbortSignal;
  }): Promise<WebSearchResponse>;
  fetch(input: {
    readonly url: string;
    readonly sessionId: string;
    readonly abortSignal?: AbortSignal;
  }): Promise<string>;
}

/** Provider-policy-aware web search and fetch surface. */
export class PluginWebService extends Service {
  private webRuntime?: PluginWebRuntime;

  constructor(
    ctx: Context,
    private readonly agents: PluginAgentService,
  ) {
    super(ctx, 'web');
  }

  bindRuntime(runtime: PluginWebRuntime): Disposable<Promise<void>> {
    if (this.ctx.maka) throw new Error('Only the Host may bind the Web Runtime');
    if (this.webRuntime) throw new Error('Plugin Web Runtime is already bound');
    this.webRuntime = runtime;
    return this.ctx.effect(
      () => () => {
        if (this.webRuntime === runtime) this.webRuntime = undefined;
      },
      'web.bindRuntime()',
    );
  }

  search(query: string, options: { readonly limit?: number; readonly signal?: AbortSignal } = {}) {
    const invocation = this.agents.requireInvocation();
    const normalized = normalizeWebSearchQuery(query);
    if (!normalized) throw new TypeError('Web search query is invalid');
    return this.runtime().search({
      query: normalized,
      limit: normalizeWebSearchLimit(options.limit ?? WEB_SEARCH_DEFAULT_LIMIT),
      sessionId: invocation.sessionId,
      abortSignal: options.signal ?? invocation.abortSignal,
    });
  }

  fetch(url: string, options: { readonly signal?: AbortSignal } = {}) {
    const invocation = this.agents.requireInvocation();
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      throw new TypeError('Web URL must use HTTP or HTTPS');
    return this.runtime().fetch({
      url: parsed.toString(),
      sessionId: invocation.sessionId,
      abortSignal: options.signal ?? invocation.abortSignal,
    });
  }

  private runtime(): PluginWebRuntime {
    if (!this.webRuntime) throw new Error('Plugin Web Runtime is unavailable');
    return this.webRuntime;
  }
}

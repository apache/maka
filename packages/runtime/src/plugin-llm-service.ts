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
import { pluginInvocationSignal } from './plugin-invocation-signal.js';
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
    readonly llm: PluginLlmService;
  }
}

export interface PluginLlmGenerateInput {
  readonly prompt: string;
  readonly system?: string;
  readonly maxOutputTokens?: number;
  readonly signal?: AbortSignal;
}

export interface PluginLlmGenerateResult {
  readonly text: string;
  readonly modelId: string;
  readonly finishReason?: string;
}

export interface PluginLlmRuntime {
  generate(
    input: PluginLlmGenerateInput,
    invocation: PluginAgentInvocation,
  ): Promise<PluginLlmGenerateResult>;
}

export interface PluginLlmAdapter {
  readonly id: string;
  readonly priority?: number;
  supports(model: string): boolean;
  generate(
    input: PluginLlmGenerateInput,
    invocation: PluginAgentInvocation,
  ): Promise<PluginLlmGenerateResult>;
}

interface RegisteredAdapter extends MakaContributionIdentity {
  readonly adapter: PluginLlmAdapter;
  readonly token: symbol;
  retired: boolean;
}

/** Metered Host model calls plus an ordered plugin adapter seam. */
export class PluginLlmService extends Service {
  private llmRuntime?: PluginLlmRuntime;
  private readonly adapters = new PluginScopeRegistry<RegisteredAdapter>();

  constructor(
    ctx: Context,
    private readonly agents: PluginAgentService,
  ) {
    super(ctx, 'llm');
  }

  bindRuntime(runtime: PluginLlmRuntime): Disposable<Promise<void>> {
    if (this.ctx.maka) throw new Error('Only the Host may bind the LLM Runtime');
    if (this.llmRuntime) throw new Error('Plugin LLM Runtime is already bound');
    this.llmRuntime = runtime;
    return this.ctx.effect(
      () => () => {
        if (this.llmRuntime === runtime) this.llmRuntime = undefined;
      },
      'llm.bindRuntime()',
    );
  }

  register(adapter: PluginLlmAdapter): Disposable<Promise<void>> {
    if (!adapter || !/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/u.test(adapter.id)) {
      throw new TypeError('LLM adapter id is invalid');
    }
    if (typeof adapter.supports !== 'function' || typeof adapter.generate !== 'function') {
      throw new TypeError(`LLM adapter implementation is invalid: ${adapter.id}`);
    }
    const identity = pluginIdentity(this.ctx);
    return registerPluginContribution(this.ctx, `llm.adapter:${adapter.id}`, () => {
      const rootId = identity.scopeId as MakaPluginRootId;
      const existing = this.adapters.get(rootId, adapter.id);
      if (existing && existing.entryId !== identity.entryId) {
        throw new MakaPluginRuntimeError(
          'activation_failed',
          `LLM adapter is already registered in this scope: ${adapter.id}`,
        );
      }
      const entry: RegisteredAdapter = {
        ...identity,
        adapter,
        token: Symbol(adapter.id),
        retired: false,
      };
      return this.adapters.publish(rootId, adapter.id, entry);
    });
  }

  generate(
    input: PluginLlmGenerateInput & { readonly model?: string },
  ): Promise<PluginLlmGenerateResult> {
    const invocation = this.agents.requireInvocation();
    const effectiveInput = Object.freeze({
      ...input,
      signal: pluginInvocationSignal(invocation.abortSignal, input.signal),
    });
    const visibleAdapters = this.adapters.visible(invocation.sessionId);
    const adapter = input.model
      ? [...visibleAdapters.values()]
          .map((entry) => entry.adapter)
          .filter((candidate) => candidate.supports(input.model!))
          .sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0))[0]
      : undefined;
    if (adapter) return adapter.generate(effectiveInput, invocation);
    if (!this.llmRuntime) throw new Error('Plugin LLM Runtime is unavailable');
    return this.llmRuntime.generate(effectiveInput, invocation);
  }
}

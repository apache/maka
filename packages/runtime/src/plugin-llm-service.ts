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

/** Metered Host model calls plus an ordered plugin adapter seam. */
export class PluginLlmService extends Service {
  private llmRuntime?: PluginLlmRuntime;
  private readonly adapters: Array<{ adapter: PluginLlmAdapter; owner: Context }> = [];

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
    if (
      this.adapters.some(
        (entry) =>
          entry.adapter.id === adapter.id && entry.owner.maka?.rootId === this.ctx.maka?.rootId,
      )
    ) {
      throw new Error(`LLM adapter is already registered in this scope: ${adapter.id}`);
    }
    const entry = { adapter, owner: this.ctx };
    this.adapters.push(entry);
    return this.ctx.effect(
      () => () => {
        const index = this.adapters.indexOf(entry);
        if (index >= 0) this.adapters.splice(index, 1);
      },
      `llm.adapter:${adapter.id}`,
    );
  }

  generate(
    input: PluginLlmGenerateInput & { readonly model?: string },
  ): Promise<PluginLlmGenerateResult> {
    const invocation = this.agents.requireInvocation();
    const adapter = input.model
      ? [...this.adapters]
          .filter((entry) => entry.adapter.supports(input.model!))
          .sort((left, right) => (right.adapter.priority ?? 0) - (left.adapter.priority ?? 0))[0]
          ?.adapter
      : undefined;
    if (adapter) return adapter.generate(input, invocation);
    if (!this.llmRuntime) throw new Error('Plugin LLM Runtime is unavailable');
    return this.llmRuntime.generate(input, invocation);
  }
}

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
    readonly goals: PluginGoalService;
  }
}

export interface PluginGoalCreateInput {
  readonly objective: string;
  readonly maxIterations?: number;
  readonly blockCap?: number;
  readonly tokenBudget?: number;
}

export type PluginGoalOperation =
  | { readonly kind: 'get' }
  | ({ readonly kind: 'create' } & PluginGoalCreateInput)
  | { readonly kind: 'clear' }
  | { readonly kind: 'pause' }
  | { readonly kind: 'resume' };

export interface PluginGoalRuntime {
  execute(operation: PluginGoalOperation, invocation: PluginAgentInvocation): Promise<unknown>;
}

/** Current-Session Goal facade; mutations retain Maka's Turn lease and revision authority. */
export class PluginGoalService extends Service {
  private goalRuntime?: PluginGoalRuntime;

  constructor(
    ctx: Context,
    private readonly agents: PluginAgentService,
  ) {
    super(ctx, 'goals');
  }

  bindRuntime(runtime: PluginGoalRuntime): Disposable<Promise<void>> {
    if (this.ctx.maka) throw new Error('Only the Host may bind the Goal Runtime');
    if (this.goalRuntime) throw new Error('Plugin Goal Runtime is already bound');
    this.goalRuntime = runtime;
    return this.ctx.effect(
      () => () => {
        if (this.goalRuntime === runtime) this.goalRuntime = undefined;
      },
      'goals.bindRuntime()',
    );
  }

  get(): Promise<unknown> {
    return this.execute({ kind: 'get' });
  }
  create(input: PluginGoalCreateInput): Promise<unknown> {
    if (!input.objective.trim()) throw new TypeError('Goal objective must not be empty');
    return this.execute({ ...input, kind: 'create', objective: input.objective.trim() });
  }
  clear(): Promise<unknown> {
    return this.execute({ kind: 'clear' });
  }
  pause(): Promise<unknown> {
    return this.execute({ kind: 'pause' });
  }
  resume(): Promise<unknown> {
    return this.execute({ kind: 'resume' });
  }

  private execute(operation: PluginGoalOperation): Promise<unknown> {
    if (!this.goalRuntime) throw new Error('Plugin Goal Runtime is unavailable');
    return this.goalRuntime.execute(operation, this.agents.requireInvocation());
  }
}

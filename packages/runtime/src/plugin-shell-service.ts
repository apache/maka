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
import type { PluginShellEnvService } from './plugin-shell-env-service.js';

declare module './plugin-kernel.js' {
  interface Context {
    readonly shell: PluginShellService;
  }
}

export interface PluginShellRunOptions {
  readonly command: string;
  readonly timeoutMs?: number;
  readonly background?: boolean;
  readonly pty?: boolean;
  /** Host-populated scoped overlay; callers cannot provide arbitrary ambient variables. */
  readonly environment?: Readonly<Record<string, string>>;
}

export interface PluginShellRuntime {
  run(options: PluginShellRunOptions, invocation: PluginAgentInvocation): Promise<unknown>;
  read?(ref: string, invocation: PluginAgentInvocation): Promise<unknown>;
  write?(ref: string, input: string, invocation: PluginAgentInvocation): Promise<unknown>;
  stop?(ref: string, invocation: PluginAgentInvocation): Promise<unknown>;
}

/** Streaming, cancellable foreground/background/PTY shell surface. */
export class PluginShellService extends Service {
  private shellRuntime?: PluginShellRuntime;

  constructor(
    ctx: Context,
    private readonly agents: PluginAgentService,
    private readonly shellEnv?: PluginShellEnvService,
  ) {
    super(ctx, 'shell');
  }

  bindRuntime(runtime: PluginShellRuntime): Disposable<Promise<void>> {
    if (this.ctx.maka) throw new Error('Only the Host may bind the Shell Runtime');
    if (this.shellRuntime) throw new Error('Plugin Shell Runtime is already bound');
    this.shellRuntime = runtime;
    return this.ctx.effect(
      () => () => {
        if (this.shellRuntime === runtime) this.shellRuntime = undefined;
      },
      'shell.bindRuntime()',
    );
  }

  async run(options: PluginShellRunOptions): Promise<unknown> {
    if (options.environment !== undefined) throw new TypeError('Shell environment is Host-managed');
    const invocation = this.agents.requireInvocation();
    const environment = await this.shellEnv?.collect(invocation);
    return this.runtime().run(
      environment && Object.keys(environment).length > 0 ? { ...options, environment } : options,
      invocation,
    );
  }

  read(ref: string): Promise<unknown> {
    const invocation = this.agents.requireInvocation();
    const read = this.runtime().read;
    if (!read) throw new Error('Shell resource reads are unavailable');
    return read(ref, invocation);
  }

  write(ref: string, input: string): Promise<unknown> {
    const invocation = this.agents.requireInvocation();
    const write = this.runtime().write;
    if (!write) throw new Error('Shell PTY input is unavailable');
    return write(ref, input, invocation);
  }

  stop(ref: string): Promise<unknown> {
    const invocation = this.agents.requireInvocation();
    const stop = this.runtime().stop;
    if (!stop) throw new Error('Shell process cancellation is unavailable');
    return stop(ref, invocation);
  }

  private runtime(): PluginShellRuntime {
    if (!this.shellRuntime) throw new Error('Plugin Shell Runtime is unavailable');
    return this.shellRuntime;
  }
}

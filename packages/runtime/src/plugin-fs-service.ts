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
    readonly fs: PluginFilesystemService;
  }
}

export type PluginFilesystemOperation =
  | {
      readonly kind: 'read';
      readonly path: string;
      readonly offset?: number;
      readonly limit?: number;
    }
  | { readonly kind: 'write'; readonly path: string; readonly content: string }
  | {
      readonly kind: 'edit';
      readonly path: string;
      readonly oldString: string;
      readonly newString: string;
    }
  | {
      readonly kind: 'glob';
      readonly path?: string;
      readonly pattern: string;
      readonly limit?: number;
    }
  | {
      readonly kind: 'grep';
      readonly path?: string;
      readonly pattern: string;
      readonly glob?: string;
      readonly maxCountPerFile?: number;
      readonly limit?: number;
      readonly timeoutMs?: number;
    }
  | { readonly kind: 'apply_patch'; readonly patch: string };

export interface PluginFilesystemRuntime {
  execute(
    operation: PluginFilesystemOperation,
    invocation: PluginAgentInvocation,
  ): Promise<unknown>;
}

/** Full-fidelity filesystem entry point bound to Maka's canonical workspace authority. */
export class PluginFilesystemService extends Service {
  private filesystemRuntime?: PluginFilesystemRuntime;

  constructor(
    ctx: Context,
    private readonly agents: PluginAgentService,
  ) {
    super(ctx, 'fs');
  }

  bindRuntime(runtime: PluginFilesystemRuntime): Disposable<Promise<void>> {
    if (this.ctx.maka) throw new Error('Only the Host may bind the Filesystem Runtime');
    if (this.filesystemRuntime) throw new Error('Plugin Filesystem Runtime is already bound');
    this.filesystemRuntime = runtime;
    return this.ctx.effect(
      () => () => {
        if (this.filesystemRuntime === runtime) this.filesystemRuntime = undefined;
      },
      'fs.bindRuntime()',
    );
  }

  execute(operation: PluginFilesystemOperation): Promise<unknown> {
    if (!this.filesystemRuntime) throw new Error('Plugin Filesystem Runtime is unavailable');
    return this.filesystemRuntime.execute(operation, this.agents.requireInvocation());
  }

  read(path: string, options: { readonly offset?: number; readonly limit?: number } = {}) {
    return this.execute({ kind: 'read', path, ...options });
  }

  write(path: string, content: string) {
    return this.execute({ kind: 'write', path, content });
  }

  edit(path: string, oldString: string, newString: string) {
    return this.execute({ kind: 'edit', path, oldString, newString });
  }

  glob(pattern: string, options: { readonly path?: string; readonly limit?: number } = {}) {
    return this.execute({ kind: 'glob', pattern, ...options });
  }

  grep(
    pattern: string,
    options: Omit<Extract<PluginFilesystemOperation, { kind: 'grep' }>, 'kind' | 'pattern'> = {},
  ) {
    return this.execute({ kind: 'grep', pattern, ...options });
  }

  applyPatch(patch: string) {
    return this.execute({ kind: 'apply_patch', patch });
  }
}

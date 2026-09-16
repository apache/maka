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

import { Service, type Context } from './plugin-kernel.js';
import { PluginScopeRegistry } from './plugin-scope-registry.js';
import type { PluginAgentInvocation } from './plugin-agent-service.js';
import {
  pluginIdentity,
  registerPluginContribution,
  type MakaContributionIdentity,
  type MakaPluginRootId,
  MakaPluginRuntimeError,
} from './plugin-runtime.js';

declare module './plugin-kernel.js' {
  interface Context {
    readonly shellEnv: PluginShellEnvService;
  }
}

export interface PluginShellEnvVariable {
  readonly description: string;
  readonly sensitive?: boolean;
}
export interface PluginShellEnvContributor {
  readonly name: string;
  readonly variables: Readonly<Record<string, PluginShellEnvVariable>>;
  readonly resolve: (
    invocation: PluginAgentInvocation,
  ) =>
    | Readonly<Record<string, string | undefined>>
    | Promise<Readonly<Record<string, string | undefined>>>;
}
interface RegisteredVariable extends MakaContributionIdentity {
  readonly contributor: PluginShellEnvContributor;
  readonly key: string;
  readonly token: symbol;
  retired: boolean;
}

/** Deterministic, declared environment overlay rebuilt for each Shell execution. */
export class PluginShellEnvService extends Service {
  private readonly variables = new PluginScopeRegistry<RegisteredVariable>();
  constructor(ctx: Context) {
    super(ctx, 'shellEnv');
  }

  register(contributor: PluginShellEnvContributor): () => Promise<void> {
    validateContributor(contributor);
    const identity = pluginIdentity(this.ctx);
    if (identity.scopeId === 'desktop-ui')
      throw new MakaPluginRuntimeError(
        'activation_failed',
        'desktop-ui plugins cannot contribute Shell environment',
      );
    return registerPluginContribution(
      this.ctx,
      `shellEnv.register(${JSON.stringify(contributor.name)})`,
      () => {
        const rootId = identity.scopeId as MakaPluginRootId;
        const keys = Object.keys(contributor.variables).sort();
        for (const key of keys) {
          const existing = this.variables.get(rootId, key);
          if (existing && existing.entryId !== identity.entryId)
            throw new MakaPluginRuntimeError(
              'activation_failed',
              `Shell environment key ${JSON.stringify(key)} is already registered by ${existing.entryId}`,
            );
        }
        const disposers = keys.map((key) =>
          this.variables.publish(rootId, key, {
            ...identity,
            contributor,
            key,
            token: Symbol(`${contributor.name}:${key}`),
            retired: false,
          }),
        );
        return async () => {
          await Promise.all(disposers.reverse().map((dispose) => dispose()));
        };
      },
    );
  }

  async collect(invocation: PluginAgentInvocation): Promise<Readonly<Record<string, string>>> {
    const visible = this.variables.visible(invocation.sessionId);
    const contributors = [
      ...new Set([...visible.values()].map(({ contributor }) => contributor)),
    ].sort((a, b) => a.name.localeCompare(b.name));
    const output: Record<string, string> = Object.create(null);
    for (const contributor of contributors) {
      const resolved = await contributor.resolve(invocation);
      for (const [key, value] of Object.entries(resolved)) {
        if (!Object.hasOwn(contributor.variables, key))
          throw new Error(
            `Shell environment contributor ${JSON.stringify(contributor.name)} returned undeclared key ${JSON.stringify(key)}`,
          );
        if (value !== undefined && typeof value !== 'string')
          throw new TypeError(`Shell environment value ${JSON.stringify(key)} must be a string`);
        if (value !== undefined) output[key] = value;
      }
    }
    return Object.freeze(
      Object.fromEntries(
        Object.entries(output).sort(([left], [right]) => left.localeCompare(right)),
      ),
    );
  }
}

function validateContributor(value: PluginShellEnvContributor): void {
  if (!/^[a-z][a-z0-9-]*$/u.test(value.name) || typeof value.resolve !== 'function')
    throw new TypeError('Invalid Shell environment contributor');
  const keys = Object.keys(value.variables);
  if (keys.length === 0)
    throw new TypeError('Shell environment contributor must declare at least one variable');
  for (const key of keys) {
    if (!/^MAKA_PLUGIN_[A-Z][A-Z0-9_]*$/u.test(key))
      throw new TypeError(
        `Plugin Shell environment key is outside the MAKA_PLUGIN_* namespace: ${key}`,
      );
    if (!value.variables[key]!.description.trim())
      throw new TypeError(`Plugin Shell environment key must have a description: ${key}`);
    if (/^(?:PATH|HOME|SHELL|NODE_OPTIONS|LD_|DYLD_)/u.test(key.slice('MAKA_PLUGIN_'.length)))
      throw new TypeError(`Plugin Shell environment key is reserved: ${key}`);
  }
}

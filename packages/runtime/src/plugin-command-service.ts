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
import {
  pluginIdentity,
  registerPluginContribution,
  type MakaContributionIdentity,
  type MakaPluginRootId,
  MakaPluginRuntimeError,
} from './plugin-runtime.js';

declare module './plugin-kernel.js' {
  interface Context {
    readonly commands: PluginCommandService;
  }
}

export interface PluginCommandContext {
  readonly sessionId: string;
  readonly args: readonly string[];
  readonly signal?: AbortSignal;
}
export interface PluginCommandDefinition {
  readonly name: string;
  readonly description: string;
  readonly aliases?: readonly string[];
  readonly execute: (context: PluginCommandContext) => unknown;
}
export interface PluginCommandSummary {
  readonly name: string;
  readonly description: string;
  readonly aliases: readonly string[];
  readonly extensionId: string;
}
export interface PluginCommandInspection extends MakaContributionIdentity {
  readonly name: string;
  readonly description: string;
  readonly aliases: readonly string[];
}
interface RegisteredCommand extends MakaContributionIdentity {
  readonly definition: PluginCommandDefinition;
  readonly token: symbol;
  retired: boolean;
}

/** Scoped interactive command contribution registry. Client surfaces consume summaries only. */
export class PluginCommandService extends Service {
  private readonly registry = new PluginScopeRegistry<RegisteredCommand>();
  constructor(ctx: Context) {
    super(ctx, 'commands');
  }

  register(definition: PluginCommandDefinition): () => Promise<void> {
    validate(definition);
    const identity = pluginIdentity(this.ctx);
    return registerPluginContribution(
      this.ctx,
      `commands.register(${JSON.stringify(definition.name)})`,
      () => {
        const rootId = identity.scopeId as MakaPluginRootId;
        for (const key of keys(definition)) {
          const existing = this.registry.get(rootId, key);
          if (existing && existing.entryId !== identity.entryId)
            throw new MakaPluginRuntimeError(
              'activation_failed',
              `Plugin Command ${JSON.stringify(key)} is already registered by ${existing.entryId}`,
            );
        }
        const entry: RegisteredCommand = {
          ...identity,
          definition: Object.freeze({
            ...definition,
            aliases: Object.freeze([...(definition.aliases ?? [])]),
          }),
          token: Symbol(definition.name),
          retired: false,
        };
        const disposers = keys(definition).map((key) => this.registry.publish(rootId, key, entry));
        return async () => {
          await Promise.all(disposers.reverse().map((dispose) => dispose()));
        };
      },
    );
  }

  list(sessionId: string): readonly PluginCommandSummary[] {
    const visible = this.registry.visible(assertSessionId(sessionId));
    const seen = new Set<RegisteredCommand>();
    return Object.freeze(
      [...visible.values()]
        .filter((entry) => !seen.has(entry) && Boolean(seen.add(entry)))
        .sort((a, b) => a.definition.name.localeCompare(b.definition.name))
        .map(({ definition, extensionId }) =>
          Object.freeze({
            name: definition.name,
            description: definition.description,
            aliases: Object.freeze([...(definition.aliases ?? [])]),
            extensionId,
          }),
        ),
    );
  }

  async execute(name: string, context: PluginCommandContext): Promise<unknown> {
    const entry = this.registry.visible(assertSessionId(context.sessionId)).get(name);
    if (!entry) throw new Error(`Plugin Command is unavailable: ${name}`);
    return await entry.definition.execute(
      Object.freeze({ ...context, args: Object.freeze([...context.args]) }),
    );
  }

  inspect(rootId?: MakaPluginRootId): readonly PluginCommandInspection[] {
    const seen = new Set<RegisteredCommand>();
    return Object.freeze(
      [...this.registry.entries(rootId)]
        .filter((entry) => !seen.has(entry) && Boolean(seen.add(entry)))
        .sort((a, b) => a.definition.name.localeCompare(b.definition.name))
        .map(({ definition, token: _token, retired: _retired, ...identity }) =>
          Object.freeze({
            ...identity,
            name: definition.name,
            description: definition.description,
            aliases: Object.freeze([...(definition.aliases ?? [])]),
          }),
        ),
    );
  }
}

function keys(definition: PluginCommandDefinition): readonly string[] {
  return Object.freeze([definition.name, ...(definition.aliases ?? [])]);
}
function validate(definition: PluginCommandDefinition): void {
  const all = keys(definition);
  if (!definition.description.trim() || typeof definition.execute !== 'function')
    throw new TypeError('Plugin Command description and execute are required');
  if (
    new Set(all).size !== all.length ||
    all.some((name) => !/^[a-z][a-z0-9]*(?:[-_:][a-z0-9]+)*$/u.test(name))
  )
    throw new TypeError('Plugin Command names and aliases are invalid');
}
function assertSessionId(value: string): string {
  if (!value || /[\0\r\n]/u.test(value)) throw new TypeError('Session id is invalid');
  return value;
}

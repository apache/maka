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
import {
  MakaPluginRuntimeError,
  pluginIdentity,
  registerPluginContribution,
  type MakaContributionIdentity,
  type MakaPluginRootId,
} from './plugin-runtime.js';
import type { MakaTool } from './tool-runtime.js';

declare module './plugin-kernel.js' {
  interface Context {
    readonly tools: PluginToolService;
  }
}

interface RegisteredPluginTool extends MakaContributionIdentity {
  readonly definition: MakaTool;
  readonly exposed: MakaTool;
  readonly token: symbol;
  activeCalls: number;
  retired: boolean;
  readonly drainWaiters: Set<() => void>;
}

export interface PluginToolInspection extends MakaContributionIdentity {
  readonly toolName: string;
  readonly activeCalls: number;
  readonly retired: boolean;
}

export interface ResolvedPluginTools {
  readonly tools: readonly MakaTool[];
}

export interface PluginToolServiceOptions {
  readonly onChanged?: (rootId: MakaPluginRootId) => void;
}

/**
 * Context-scoped Tool contribution registry for trusted Host plugins.
 *
 * Registration is staged by the Plugin Platform transaction and owned by the
 * registering Fiber. Profile registrations are inherited by Session roots;
 * an exact Session registration shadows the Profile registration. Core tools
 * remain Host-owned and cannot be shadowed.
 */
export class PluginToolService extends Service {
  private readonly layers = new Map<MakaPluginRootId, Map<string, RegisteredPluginTool>>();
  private readonly onChanged?: (rootId: MakaPluginRootId) => void;

  constructor(ctx: Context, options: PluginToolServiceOptions = {}) {
    super(ctx, 'tools');
    this.onChanged = options.onChanged;
  }

  register(definition: MakaTool): () => Promise<void> {
    const identity = pluginIdentity(this.ctx);
    if (identity.scopeId === 'desktop-ui') {
      throw new MakaPluginRuntimeError(
        'activation_failed',
        'desktop-ui plugins cannot register Host tools',
      );
    }
    validateTool(definition);
    return registerPluginContribution(
      this.ctx,
      `tools.register(${JSON.stringify(definition.name)})`,
      () => this.publish(identity, definition),
    );
  }

  resolve(sessionId: string, coreTools: readonly MakaTool[]): ResolvedPluginTools {
    if (!sessionId || /[\r\n\0]/u.test(sessionId)) throw new Error('Invalid Tool Session scope');
    const visible = new Map<string, RegisteredPluginTool>();
    for (const entry of this.layers.get('profile')?.values() ?? []) {
      visible.set(entry.definition.name, entry);
    }
    const sessionRoot = `session:${sessionId}` as const;
    for (const entry of this.layers.get(sessionRoot)?.values() ?? []) {
      visible.set(entry.definition.name, entry);
    }

    const coreNames = new Set(coreTools.map(({ name }) => name));
    for (const name of visible.keys()) {
      if (coreNames.has(name)) {
        throw new MakaPluginRuntimeError(
          'activation_failed',
          `Plugin Tool ${JSON.stringify(name)} conflicts with a Host-owned Tool`,
        );
      }
    }
    const entries = [...visible.values()].sort(compareRegistration);
    return Object.freeze({
      tools: Object.freeze([...coreTools, ...entries.map(({ exposed }) => exposed)]),
    });
  }

  inspect(rootId?: MakaPluginRootId): readonly PluginToolInspection[] {
    const layers = rootId
      ? [[rootId, this.layers.get(rootId)] as const]
      : [...this.layers.entries()];
    return Object.freeze(
      layers
        .flatMap(([, layer]) => [...(layer?.values() ?? [])])
        .sort(compareRegistration)
        .map((entry) =>
          Object.freeze({
            entryId: entry.entryId,
            scopeId: entry.scopeId,
            extensionId: entry.extensionId,
            generation: entry.generation,
            toolName: entry.definition.name,
            activeCalls: entry.activeCalls,
            retired: entry.retired,
          }),
        ),
    );
  }

  private publish(identity: MakaContributionIdentity, definition: MakaTool): () => Promise<void> {
    const rootId = identity.scopeId as MakaPluginRootId;
    let layer = this.layers.get(rootId);
    if (!layer) {
      layer = new Map();
      this.layers.set(rootId, layer);
    }
    const existing = layer.get(definition.name);
    if (existing && existing.entryId !== identity.entryId) {
      throw new MakaPluginRuntimeError(
        'activation_failed',
        `Plugin Tool ${JSON.stringify(definition.name)} is already registered by ${existing.entryId}`,
      );
    }
    let entry!: RegisteredPluginTool;
    const exposed: MakaTool = Object.freeze({
      ...definition,
      impl: async (args, context) => {
        if (entry.retired) {
          throw new Error(`Plugin Tool ${JSON.stringify(definition.name)} is no longer active`);
        }
        entry.activeCalls += 1;
        try {
          return await definition.impl(args, context);
        } finally {
          entry.activeCalls -= 1;
          if (entry.activeCalls === 0) {
            for (const resolve of entry.drainWaiters) resolve();
            entry.drainWaiters.clear();
          }
        }
      },
    });
    entry = {
      ...identity,
      definition,
      exposed,
      token: Symbol(definition.name),
      activeCalls: 0,
      retired: false,
      drainWaiters: new Set(),
    };
    layer.set(definition.name, entry);
    try {
      this.notifyChanged(rootId);
    } catch (error) {
      if (existing) layer.set(definition.name, existing);
      else layer.delete(definition.name);
      if (layer.size === 0) this.layers.delete(rootId);
      throw error;
    }

    return async () => {
      entry.retired = true;
      const currentLayer = this.layers.get(rootId);
      if (currentLayer?.get(definition.name)?.token === entry.token) {
        if (existing && !existing.retired) currentLayer.set(definition.name, existing);
        else currentLayer.delete(definition.name);
        if (currentLayer.size === 0) this.layers.delete(rootId);
        this.notifyChanged(rootId);
      }
      if (entry.activeCalls > 0) {
        await new Promise<void>((resolve) => entry.drainWaiters.add(resolve));
      }
    };
  }

  private notifyChanged(rootId: MakaPluginRootId): void {
    this.ctx.emit('tools/change');
    this.onChanged?.(rootId);
  }
}

function validateTool(tool: MakaTool): void {
  if (!tool || typeof tool !== 'object') throw new TypeError('Tool definition is required');
  if (
    typeof tool.name !== 'string' ||
    tool.name.length === 0 ||
    tool.name.length > 128 ||
    /[\r\n\0]/u.test(tool.name)
  ) {
    throw new TypeError('Tool requires a valid name');
  }
  if (typeof tool.description !== 'string' || typeof tool.impl !== 'function') {
    throw new TypeError(
      `Tool ${JSON.stringify(tool.name)} requires a description and implementation`,
    );
  }
  if (tool.parameters === undefined) {
    throw new TypeError(`Tool ${JSON.stringify(tool.name)} requires an input schema`);
  }
  if (tool.providerTool) {
    throw new TypeError(
      `Plugin Tool ${JSON.stringify(tool.name)} cannot claim a provider protocol`,
    );
  }
}

function compareRegistration(left: RegisteredPluginTool, right: RegisteredPluginTool): number {
  return (
    left.definition.name.localeCompare(right.definition.name) ||
    left.scopeId.localeCompare(right.scopeId) ||
    left.entryId.localeCompare(right.entryId)
  );
}

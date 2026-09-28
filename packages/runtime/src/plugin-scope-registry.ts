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

import type { Awaitable, Disposable } from './plugin-kernel.js';
import type { MakaPluginRootId } from './plugin-runtime.js';

export interface PluginScopeRegistryEntry {
  readonly token: symbol;
  retired: boolean;
}

export interface PluginScopePublicationHooks<T extends PluginScopeRegistryEntry> {
  /** Runs after visible membership changes. Throwing rolls publication back. */
  readonly onChanged?: (rootId: MakaPluginRootId) => void;
  /** Runs after retirement is no longer visible, for capability-specific draining. */
  readonly onRetired?: (entry: T) => Awaitable<void>;
}

/**
 * Shared Profile/Session membership and replacement semantics for typed Plugin
 * capabilities. Capability services retain validation and value-specific
 * behavior; this registry only answers which keyed contribution is visible.
 */
export class PluginScopeRegistry<T extends PluginScopeRegistryEntry> {
  readonly #layers = new Map<MakaPluginRootId, Map<string, T>>();

  get(rootId: MakaPluginRootId, key: string): T | undefined {
    return this.#layers.get(rootId)?.get(key);
  }

  /** Snapshot Profile membership overlaid by an exact Session layer. */
  visible(sessionId: string): ReadonlyMap<string, T> {
    if (!sessionId || /[\r\n\0]/u.test(sessionId)) {
      throw new Error('Invalid Plugin Session scope');
    }
    const visible = new Map<string, T>(this.#layers.get('profile'));
    for (const [key, entry] of this.#layers.get(`session:${sessionId}`) ?? []) {
      visible.set(key, entry);
    }
    return visible;
  }

  entries(rootId?: MakaPluginRootId): readonly T[] {
    return Object.freeze(
      rootId
        ? [...(this.#layers.get(rootId)?.values() ?? [])]
        : [...this.#layers.values()].flatMap((layer) => [...layer.values()]),
    );
  }

  /**
   * Atomically publishes one keyed contribution. A same-key predecessor is
   * restored only when still live, which supports candidate rollback without
   * resurrecting a successfully retired generation.
   */
  publish(
    rootId: MakaPluginRootId,
    key: string,
    entry: T,
    hooks: PluginScopePublicationHooks<T> = {},
  ): Disposable<Promise<void>> {
    let layer = this.#layers.get(rootId);
    if (!layer) {
      layer = new Map();
      this.#layers.set(rootId, layer);
    }
    const previous = layer.get(key);
    layer.set(key, entry);
    try {
      hooks.onChanged?.(rootId);
    } catch (error) {
      if (previous) layer.set(key, previous);
      else layer.delete(key);
      this.#prune(rootId);
      throw error;
    }

    let disposed = false;
    return async () => {
      if (disposed) return;
      disposed = true;
      entry.retired = true;
      const currentLayer = this.#layers.get(rootId);
      if (currentLayer?.get(key)?.token === entry.token) {
        if (previous && !previous.retired) currentLayer.set(key, previous);
        else currentLayer.delete(key);
        this.#prune(rootId);
        hooks.onChanged?.(rootId);
      }
      await hooks.onRetired?.(entry);
    };
  }

  #prune(rootId: MakaPluginRootId): void {
    if (this.#layers.get(rootId)?.size === 0) this.#layers.delete(rootId);
  }
}

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

/**
 * Dev-server cache hygiene (issue #4775).
 *
 * Vite serves optimized deps as `Cache-Control: immutable` keyed by per-dep
 * `?v=` browserHash labels, and the optimizer preserves a dep's label across
 * re-optimization commits — including ones where the dep's bundle bytes
 * changed (Vite upgrade, patch re-application, interrupted commit). The
 * persistent session cache then resurrects a previous generation's
 * react/react-dom chunk graph next to freshly transformed sources that import
 * today's react copy: two React instances in one page, a null hook
 * dispatcher, and `Cannot read properties of null (reading 'useRef')`
 * killing the renderer on the first lazily loaded component.
 *
 * Clearing the HTTP cache before loading the dev server keeps every dev
 * session on exactly one optimizer generation. Packaged builds load file://
 * and never touch this path; localStorage/cookies are not part of the HTTP
 * cache and survive.
 *
 * Structural interfaces instead of `electron` imports: the module stays
 * loadable in plain node tests (same pattern as main-renderer-loader.ts).
 */
export interface DevRendererCacheSession {
  clearCache(): Promise<void>;
}

export interface DevRendererCacheEntry {
  readonly useDevServer: boolean;
}

/**
 * Clears the renderer session's HTTP cache when — and only when — the window
 * is about to load a Vite dev server. Returns whether the cache was cleared.
 * A clearCache failure downgrades to a warning: the duplicate-React crash it
 * guards against is recoverable by reload, but a window that never opens is
 * not.
 */
export async function clearDevRendererHttpCache(
  session: DevRendererCacheSession,
  rendererEntry: DevRendererCacheEntry,
): Promise<boolean> {
  if (!rendererEntry.useDevServer) return false;
  try {
    await session.clearCache();
    return true;
  } catch (error) {
    console.warn('[main] failed to clear dev renderer HTTP cache:', error);
    return false;
  }
}

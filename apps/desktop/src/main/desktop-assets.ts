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

import { join } from 'node:path';

/**
 * Root that `apps/desktop/assets` hangs off at runtime.
 *
 * Dev resolves the repo layout: two levels up from the built main bundle in
 * `dist/main/` lands on `apps/desktop`. A packaged app has no such tree —
 * `files` in the builder config carries `dist/`, `dist-renderer/` and
 * `package.json`, and nothing else — so the assets ride along as an extra
 * resource and the same segments hang off `process.resourcesPath` instead.
 *
 * Resolving the dev path in a packaged build fails silently: Electron reports
 * an unreadable file as an EMPTY NativeImage rather than as an error, and the
 * BrowserWindow `icon` option simply draws nothing.
 */
export function desktopAssetRoot(runtime: {
  readonly isPackaged: boolean;
  readonly resourcesPath: string;
}): string {
  return runtime.isPackaged ? runtime.resourcesPath : join(import.meta.dirname, '..', '..');
}

export function desktopAssetPath(
  runtime: { readonly isPackaged: boolean; readonly resourcesPath: string },
  ...segments: readonly string[]
): string {
  return join(desktopAssetRoot(runtime), ...segments);
}

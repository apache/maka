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

import type { AppSettings } from '@maka/core/settings';
import { isToolMode, type ToolMode } from '@maka/core/tool-mode';

/**
 * The single resolution point for the chat-defaults tool-mode preference: the
 * stored preference becomes either an explicit Runtime `ToolMode` or field
 * omission. `auto`, a missing value, and anything unrecognized all resolve to
 * omission — the Runtime then applies its own default (Direct), exactly as it
 * did before this preference existed, so an unset preference produces
 * byte-identical turn payloads. `auto` itself never crosses the boundary.
 */
export function resolveTurnToolMode(preference: unknown): ToolMode | undefined {
  return isToolMode(preference) ? preference : undefined;
}

/** Read the configured chat-defaults tool-mode preference; fall back to no
 *  override if settings cannot be read (so sending never fails on an
 *  unavailable Runtime Host policy). Injected so the fallback is unit-testable.
 */
export async function resolveDefaultToolMode(
  readSettings: () => Promise<Pick<AppSettings, 'chatDefaults'>>,
): Promise<ToolMode | undefined> {
  try {
    return resolveTurnToolMode((await readSettings()).chatDefaults.toolModePreference);
  } catch {
    return undefined;
  }
}

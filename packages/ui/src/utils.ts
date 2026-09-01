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

import { clsx, type ClassValue } from 'clsx';

export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs);
}

/**
 * Plain shortcut display strings cannot lean on the design-system Kbd,
 * whose `mod` token is already platform-aware (⌘ on Apple platforms, Ctrl
 * elsewhere). Detect Apple platforms with the same navigator.platform
 * fallback Kbd uses so hand-built hint strings agree with Kbd output
 * rendered beside them.
 */
export function isAppleShortcutPlatform(platform: string | null | undefined): boolean {
  return /mac|iphone|ipad|ipod/i.test(platform ?? '');
}

/** Prefer Chromium's current platform authority, falling back for older engines. */
export function preferredShortcutPlatform(
  userAgentDataPlatform: string | null | undefined,
  legacyPlatform: string | null | undefined,
): string {
  const modern = userAgentDataPlatform?.trim();
  return modern || legacyPlatform?.trim() || '';
}

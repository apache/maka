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
 * URL-scheme whitelist for the renderer's external-link guard. Used by both
 * `setWindowOpenHandler` and `will-navigate` to decide which URLs should be
 * handed off to the OS via `shell.openExternal`.
 *
 * Explicitly *not* allowed:
 *   - `file://`  — would let untrusted markdown reach the local filesystem
 *   - `javascript:` — XSS vector
 *   - `electron:` / `chrome-extension:` — internal schemes
 *   - everything else parsed by URL but not in the allow set
 *
 * Allowed:
 *   - http / https — external web
 *   - mailto — system mail client
 */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

export function isExternalUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ALLOWED_PROTOCOLS.has(parsed.protocol);
  } catch {
    return false;
  }
}

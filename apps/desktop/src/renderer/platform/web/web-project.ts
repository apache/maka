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
 * Web-mode (Chrome/Brave via `maka-web`) detection + typed directory picker.
 *
 * In Electron `window.maka` is injected by the preload; in a plain browser
 * it is absent. `isWebMode()` is that check plus an optional `?webmode=1`
 * override. Web mode keeps the typed directory picker, validated against
 * the local `maka-web` API (`apps/desktop/scripts/maka-web-api.mjs`). The
 * full client authenticates with a session cookie, not a URL token.
 */

export function isWebMode(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get('webmode') === '1') return true;
  } catch {
    // Non-URL contexts (tests) fall through to the preload check.
  }
  return !(window as unknown as { maka?: unknown }).maka;
}

/** Preselected project from `maka-web --project /path` (`?project=`). */
export function webPreselectedProject(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    const value = new URLSearchParams(window.location.search).get('project');
    return value?.trim() ? value.trim() : undefined;
  } catch {
    return undefined;
  }
}

export type WebPathResolution =
  | { ok: true; path: string }
  | { ok: false; reason: 'invalid-path' | 'not-found' | 'not-a-directory' | 'unreachable' };

export type WebApiStatus =
  | { ok: true; state: 'connected'; via: string }
  | { ok: false; state: 'checking' | 'unreachable' };

/**
 * Where the local `maka-web` API may live. Same-origin first: the vite dev
 * server proxies `/api` to it (see vite.config.ts), so no extra origin is
 * needed. Direct loopback ports are a best-effort fallback (the renderer
 * entry CSP pins `connect-src 'self'`, so they only work where that policy
 * is relaxed).
 */
function webApiBases(): string[] {
  return ['', 'http://127.0.0.1:5174', 'http://127.0.0.1:5175'];
}

async function fetchJson(base: string, path: string, init?: RequestInit): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    const res = await fetch(`${base}${path}`, { ...init, signal: controller.signal });
    if (!res.ok) throw new Error(`http-${res.status}`);
    return (await res.json()) as unknown;
  } finally {
    clearTimeout(timer);
  }
}

/** Probe the local API; `checking` is only the initial state for the UI. */
export async function checkWebApiHealth(): Promise<Exclude<WebApiStatus, { state: 'checking' }>> {
  for (const base of webApiBases()) {
    try {
      const data = (await fetchJson(base, '/api/health')) as { ok?: boolean };
      if (data?.ok) return { ok: true, state: 'connected', via: base || 'same-origin' };
    } catch {
      // Try the next base.
    }
  }
  return { ok: false, state: 'unreachable' };
}

/**
 * Validate a typed server-local directory via the `maka-web` API.
 * Returns `unreachable` when the launcher/API is not running so the caller
 * can hint `npm run web` instead of showing a misleading "not found".
 */
export async function resolveWebProjectPath(input: string): Promise<WebPathResolution> {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, reason: 'invalid-path' };
  let lastError: WebPathResolution = { ok: false, reason: 'unreachable' };
  for (const base of webApiBases()) {
    try {
      const data = (await fetchJson(base, '/api/paths/resolve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: trimmed }),
      })) as WebPathResolution;
      if (data.ok || data.reason !== 'unreachable') return data;
      lastError = data;
    } catch {
      lastError = { ok: false, reason: 'unreachable' };
    }
  }
  return lastError;
}

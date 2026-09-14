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

import type { MakaBridge } from '../../../preload/bridge-contract.js';

/**
 * Full-client boot for `maka-web` (Chrome/Brave): connect the tunneled
 * `ipcRenderer`, then execute the REAL preload bridge source so `window.maka`
 * is the identical object the Electron renderer gets — same channels, same
 * scope validation, same subscriptions. The desktop boot path (`bootDesktop`
 * in main.tsx) then runs unchanged.
 */

export interface WebBridgeParams {
  /**
   * Where to dial. Relative same-origin path (`/bridge`) is preferred: it
   * satisfies the pinned entry CSP. Absolute loopback URLs only work where
   * that policy is relaxed. Auth is the session cookie, not a query token.
   */
  bridge: string;
  /** Unused: the gateway injects the disk token on the loopback hop. */
  token: string;
}

export function webBridgeParams(): WebBridgeParams | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    const params = new URLSearchParams(window.location.search);
    const bridge = params.get('bridge')?.trim() || '/bridge';
    if (params.get('webmode') !== '1' && !params.get('bridge')) {
      return { bridge: '/bridge', token: '' };
    }
    if (bridge.startsWith('/')) return { bridge, token: '' };
    const url = new URL(bridge);
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return undefined;
    if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') return undefined;
    return { bridge: url.href, token: '' };
  } catch {
    return undefined;
  }
}

function socketUrl(bridge: string, _token: string): string {
  const url = bridge.startsWith('/') ? new URL(bridge, window.location.href) : new URL(bridge);
  if (url.protocol === 'https:') url.protocol = 'wss:';
  else if (url.protocol === 'http:') url.protocol = 'ws:';
  url.searchParams.delete('token');
  return url.href;
}

export async function bootWebBridge(params: WebBridgeParams): Promise<MakaBridge> {
  const { ipcRenderer } = await import('./electron-shim.js');
  await ipcRenderer.connect(socketUrl(params.bridge, params.token));
  // Executes the preload source: `contextBridge.exposeInMainWorld('maka', …)`
  // lands on `window` through the shim. Imported lazily so the Electron
  // renderer never pays for (or executes) this module graph.
  await import('../../../preload/preload.js');
  const bridge = (window as unknown as { maka?: MakaBridge }).maka;
  if (!bridge) throw new Error('Web bridge connected, but the preload bridge did not expose itself.');
  return bridge;
}

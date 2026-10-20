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

import type { DesktopRuntimeHostClient } from './runtime-host-client.js';
import type { WebContents } from 'electron';
import { readWithFallback, type ReconnectableReadIpcMain } from './ipc-reconnect-policy.js';

/**
 * `search:recall` — one Host's answer to a recall query.
 *
 * The scan happens inside the Host (see `recall.query`), so this handler does
 * no retrieval of its own: it forwards the request, bounds the wait, and relays
 * the envelope. Fan-out across Hosts and merging belong to the renderer's
 * search client, which is the only layer that knows how many Hosts there are.
 *
 * Cancellation is best-effort. The Host owns the scan; dropping our side of an
 * abandoned request stops us waiting on it, and the pending map is per-renderer
 * so a replacement window cannot inherit a stale entry.
 */
interface RuntimeHostRecallIpcDeps {
  readonly ipcMain: ReconnectableReadIpcMain;
  readonly client: Pick<DesktopRuntimeHostClient, 'queryRecall'>;
}

export function registerRuntimeHostRecallIpc(deps: RuntimeHostRecallIpcDeps): void {
  const pending = new WeakMap<WebContents, Map<string, AbortController>>();

  deps.ipcMain.handle(
    'search:recall',
    async (event, request: unknown, requestId?: unknown): Promise<unknown> => {
      if (
        requestId !== undefined &&
        (typeof requestId !== 'string' || !requestId || requestId.length > 128)
      ) {
        return { ok: false, reason: 'invalid_query', message: 'Invalid search request identity.' };
      }
      const controller = new AbortController();
      const release = () => {
        event.sender?.removeListener('destroyed', abort);
        event.sender?.removeListener('render-process-gone', abort);
        if (typeof requestId === 'string') {
          const requests = pending.get(event.sender);
          if (requests?.get(requestId) === controller) requests.delete(requestId);
        }
      };
      const abort = () => controller.abort();
      if (typeof requestId === 'string') {
        let requests = pending.get(event.sender);
        if (!requests) {
          requests = new Map();
          pending.set(event.sender, requests);
        }
        requests.get(requestId)?.abort();
        requests.set(requestId, controller);
      }
      controller.signal.addEventListener('abort', release, { once: true });
      event.sender?.once('destroyed', abort);
      // Crash recovery reloads the same WebContents without destroying it.
      event.sender?.once('render-process-gone', abort);
      // Cancellation must end this call, not merely mark a boolean. The Host
      // owns the scan and may take as long as it likes to answer; without
      // racing it, a cancelled search would hold the IPC channel open until
      // the Host replied to a question nobody is waiting for.
      const cancelled = new Promise<{ ok: false; reason: string; message: string }>((resolve) => {
        const settle = () =>
          resolve({ ok: false, reason: 'aborted', message: 'History search was aborted.' });
        if (controller.signal.aborted) settle();
        else controller.signal.addEventListener('abort', settle, { once: true });
      });
      try {
        // The payload crossed an IPC boundary, so it is untrusted in shape;
        // the Host decodes it and answers with a typed refusal rather than
        // trusting anything the renderer sent.
        //
        // The read keeps its own failure semantics: `readWithFallback` answers
        // `null` for an ordinary Host failure and rethrows a failure the
        // reconnect policy owns. Racing it against cancellation must not
        // hide that, so the rejection is re-raised after the race.
        const read = readWithFallback(
          () => deps.client.queryRecall(request as never),
          null,
        );
        // A rejection leaving the race unobserved would surface as an
        // unhandled rejection; attach a no-op handler purely to mark it seen.
        read.catch(() => undefined);
        const result = await Promise.race([read, cancelled]);
        if (controller.signal.aborted) {
          return { ok: false, reason: 'aborted', message: 'History search was aborted.' };
        }
        if (result === null) {
          return {
            ok: false,
            reason: 'provider_error',
            message: 'Runtime Host is unavailable for search',
          };
        }
        return result;
      } finally {
        controller.signal.removeEventListener('abort', release);
        release();
      }
    },
  );

  // Register after search so requests waiting for a candidate start before
  // their queued cancellations are delivered.
  deps.ipcMain.handle('search:recall:cancel', (event, requestId: unknown) => {
    if (typeof requestId === 'string') pending.get(event.sender)?.get(requestId)?.abort();
  });
}

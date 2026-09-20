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

import type { SearchResult } from '@maka/core/search';
import { runThreadSearch, ThreadSearchReadError, type ThreadSearchMessagePage } from '@maka/core/thread-search';
import { SESSION_TRANSCRIPT_PAGE_MAX_BYTES } from '@maka/runtime-host/protocol';
import type { DesktopRuntimeHostClient } from './runtime-host-client.js';
import type { WebContents } from 'electron';
import { DESKTOP_TRANSCRIPT_MESSAGE_MAX_BYTES } from '../preload/transcript-contract.js';
import { toDesktopHostSessionSummary } from './runtime-host-session-catalog-ipc-main.js';
import {
  rethrowReconnectableReadFailure,
  type ReconnectableReadIpcMain,
} from './ipc-reconnect-policy.js';

interface RuntimeHostSearchIpcDeps {
  readonly ipcMain: ReconnectableReadIpcMain;
  readonly client: Pick<
    DesktopRuntimeHostClient,
    'listSessions' | 'openSession' | 'queryRuntimePolicy'
  >;
}

export function registerRuntimeHostSearchIpc(
  deps: RuntimeHostSearchIpcDeps,
): void {
  const pending = new WeakMap<WebContents, Map<string, AbortController>>();
  // A search belongs to this candidate and its cancellation registry. Replaying
  // it on a replacement would revive work the renderer has already abandoned.
  deps.ipcMain.handle('search:thread', async (event, request: unknown, requestId?: unknown) => {
    if (requestId !== undefined && (typeof requestId !== 'string' || !requestId || requestId.length > 128)) {
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
    try {
      const result = await runThreadSearch(request, {
        listSessions: async () =>
          (await deps.client.listSessions()).map(toDesktopHostSessionSummary),
        readMessagePages: (sessionId, signal) => readSearchMessagePages(deps.client, sessionId, signal),
        getPrivacyContext: async () => ({
          incognitoActive: (await deps.client.queryRuntimePolicy()).policy.privacy
            .incognitoActive,
        }),
      }, { abortSignal: controller.signal });
      return result.ok ? result.results.map(projectDesktopSearchResult) : result;
    } catch (error) {
      if (!controller.signal.aborted) throw error;
      return { ok: false, reason: 'aborted', message: 'History search was aborted.' };
    } finally {
      controller.signal.removeEventListener('abort', release);
      release();
    }
  });
  // Register after search so requests waiting for a candidate start before
  // their queued cancellations are delivered.
  deps.ipcMain.handle('search:thread:cancel', (event, requestId: unknown) => {
    if (typeof requestId === 'string') pending.get(event.sender)?.get(requestId)?.abort();
  });
}

async function* readSearchMessagePages(
  client: Pick<DesktopRuntimeHostClient, 'openSession'>,
  sessionId: string,
  signal?: AbortSignal,
): AsyncGenerator<ThreadSearchMessagePage> {
  try {
    if (signal?.aborted) return;
    const session = await client.openSession(sessionId);
    // Only this search owns the handle. Closing also stops a fragment
    // continuation after its in-flight reply, before another page is requested.
    let closeTask: Promise<void> | undefined;
    const close = () => (closeTask ??= session.close());
    const cancelRead = () => { void close().catch(() => undefined); };
    signal?.addEventListener('abort', cancelRead, { once: true });
    try {
      if (signal?.aborted) return;
      const bootstrap = session.transcriptBootstrap.durable;
      const readPage = (cursor: string | null) => session.loadTranscriptPage({
        direction: 'newer', throughSequence: bootstrap.throughSequence,
        cursor, anchorSequence: null, maxBytes: SESSION_TRANSCRIPT_PAGE_MAX_BYTES,
      });
      // A complete bootstrap already contains the whole small transcript.
      // Otherwise start at the oldest message, with the opening watermark.
      let cursor: string | null = null;
      let page = bootstrap.nextCursor === null ? bootstrap : await readPage(cursor);
      let lastSequence = -1;
      for (;;) {
        if (signal?.aborted) return;
        const decoded = await session.decodeTranscriptPage(page, DESKTOP_TRANSCRIPT_MESSAGE_MAX_BYTES);
        if (signal?.aborted) return;
        const messages = decoded.messages.map(({ identity, message }) => {
          if (identity <= lastSequence) throw new Error('Search transcript sequence did not advance');
          lastSequence = identity;
          return { sequence: identity, message };
        });
        if (decoded.nextCursor !== null && (messages.length === 0 || decoded.nextCursor === cursor)) {
          throw new Error('Search transcript cursor did not advance');
        }
        yield { messages, hasMore: decoded.nextCursor !== null };
        if (decoded.nextCursor === null || signal?.aborted) return;
        cursor = decoded.nextCursor;
        page = await readPage(cursor);
      }
    } finally {
      signal?.removeEventListener('abort', cancelRead);
      await close();
    }
  } catch (error) {
    rethrowReconnectableReadFailure(error);
    throw new ThreadSearchReadError('Session transcript could not be read.', { cause: error });
  }
}

function projectDesktopSearchResult(result: SearchResult): SearchResult {
  if (!result.target) return result;
  return {
    ...result,
    target: {
      kind: result.target.kind,
      sessionId: result.target.sessionId,
      ...(result.target.turnId !== undefined ? { turnId: result.target.turnId } : {}),
      ...(result.target.sequence !== undefined ? { sequence: result.target.sequence } : {}),
    },
  };
}

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

import type { Event, IpcMain, IpcMainInvokeEvent } from 'electron';
import type {
  CommandCodeBrowserLoginController,
  CommandCodeBrowserLoginResult,
  CommandCodeBrowserLoginStartInput,
  CommandCodeBrowserLoginStartResult,
} from './commandcode-browser-login.js';

/** Channel names; the preload spells them as literals, as it does for every bridge. */
export const COMMANDCODE_LOGIN_IPC_CHANNELS = {
  start: 'commandcode-login:start',
  complete: 'commandcode-login:complete',
  cancel: 'commandcode-login:cancel',
} as const;

/**
 * Desktop-local IPC for the browser-assisted Command Code sign-in. Not
 * Host-scoped: the loopback listener lives beside the browser, and the key it
 * yields goes through the ordinary `connections:*` path afterwards.
 */
export interface CommandCodeLoginIpcDeps {
  readonly ipcMain: Pick<IpcMain, 'handle'>;
  readonly controller: Pick<
    CommandCodeBrowserLoginController,
    'start' | 'complete' | 'cancel' | 'abandonOwner'
  >;
}

const MAX_BASE_URL_CHARS = 2_048;
const MAX_ATTEMPT_ID_CHARS = 128;
/** Chromium's net::ERR_ABORTED: a cancelled load, which commits no error page. */
const NET_ERR_ABORTED = -3;

export function registerCommandCodeLoginIpc(deps: CommandCodeLoginIpcDeps): void {
  // The controller outlives every renderer, and crash recovery and the error
  // boundary both reload the same WebContents without destroying it. A document
  // that goes away mid-login never sends the complete() or cancel() that would
  // release its attempt.
  const observedOwners = new Set<string>();
  const bindOwner = (event: IpcMainInvokeEvent): string => {
    const ownerId = `web-contents:${event.sender.id}`;
    if (!observedOwners.has(ownerId)) {
      observedOwners.add(ownerId);
      // Whichever event comes first detaches them all, so this runs once per
      // observation; the next start, from a recovered renderer or a new
      // document, observes it afresh.
      const abandon = () => {
        observedOwners.delete(ownerId);
        event.sender.removeListener('render-process-gone', abandon);
        event.sender.removeListener('destroyed', abandon);
        event.sender.removeListener('did-frame-navigate', onFrameNavigated);
        event.sender.removeListener('did-fail-provisional-load', onErrorPageCommitted);
        deps.controller.abandonOwner(ownerId);
      };
      // A reload keeps the WebContents, so neither lifecycle event fires; the
      // next main-frame document's commit retires this one. A navigation's start
      // is too early, since will-navigate may block it, and a same-document
      // route commits no document.
      const onFrameNavigated = (
        _event: Event,
        _url: string,
        _httpResponseCode: number,
        _httpStatusText: string,
        isMainFrame: boolean,
      ): void => {
        if (isMainFrame) abandon();
      };
      // A reload that fails, say while the dev server is down, commits an error
      // page instead. A load that is stopped, prevented by will-navigate, or
      // turned into a download keeps the document. Electron 43 reports nothing
      // here for such a load, though its documentation describes this event for
      // one window.stop() cancels, which Chromium fails with net::ERR_ABORTED.
      const onErrorPageCommitted = (
        _event: Event,
        errorCode: number,
        _errorDescription: string,
        _validatedURL: string,
        isMainFrame: boolean,
      ): void => {
        if (isMainFrame && errorCode !== NET_ERR_ABORTED) abandon();
      };
      event.sender.once('render-process-gone', abandon);
      event.sender.once('destroyed', abandon);
      event.sender.on('did-frame-navigate', onFrameNavigated);
      event.sender.on('did-fail-provisional-load', onErrorPageCommitted);
    }
    return ownerId;
  };

  deps.ipcMain.handle(
    COMMANDCODE_LOGIN_IPC_CHANNELS.start,
    (event, raw: unknown): Promise<CommandCodeBrowserLoginStartResult> =>
      deps.controller.start(decodeStartInput(raw), bindOwner(event)),
  );
  deps.ipcMain.handle(
    COMMANDCODE_LOGIN_IPC_CHANNELS.complete,
    async (_event, raw: unknown): Promise<CommandCodeBrowserLoginResult> => {
      const attemptId = decodeAttemptId(raw);
      if (attemptId === undefined) return { ok: false, reason: 'superseded' };
      return deps.controller.complete(attemptId);
    },
  );
  deps.ipcMain.handle(COMMANDCODE_LOGIN_IPC_CHANNELS.cancel, (_event, raw: unknown): void => {
    const attemptId = decodeAttemptId(raw);
    if (attemptId !== undefined) deps.controller.cancel(attemptId);
  });
}

function decodeStartInput(raw: unknown): CommandCodeBrowserLoginStartInput {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const baseUrl = (raw as Record<string, unknown>).baseUrl;
  return typeof baseUrl === 'string' && baseUrl.length > 0 && baseUrl.length <= MAX_BASE_URL_CHARS
    ? { baseUrl }
    : {};
}

function decodeAttemptId(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw.length > 0 && raw.length <= MAX_ATTEMPT_ID_CHARS
    ? raw
    : undefined;
}

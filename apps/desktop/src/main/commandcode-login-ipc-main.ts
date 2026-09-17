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

import type { IpcMain } from 'electron';
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
  readonly controller: Pick<CommandCodeBrowserLoginController, 'start' | 'complete' | 'cancel'>;
}

const MAX_BASE_URL_CHARS = 2_048;
const MAX_ATTEMPT_ID_CHARS = 128;

export function registerCommandCodeLoginIpc(deps: CommandCodeLoginIpcDeps): void {
  deps.ipcMain.handle(
    COMMANDCODE_LOGIN_IPC_CHANNELS.start,
    (_event, raw: unknown): Promise<CommandCodeBrowserLoginStartResult> =>
      deps.controller.start(decodeStartInput(raw)),
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

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

import {
  decodeExternalAgentSetupStart,
  decodeExternalAgentSetupAttempt,
} from '@maka/runtime-host/protocol';
import type { DesktopRuntimeHostClient } from './runtime-host-client.js';
import { handleReconnectableRead, type ReconnectableReadIpcMain } from './ipc-reconnect-policy.js';
import type {
  RuntimeHostOAuthPresentation,
  OAuthPresentationExpectation,
} from './runtime-host-oauth-presentation.js';

export function registerExternalAgentSetupIpc(deps: {
  ipcMain: ReconnectableReadIpcMain;
  client: Pick<
    DesktopRuntimeHostClient,
    'startExternalAgentSetup' | 'queryExternalAgentSetup' | 'cancelExternalAgentSetup'
  >;
  presentation: RuntimeHostOAuthPresentation;
  selectExecutable?: () => Promise<string | undefined>;
}): void {
  deps.ipcMain.handle('external-agents:select-executable', () => deps.selectExecutable?.());
  let pending: { id: string; expectation: OAuthPresentationExpectation } | undefined;
  const clear = (id: string) => {
    if (pending?.id !== id) return;
    pending.expectation.cancel();
    pending = undefined;
  };
  deps.ipcMain.handle('external-agents:setup:start', async (_event, raw: unknown) => {
    const input = decodeExternalAgentSetupStart(raw);
    if (input.action === 'login' && pending?.id !== input.attemptId) {
      if (pending) throw new Error('Another external agent login is in progress');
      const login = {
        id: input.attemptId,
        expectation: deps.presentation.expect(input.attemptId, input.attemptId),
      };
      pending = login;
      const release = () => {
        if (pending === login) clear(login.id);
      };
      void login.expectation.presented.then(release, release);
    }
    try {
      const result = await deps.client.startExternalAgentSetup(input);
      if (['succeeded', 'failed', 'cancelled'].includes(result.phase)) clear(input.attemptId);
      return result;
    } catch (error) {
      clear(input.attemptId);
      throw error;
    }
  });
  handleReconnectableRead(
    deps.ipcMain,
    'external-agents:setup:query',
    async (_event, raw: unknown) => {
      const { attemptId } = decodeExternalAgentSetupAttempt(raw);
      // Renderer liveness renews this exact slot. A consumed or expired slot is
      // never recreated, and an unrelated query cannot extend it.
      if (pending?.id === attemptId) pending.expectation.renew();
      try {
        const result = await deps.client.queryExternalAgentSetup(attemptId);
        if (['succeeded', 'failed', 'cancelled'].includes(result.phase)) clear(attemptId);
        return result;
      } catch (error) {
        clear(attemptId);
        throw error;
      }
    },
  );
  deps.ipcMain.handle('external-agents:setup:cancel', async (_event, raw: unknown) => {
    const { attemptId } = decodeExternalAgentSetupAttempt(raw);
    clear(attemptId);
    return deps.client.cancelExternalAgentSetup(attemptId);
  });
}

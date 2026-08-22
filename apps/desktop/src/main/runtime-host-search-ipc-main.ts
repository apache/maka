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

import { runThreadSearch } from './search/thread-search.js';
import type { DesktopRuntimeHostClient } from './runtime-host-client.js';
import { toDesktopHostSessionSummary } from './runtime-host-session-catalog-ipc-main.js';
import {
  handleReconnectableRead,
  readWithFallback,
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
  handleReconnectableRead(deps.ipcMain, 'search:thread', (_event, request: unknown) =>
    runThreadSearch(request, {
      listSessions: async () =>
        (await deps.client.listSessions()).map(toDesktopHostSessionSummary),
      readMessages: (sessionId) =>
        readWithFallback(async () => {
          const session = await deps.client.openSession(sessionId);
          try {
            return await session.loadTranscript();
          } finally {
            await session.close();
          }
        }, null),
      getPrivacyContext: async () => ({
        incognitoActive: (await deps.client.queryRuntimePolicy()).policy.privacy
          .incognitoActive,
      }),
    }),
  );
}

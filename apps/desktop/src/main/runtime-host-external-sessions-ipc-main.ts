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

import type { SessionChangedReason } from '@maka/core/session';
import { RuntimeHostOperationError } from '@maka/runtime-host/client';
import type {
  ExternalSessionCatalogQueryInput,
  ExternalSessionCatalogQueryResult,
  ExternalSessionSourceQueryResult,
  SessionCatalogProjection,
} from '@maka/runtime-host/protocol';
import {
  decodeExternalSessionCatalogQueryInput,
  decodeExternalSessionImportInput,
} from '@maka/runtime-host/protocol';
import type { ExternalSessionImportIpcResult } from '../preload/external-session-import-result.js';
import type { DesktopHostExternalSessionCatalogItem } from '../preload/external-session-catalog.js';
import {
  handleReconnectableRead,
  type ReconnectableReadIpcMain,
} from './ipc-reconnect-policy.js';
import { toDesktopHostSessionSummary } from './runtime-host-session-catalog-ipc-main.js';

type ExternalSessionClient = {
  listExternalSessionSources(): Promise<ExternalSessionSourceQueryResult>;
  listExternalSessions(
    input: ExternalSessionCatalogQueryInput,
  ): Promise<ExternalSessionCatalogQueryResult>;
  importExternalSession(input: {
    readonly adapterId: string;
    readonly sourceSessionId: string;
  }): Promise<SessionCatalogProjection>;
};

export interface RuntimeHostExternalSessionsIpcDeps {
  readonly client: ExternalSessionClient;
  readonly emitSessionsChanged: (reason: SessionChangedReason, sessionId?: string) => void;
}

export function registerRuntimeHostExternalSessionsIpc(
  deps: RuntimeHostExternalSessionsIpcDeps,
  ipcMain: ReconnectableReadIpcMain,
): void {
  handleReconnectableRead(ipcMain, 'external-sessions:listSources', () =>
    deps.client.listExternalSessionSources(),
  );
  handleReconnectableRead(ipcMain, 'external-sessions:list', async (_event, input: unknown) => {
    const result = await deps.client.listExternalSessions(
      decodeExternalSessionCatalogQueryInput(input),
    );
    return {
      ...result,
      sessions: result.sessions.map(({ hostCwd, ...session }) => ({
        ...session,
        cwd: hostCwd,
      }) satisfies DesktopHostExternalSessionCatalogItem),
    };
  });
  ipcMain.handle('external-sessions:import', async (_event, input: unknown) => {
    try {
      const session = await deps.client.importExternalSession(
        decodeExternalSessionImportInput(input),
      );
      deps.emitSessionsChanged('created', session.id);
      return {
        ok: true,
        session: toDesktopHostSessionSummary(session),
      } satisfies ExternalSessionImportIpcResult;
    } catch (error) {
      if (
        error instanceof RuntimeHostOperationError &&
        error.operation === 'external-session.import' &&
        error.code === 'commit_outcome_unknown'
      ) {
        // "Unknown" means the task may well be in the catalog, so tell the
        // shell to read it again. Without this, the only trace of a maybe-
        // committed import is the banner on the page, and the page is gone the
        // moment the user leaves Settings -- which is exactly when they come
        // back and import the same conversation a second time. No id: the
        // whole point is that we do not know which task, if any, landed.
        deps.emitSessionsChanged('created');
        return {
          ok: false,
          reason: 'commit_outcome_unknown',
        } satisfies ExternalSessionImportIpcResult;
      }
      throw error;
    }
  });
}

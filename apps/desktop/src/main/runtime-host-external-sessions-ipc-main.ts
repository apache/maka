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
import {
  RuntimeHostOperationError,
  RuntimeHostRequestInterruptedError,
} from '@maka/runtime-host/client';
import type {
  ExternalSessionCatalogQueryInput,
  ExternalSessionCatalogQueryResult,
  ExternalSessionImportResult,
  ExternalSessionSourceQueryResult,
  SessionCatalogProjection,
} from '@maka/runtime-host/protocol';
import {
  decodeExternalSessionCatalogQueryInput,
  decodeExternalSessionImportInput,
} from '@maka/runtime-host/protocol';
import type {
  ExternalSessionImportFailureReason,
  ExternalSessionImportIpcResult,
} from '../preload/external-session-import-result.js';
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
  }): Promise<ExternalSessionImportResult<SessionCatalogProjection>>;
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
    const query = decodeExternalSessionCatalogQueryInput(input);
    const result = await deps.client.listExternalSessions(query);
    return {
      ...result,
      sessions: result.sessions.map(({ hostCwd, ...session }) => ({
        ...session,
        cwd: hostCwd,
      }) satisfies DesktopHostExternalSessionCatalogItem),
    };
  });
  ipcMain.handle('external-sessions:import', async (_event, input: unknown) => {
    const request = decodeExternalSessionImportInput(input);
    try {
      const result = await deps.client.importExternalSession(request);
      if (result.kind === 'source_limit_exceeded') {
        return {
          ok: false,
          reason: 'source_limit_exceeded',
          limit: result.limit,
        } satisfies ExternalSessionImportIpcResult;
      }
      const session = result.session;
      deps.emitSessionsChanged('created', session.id);
      return {
        ok: true,
        session: toDesktopHostSessionSummary(session),
      } satisfies ExternalSessionImportIpcResult;
    } catch (error) {
      if (
        error instanceof RuntimeHostOperationError &&
        error.operation === 'external-session.import' &&
        error.code !== 'commit_outcome_unknown'
      ) {
        const reason = classifyImportFailure(error);
        if (reason !== undefined) {
          return { ok: false, reason } satisfies ExternalSessionImportIpcResult;
        }
        throw error;
      }
      if (isDefinitelyUndispatchedImport(error)) throw error;
      // The task may be in the catalog, but no uncertain response carries an
      // operation-specific Session id. A malformed response is equally
      // uncertain: input was canonical before this call, so only an explicit
      // not_dispatched interruption proves that this request did not run.
      // Re-importing is nevertheless a supported operation that creates an
      // independent task, so this per-request outcome must not become client
      // eligibility state.
      deps.emitSessionsChanged('created');
      return {
        ok: false,
        reason: 'commit_outcome_unknown',
      } satisfies ExternalSessionImportIpcResult;
    }
  });
}

function isDefinitelyUndispatchedImport(error: unknown): boolean {
  return (
    error instanceof RuntimeHostRequestInterruptedError &&
      error.operation === 'external-session.import' &&
    error.dispatch === 'not_dispatched'
  );
}

/**
 * Turn the intact Host operation error into a typed reason the renderer can
 * render distinctly. Done here, in Desktop Main, because Electron IPC drops the
 * `code` before the renderer sees the error. The coordinator publishes dedicated
 * stable codes for these cases, so this maps by code alone — no message text and
 * no reuse of an overloaded code such as `invalid_request`.
 */
function classifyImportFailure(
  error: RuntimeHostOperationError,
):
  | Exclude<ExternalSessionImportFailureReason, 'commit_outcome_unknown' | 'source_limit_exceeded'>
  | undefined {
  if (error.code === 'model_unavailable') return 'no_model';
  if (error.code === 'source_unreadable') return 'source_unreadable';
  return undefined;
}

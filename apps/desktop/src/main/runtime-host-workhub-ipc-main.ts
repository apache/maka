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

import { WORKHUB_COORDINATION_SESSION_ID } from '@maka/core/session';
import { RuntimeHostOperationError, RuntimeHostRequestInterruptedError } from '@maka/runtime-host/client';
import { prepareIngestItems, resolveAttachmentRefs } from './attachment-ingest.js';
import type { DesktopRuntimeHostClient } from './runtime-host-client.js';
import { handleReconciledControl, rethrowReconnectableReadFailure, type ReconnectableReadIpcMain } from './ipc-reconnect-policy.js';
import type { WorkHubAnswerInput, WorkHubAnswerResult } from '../shared/workhub-conversation.js';
import { toDesktopHostSessionSummary } from './runtime-host-session-catalog-ipc-main.js';

type RuntimeHostWorkHubClient = Pick<
  DesktopRuntimeHostClient,
  | 'ingestAttachment'
  | 'answerWorkHubCoordination'
  | 'configureWorkHubModel'
  | 'resolveWorkHubCoordinationSession'
  | 'getWorkHubSession'
  | 'queryTurn'
  | 'hostEpoch'
>;

export interface RuntimeHostWorkHubIpcOptions {
  attachmentIngest?: Pick<Parameters<typeof prepareIngestItems>[0], 'approvals' | 'stat'> & { resizeImage?: (bytes: Uint8Array) => Promise<Uint8Array> };
}

/** Projects the Runtime Host WorkHub domain onto renderer IPC. */
export function registerRuntimeHostWorkHubIpc(
  client: RuntimeHostWorkHubClient,
  ipcMain: ReconnectableReadIpcMain,
  options: RuntimeHostWorkHubIpcOptions,
): void {
  ipcMain.handle('workhub:getSession', async () => toDesktopHostSessionSummary(await client.getWorkHubSession()));
  ipcMain.handle('workhub:resolveCoordinationSession', () =>
    client.resolveWorkHubCoordinationSession(),
  );
  type Attempt = WorkHubAnswerInput & { readonly originHostEpoch: string };
  const unknown = (attempt: Attempt): WorkHubAnswerResult => ({
    kind: 'unknown', originHostEpoch: attempt.originHostEpoch,
  });
  const submit = async (attempt: Attempt): Promise<WorkHubAnswerResult> => {
    const { originHostEpoch: _originHostEpoch, ...input } = attempt;
    return { kind: 'admitted', ...await client.answerWorkHubCoordination(input) };
  };
  const reconcile = async (attempt: Attempt): Promise<WorkHubAnswerResult> => {
    try {
      const turn = await client.queryTurn({
        sessionId: WORKHUB_COORDINATION_SESSION_ID, turnId: attempt.turnId,
      });
      return { kind: 'admitted', turnId: turn.turnId, status: turn.status };
    } catch (error) {
      if (!(error instanceof RuntimeHostOperationError && error.code === 'not_found')) {
        rethrowReconnectableReadFailure(error);
        return unknown(attempt);
      }
    }
    // turn.query reads the durable admission under the Session lane. Absence
    // only retires an attempt when its original Host can no longer execute it.
    if (client.hostEpoch !== attempt.originHostEpoch) return { kind: 'not_admitted' };
    try {
      // Same Host: the original request may still be arriving. Its exact Turn
      // and payload share the Host's existing idempotent admission boundary.
      return await submit(attempt);
    } catch (error) {
      rethrowReconnectableReadFailure(error);
      return unknown(attempt);
    }
  };
  handleReconciledControl<Attempt, WorkHubAnswerResult>(ipcMain, 'workhub:answer', {
    dispatch: async (_event, input: WorkHubAnswerInput) => {
      const attempt = { ...input, originHostEpoch: input.originHostEpoch ?? client.hostEpoch };
      try {
        return { kind: 'completed', value: await (input.originHostEpoch ? reconcile(attempt) : submit(attempt)) };
      } catch (error) {
        if (input.originHostEpoch ||
          (error instanceof RuntimeHostRequestInterruptedError && error.dispatch === 'dispatched') ||
          (error instanceof RuntimeHostOperationError && error.code === 'outcome_unknown')) {
          return { kind: 'reconcile', context: attempt };
        }
        throw error;
      }
    },
    reconcile,
    reconciliationUnavailable: async (attempt) => unknown(attempt),
  });
  ipcMain.handle('workhub:configureModel', (_event, input) => client.configureWorkHubModel(input));
  ipcMain.handle('workhub:prepareAttachments', async (event, items: unknown) => {
    if (!options.attachmentIngest) throw new Error('WorkHub attachments are unavailable');
    const prepared = await prepareIngestItems({ ...options.attachmentIngest, senderId: event.sender.id, items });
    const refs = await resolveAttachmentRefs({
      files: prepared.files,
      resizeImage: options.attachmentIngest.resizeImage,
      snapshot: ({ name, mimeType, content }) => client.ingestAttachment({ sessionId: WORKHUB_COORDINATION_SESSION_ID, name, mimeType, content }),
    });
    return prepared.commit(() => refs);
  });
}

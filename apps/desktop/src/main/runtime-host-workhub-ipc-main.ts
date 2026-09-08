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
import type { ReconnectableReadIpcMain } from './ipc-reconnect-policy.js';
import { toDesktopHostSessionSummary } from './runtime-host-session-catalog-ipc-main.js';

type RuntimeHostWorkHubClient = Pick<
  DesktopRuntimeHostClient,
  | 'ingestAttachment'
  | 'answerWorkHubCoordination'
  | 'configureWorkHubModel'
  | 'resolveWorkHubCoordinationSession'
  | 'getWorkHubSession'
>;

export interface RuntimeHostWorkHubIpcOptions {
  attachmentIngest?: Pick<Parameters<typeof prepareIngestItems>[0], 'approvals' | 'stat'> & { resizeImage?: (bytes: Uint8Array) => Promise<Uint8Array> };
}

/** Projects the Runtime Host WorkHub domain onto renderer IPC. */
export function registerRuntimeHostWorkHubIpc(
  client: RuntimeHostWorkHubClient,
  ipcMain: Pick<ReconnectableReadIpcMain, 'handle'>,
  options: RuntimeHostWorkHubIpcOptions,
): void {
  ipcMain.handle('workhub:getSession', async () => toDesktopHostSessionSummary(await client.getWorkHubSession()));
  ipcMain.handle('workhub:resolveCoordinationSession', () =>
    client.resolveWorkHubCoordinationSession(),
  );
  ipcMain.handle('workhub:answer', async (_event, input) => {
    try {
      return await client.answerWorkHubCoordination(input);
    } catch (error) {
      // As with Session submission, a lost dispatched response is not a rejection.
      // Preserve that distinction before Electron strips the error's fields.
      if ((error instanceof RuntimeHostRequestInterruptedError && error.dispatch === 'dispatched') ||
        (error instanceof RuntimeHostOperationError && error.code === 'outcome_unknown')) return undefined;
      throw error;
    }
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

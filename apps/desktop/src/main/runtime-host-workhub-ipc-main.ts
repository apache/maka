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

import type {
  OperationError,
  OperationOutcome,
  WorkHubCoordinationActInput,
  WorkHubCoordinationActResult,
  WorkspaceTarget,
} from '@maka/runtime-host/protocol';
import { RuntimeHostOperationError } from '@maka/runtime-host/client';
import type { DesktopRuntimeHostClient } from './runtime-host-client.js';
import type { ReconnectableReadIpcMain } from './ipc-reconnect-policy.js';

type RuntimeHostWorkHubClient = Pick<
  DesktopRuntimeHostClient,
  | 'actWorkHubCoordination'
  | 'listWorkHubCoordinationCandidates'
  | 'recordWorkHubCoordination'
  | 'resolveWorkHubCoordinationSession'
>;

type RendererWorkHubActionInput = Omit<WorkHubCoordinationActInput, 'create'>;

export interface RuntimeHostWorkHubIpcOptions {
  resolveCreateProject(): Promise<WorkspaceTarget>;
  emitSessionsChanged(reason: 'created' | 'status-change', sessionId: string): void;
}

/** Projects the Runtime Host WorkHub domain onto renderer IPC. */
export function registerRuntimeHostWorkHubIpc(
  client: RuntimeHostWorkHubClient,
  ipcMain: Pick<ReconnectableReadIpcMain, 'handle'>,
  options: RuntimeHostWorkHubIpcOptions,
): void {
  ipcMain.handle('workhub:resolveCoordinationSession', () =>
    client.resolveWorkHubCoordinationSession(),
  );
  ipcMain.handle('workhub:record', (_event, input) =>
    client.recordWorkHubCoordination(input),
  );
  ipcMain.handle('workhub:candidates', () => client.listWorkHubCoordinationCandidates());
  ipcMain.handle('workhub:act', async (_event, rawInput: RendererWorkHubActionInput) => {
    try {
      const proposal = rawInput?.proposal;
      const base = {
        actionId: rawInput?.actionId,
        userText: rawInput?.userText,
        proposal,
        ...(rawInput?.confirmation === undefined
          ? {}
          : { confirmation: rawInput.confirmation }),
      } as Pick<
        WorkHubCoordinationActInput,
        'actionId' | 'userText' | 'proposal' | 'confirmation'
      >;
      let result: WorkHubCoordinationActResult;
      const createsTarget =
        proposal?.disposition === 'create_new' ||
        (proposal?.disposition === 'replace' &&
          proposal.target.disposition === 'create_new');
      if (createsTarget) {
        result = await client.actWorkHubCoordination({
          ...base,
          create: {
            workspace: await options.resolveCreateProject(),
          },
        });
      } else {
        result = await client.actWorkHubCoordination({
          ...base,
          ...(rawInput?.candidateSetId === undefined
            ? {}
            : { candidateSetId: rawInput.candidateSetId }),
        });
      }
      if (
        result.disposition === 'create_new' ||
        (result.disposition === 'replace' && result.replacementDisposition === 'create_new')
      ) {
        options.emitSessionsChanged('created', result.targetSessionId);
      } else if (
        result.disposition === 'delegate_existing' ||
        result.disposition === 'replace'
      ) {
        options.emitSessionsChanged('status-change', result.targetSessionId);
      }
      return { ok: true, result } satisfies OperationOutcome<'workhub.coordination.act'>;
    } catch (error) {
      if (!(error instanceof RuntimeHostOperationError)) throw error;
      return {
        ok: false,
        error: workHubActError(error),
      } satisfies OperationOutcome<'workhub.coordination.act'>;
    }
  });
}

function workHubActError(
  error: RuntimeHostOperationError,
): OperationError<'workhub.coordination.act'> {
  switch (error.code) {
    case 'host_not_ready':
    case 'host_draining':
    case 'unauthorized':
    case 'operation_unavailable':
    case 'not_found':
    case 'session_archived':
    case 'session_busy':
    case 'operation_conflict':
    case 'persistence_failed':
    case 'commit_outcome_unknown':
    case 'internal_failure':
      return { code: error.code, message: error.message };
    default:
      return { code: 'internal_failure', message: 'WorkHub action failed' };
  }
}

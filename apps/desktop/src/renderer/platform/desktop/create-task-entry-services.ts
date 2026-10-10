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

import type { MakaBridge } from '../../../preload/bridge-contract.js';
import type { TaskEntryServices } from '../../features/task-entry';
import {
  defaultRuntimeHostDiagnosticTarget,
  runOnDefaultRuntimeHost,
} from './default-runtime-host-operation.js';

export type DesktopTaskEntryBridge = Pick<MakaBridge, 'app' | 'newTasks' | 'projects' | 'sessions'>;

/** The only Desktop-to-Task Entry adapter. */
export function createDesktopTaskEntryServices(
  bridge: DesktopTaskEntryBridge = window.maka,
): TaskEntryServices {
  return {
    catalog: {
      ...bridge.newTasks,
      async renameProject(host, projectId, name) {
        await bridge.projects.rename(projectId, name, host);
      },
      async archiveProject(host, projectId) {
        await bridge.projects.archive(projectId, host);
      },
      async restoreProject(host, projectId) {
        await bridge.projects.restore(projectId, host);
      },
    },
    sessions: {
      async relocateWorkspace(sessionId, projectId) {
        const result = await bridge.sessions.moveToProject(sessionId, projectId);
        return result.ok
          ? { ok: true as const }
          : { ok: false as const, reason: result.code };
      },
    },
    folders: {
      // A task's folder opens through the task; anything else through the
      // default Runtime Host, which also names the profile a failure reports.
      async openProjectFolder(sessionId) {
        try {
          const { value: result, diagnosticTarget } = sessionId
            ? {
                value: await bridge.app.openPath('project', sessionId),
                diagnosticTarget: { sessionId },
              }
            : await runOnDefaultRuntimeHost((host) =>
                bridge.app.openPath('project', undefined, host),
              );
          return result.ok
            ? { kind: 'opened' as const }
            : { kind: 'refused' as const, reason: result.reason, diagnosticTarget };
        } catch (error) {
          const diagnosticTarget = sessionId
            ? { sessionId }
            : defaultRuntimeHostDiagnosticTarget(error);
          return { kind: 'failed' as const, error, ...(diagnosticTarget ? { diagnosticTarget } : {}) };
        }
      },
      async openWorkspaceFolder() {
        try {
          const { value: result, diagnosticTarget } = await runOnDefaultRuntimeHost((host) =>
            bridge.app.openPath('workspace', undefined, host),
          );
          return result.ok
            ? { kind: 'opened' as const }
            : { kind: 'refused' as const, reason: result.reason, diagnosticTarget };
        } catch (error) {
          const diagnosticTarget = defaultRuntimeHostDiagnosticTarget(error);
          return { kind: 'failed' as const, error, ...(diagnosticTarget ? { diagnosticTarget } : {}) };
        }
      },
    },
  };
}

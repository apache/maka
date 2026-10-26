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
import type { WorktreeServices } from '../../features/worktrees/index.js';

interface DesktopWorktreeBridge {
  newTasks: Pick<MakaBridge['newTasks'], 'getCatalog' | 'subscribeChanges'>;
  worktrees: Pick<MakaBridge['worktrees'], 'query' | 'mutate'>;
  sessions: Pick<MakaBridge['sessions'], 'list'>;
  shellRuns: Pick<MakaBridge['shellRuns'], 'start'>;
  sessionLocal?: Pick<MakaBridge['sessionLocal'], 'listMessages' | 'resumeMessage'>;
}

export function createDesktopWorktreeServices(
  bridge: DesktopWorktreeBridge = window.maka,
): WorktreeServices {
  return {
    subscribeChanges: (listener) => bridge.newTasks.subscribeChanges(listener),
    query: (host, projectId) => bridge.worktrees.query(projectId, host),
    mutate: (host, input) => bridge.worktrees.mutate(input, host),
    resumeTask: async (host, path) => {
      const sessions = (await bridge.sessions.list()).filter(
        (item) => item.runtimeHostId === host.hostId && item.cwd === path && !item.isArchived,
      );
      // All tasks sharing the checkout can proceed; return just one for navigation.
      let resumedSessionId: string | undefined;
      if (bridge.sessionLocal) {
        for (const session of sessions) {
          const paused = (await bridge.sessionLocal.listMessages(session.id)).filter(
            (message) =>
              message.state === 'paused' &&
              message.pauseReason === 'worktree_initialization',
          );
          for (const message of paused) {
            await bridge.sessionLocal.resumeMessage(session.id, message.messageId);
            resumedSessionId ??= session.id;
          }
        }
      }
      return resumedSessionId ?? sessions[0]?.id;
    },
    openTask: async (host, path, terminal) => {
      const sessions = (await bridge.sessions.list()).filter(
        (item) => item.runtimeHostId === host.hostId && item.cwd === path,
      );
      const session = sessions.find((item) => !item.isArchived) ?? (!terminal ? sessions[0] : undefined);
      if (!session) return undefined;
      if (terminal) await bridge.shellRuns.start(session.id);
      return session.id;
    },
  };
}

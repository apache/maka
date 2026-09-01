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
import type { ConversationServices } from '../../features/conversation';

export function createDesktopConversationServices(
  bridge: Pick<MakaBridge, 'sessions' | 'skills' | 'workspace' | 'newTasks' | 'mcp'> = window.maka,
): ConversationServices {
  return {
    sessions: {
      list: () => bridge.sessions.list(),
      subscribeChanges: (handler) => bridge.sessions.subscribeChanges(handler),
      readSnapshot: (sessionId) => bridge.sessions.readSnapshot(sessionId),
    },
    skills: {
      listInvocable: (sessionId, context) => {
        const { permissionMode: _permissionMode, ...skillsContext } = context ?? {};
        return bridge.skills.listInvocable(sessionId, skillsContext);
      },
    },
    workspace: {
      searchFiles: (query, options) => bridge.workspace.searchFiles(query, options),
    },
    newTasks: {
      subscribeChanges: (handler) => bridge.newTasks.subscribeChanges(handler),
      listInvocableSkills: (target, context) => bridge.newTasks.listInvocableSkills(target, context),
      searchFiles: (target, query) => bridge.newTasks.searchFiles(target, query),
    },
    mcp: {
      subscribeChanges: (handler) => bridge.mcp.subscribeChanges(() => handler()),
    },
  };
}

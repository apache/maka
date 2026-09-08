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
import type { DesktopSessionUpdateResult } from '../../../shared/desktop-session-projection.js';
import { ExpectedOperationError } from '../../application/contracts/operation-diagnostics.js';
import type { SessionSettingsServices } from '../../features/session-settings';

export type DesktopSessionSettingsBridge = Pick<MakaBridge, 'sessions'>;

export function expectSessionUpdate<Session>(result: DesktopSessionUpdateResult<Session>): Session {
  if (result.ok) return result.session;
  throw new ExpectedOperationError(result.code);
}

export function createDesktopSessionSettingsServices(
  bridge: DesktopSessionSettingsBridge = window.maka,
): SessionSettingsServices {
  return {
    setModelConfiguration: async (sessionId, input) =>
      expectSessionUpdate(await bridge.sessions.setModelConfiguration(sessionId, input)),
    setPermissionMode: async (sessionId, mode) =>
      expectSessionUpdate(await bridge.sessions.setPermissionMode(sessionId, mode)),
    setOrchestrationMode: async (sessionId, mode) =>
      expectSessionUpdate(await bridge.sessions.setOrchestrationMode(sessionId, mode)),
    setCollaborationMode: async (sessionId, mode) =>
      expectSessionUpdate(await bridge.sessions.setCollaborationMode(sessionId, mode)),
    abandonPlanProposal: async (sessionId, proposalId) => {
      const result = await bridge.sessions.abandonPlanProposal(sessionId, proposalId);
      if (!result.ok) throw new ExpectedOperationError(result.error.code);
    },
  };
}

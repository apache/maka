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
import type { ComposerSubmissionServices } from '../../features/conversation/index.js';

export type DesktopComposerSubmissionBridge = {
  readonly sessions: Pick<
    MakaBridge['sessions'],
    | 'submitMessage'
    | 'remove'
    | 'reviseBeforeTurn'
    | 'abandonSessionCopy'
    | 'stop'
    | 'branchFromTurn'
    | 'respondToSandboxBoundary'
    | 'respondToUserQuestion'
  >;
  readonly newTasks: Pick<MakaBridge['newTasks'], 'create'>;
};

export function createDesktopComposerSubmissionServices(
  bridge: DesktopComposerSubmissionBridge = window.maka,
): ComposerSubmissionServices {
  return {
    submitMessage: (sessionId, placement, command, options) =>
      bridge.sessions.submitMessage(sessionId, placement, command, options),
    createNewTask: (target, input) => bridge.newTasks.create(target, input),
    removeUnsentSession: (sessionId) => bridge.sessions.remove(sessionId),
    reviseBeforeTurn: (sessionId, input) => bridge.sessions.reviseBeforeTurn(sessionId, input),
    abandonSessionCopy: (sourceSessionId, copyId) => bridge.sessions.abandonSessionCopy(sourceSessionId, copyId),
    stop: (sessionId, input) => bridge.sessions.stop(sessionId, input),
    branchFromTurn: (sessionId, input) => bridge.sessions.branchFromTurn(sessionId, input),
    respondToSandboxBoundary: (sessionId, response) => bridge.sessions.respondToSandboxBoundary(sessionId, response),
    respondToUserQuestion: (sessionId, response) => bridge.sessions.respondToUserQuestion(sessionId, response),
  };
}

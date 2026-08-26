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
import type { WorkbarServices } from '../../features/workbar';
import { readSettledMessagesFrom } from '../../session-message-settlement.js';

export type DesktopWorkbarBridge = Pick<
  MakaBridge,
  | 'app'
  | 'artifacts'
  | 'attachments'
  | 'browser'
  | 'gitReview'
  | 'inspector'
  | 'sessions'
  | 'shellRuns'
  | 'tasks'
  | 'transcripts'
>;

export interface DesktopWorkbarServiceDependencies {
  readSettledMessages: typeof readSettledMessagesFrom;
}

const DEFAULT_DEPENDENCIES: DesktopWorkbarServiceDependencies = {
  readSettledMessages: readSettledMessagesFrom,
};

/** The only Desktop-to-Workbar adapter. It narrows the preload bridge by tool. */
export function createDesktopWorkbarServices(
  bridge: DesktopWorkbarBridge = window.maka,
  dependencies: DesktopWorkbarServiceDependencies = DEFAULT_DEPENDENCIES,
): WorkbarServices {
  return {
    review: {
      read: (input) => bridge.gitReview.read(input),
      subscribeSessionEvents: (sessionId, handler) =>
        bridge.sessions.subscribeEvents(sessionId, handler),
    },
    terminal: {
      start: (sessionId) => bridge.shellRuns.start(sessionId),
      stop: (input) => bridge.shellRuns.stop(input),
      attach: (input) => bridge.shellRuns.attach(input),
      detach: (input) => bridge.shellRuns.detach(input),
      write: (input) => bridge.shellRuns.write(input),
      subscribePtyData: (handler) => bridge.shellRuns.subscribePtyData(handler),
      subscribeResync: (handler) => bridge.shellRuns.subscribeResync(handler),
    },
    tasks: {
      list: (sessionId) => bridge.tasks.list(sessionId),
      subscribeChanges: (handler) => bridge.tasks.subscribeChanges(handler),
    },
    browser: {
      setActiveSession: (sessionId) => bridge.browser.setActiveSession(sessionId),
      setViewport: (input) => bridge.browser.setViewport(input),
      navigate: (sessionId, url) => bridge.browser.navigate(sessionId, url),
      back: (sessionId) => bridge.browser.back(sessionId),
      forward: (sessionId) => bridge.browser.forward(sessionId),
      reload: (sessionId) => bridge.browser.reload(sessionId),
      stop: (sessionId) => bridge.browser.stop(sessionId),
      close: (sessionId) => bridge.browser.close(sessionId),
      getState: (sessionId) => bridge.browser.getState(sessionId),
      subscribeState: (handler) => bridge.browser.onState(handler),
      subscribeLive: (handler) => bridge.browser.onLive(handler),
    },
    artifacts: {
      list: (sessionId, options) => bridge.artifacts.list(sessionId, options),
      readText: (sessionId, artifactId) =>
        bridge.artifacts.readText(sessionId, artifactId),
      readBinary: (sessionId, artifactId) =>
        bridge.artifacts.readBinary(sessionId, artifactId),
      delete: (sessionId, artifactId) =>
        bridge.artifacts.delete(sessionId, artifactId),
      subscribeChanges: (handler) => bridge.artifacts.subscribeChanges(handler),
      openPath: (sessionId, artifactId) =>
        bridge.app.openArtifactPath(sessionId, artifactId),
      saveAs: (sessionId, artifactId) =>
        bridge.app.saveArtifactAs(sessionId, artifactId),
    },
    inspector: {
      trace: (sessionId, cursor) => bridge.inspector.trace(sessionId, cursor),
      summary: (sessionId) => bridge.inspector.summary(sessionId),
      context: (sessionId) => bridge.inspector.context(sessionId),
      subscribeSessionEvents: (sessionId, handler) =>
        bridge.sessions.subscribeEvents(sessionId, handler),
      subscribeUsageChanges: (sessionId, handler) =>
        bridge.inspector.subscribeUsageChanges(sessionId, handler),
    },
    attachments: {
      pickFiles: () => bridge.attachments.pickFiles(),
      previewApproval: (approvalId) =>
        bridge.attachments.previewApproval(approvalId),
    },
    sideChat: {
      listSessions: () => bridge.sessions.list(),
      listTurns: (sessionId) => bridge.sessions.listTurns(sessionId),
      readSettledMessages: (sessionId, options) =>
        dependencies.readSettledMessages(bridge.transcripts, sessionId, options),
      branchFromTurn: (sessionId, input) =>
        bridge.sessions.branchFromTurn(sessionId, input),
      cleanupSessionCopy: (sessionId) =>
        bridge.sessions.cleanupSessionCopy(sessionId),
      abandonSessionCopy: (sourceSessionId, copyId) =>
        bridge.sessions.abandonSessionCopy(sourceSessionId, copyId),
      send: (sessionId, command) => bridge.sessions.send(sessionId, command),
      stop: (sessionId, target) =>
        bridge.sessions.stop(
          sessionId,
          target?.kind === 'admission'
            ? { source: 'stop_button', expectedAdmissionId: target.messageId }
            : target?.kind === 'turn'
              ? { source: 'stop_button', expectedTurnId: target.turnId }
              : undefined,
        ),
      steer: (sessionId, text, admissionId) => bridge.sessions.steer(sessionId, text, admissionId),
      setPermissionMode: (sessionId, mode) =>
        bridge.sessions.setPermissionMode(sessionId, mode),
      regenerateTurn: (sessionId, input) =>
        bridge.sessions.regenerateTurn(sessionId, input),
      respondToSandboxBoundary: (sessionId, response) =>
        bridge.sessions.respondToSandboxBoundary(sessionId, response),
      respondToUserQuestion: (sessionId, response) =>
        bridge.sessions.respondToUserQuestion(sessionId, response),
      subscribeEvents: (sessionId, handler, onSeeded, onSeedError) =>
        bridge.sessions.subscribeEvents(sessionId, handler, onSeeded, undefined, onSeedError),
      subscribeSessionChanges: (handler) => bridge.sessions.subscribeChanges(handler),
    },
  };
}

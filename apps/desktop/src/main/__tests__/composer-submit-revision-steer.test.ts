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

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  revisionAwareSend,
  type RevisionDraftIdentity,
  type RevisionSendPorts,
} from '../../renderer/features/conversation/testing.js';

const SESSION_1 = JSON.stringify(['host-1', 'session-1']);

test('a steer submit during an active revision edit is refused, not sent into the running turn', async () => {
  let followUpCalls = 0;
  let toastCalls = 0;
  const ports: RevisionSendPorts<RevisionDraftIdentity> = {
    captureSubmitSurface: () => () => true,
    shellCopy: {} as never,
    toastApi: {
      info: () => {
        toastCalls += 1;
      },
    },
    activeIdRef: { current: SESSION_1 },
    revisionDraftRef: {
      current: { sourceSessionId: SESSION_1, draftSessionId: SESSION_1 },
    },
    composerRef: { current: null },
    retractedWorkspaceReferencesRef: { current: {} },
    captureStaging:
      () =>
      ({ submittableAttachments: [], retainAttachments: () => () => {} }) as never,
    prepareRevisionSend: async () => {
      throw new Error('the steer must not reach the revision lifecycle');
    },
    send: async () => {
      throw new Error('the steer must not reach the plain send');
    },
    enqueueFollowUp: async () => {
      followUpCalls += 1;
      return true;
    },
    settleNewTaskImageNoticeOwner: () => {},
    commitRevisionDraft: () => {},
    completeRevisionCopyAttempt: () => {},
    parseSlashCommand: () => null,
    mergeWorkspaceReferences: (_text, live) => [...(live ?? [])],
    rebaseWorkspaceFileReferences: (_sourceText, _projectedText, references) => [...(references ?? [])],
    revisionUnavailableCopy: {
      revisionUnavailableTitle: 'unavailable',
      revisionAttachmentsUnsupported: 'attachments',
      revisionCommandUnsupported: 'commands',
      revisionFollowUpUnsupported: 'follow-up',
    },
    compactSession: async () => true,
    resolveNewTaskSessionHandler: () => async () => {},
    openSideChat: () => {},
    getActiveOrchestrationMode: () => 'default' as never,
    setOrchestrationModeActive: async () => true,
  };

  // The user is editing a historical message -- an active revision draft on
  // the active session -- and hits Cmd/Ctrl+Enter while the session's turn is
  // running: composer.tsx routes that keystroke to followUpMode 'steer'. The
  // steer would carry the edit draft AND the restored quote plate into the
  // running turn, and clearing the plate would let the later replacement send
  // pass the incremental-only gate without the source message's quotes.
  const outcome = await revisionAwareSend(ports, 'redirect the running turn', {
    followUpMode: 'steer',
  });

  assert.equal(
    followUpCalls,
    0,
    'the edit draft must not be steered into the running turn',
  );
  assert.equal(toastCalls, 1, 'the refusal is surfaced like the slash-command one');
  assert.equal(outcome, false);
});

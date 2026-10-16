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

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { FollowUpMode } from '@maka/core/events';
import type { ComposerSendMetadata } from '@maka/ui';
import {
  createRevisionAwareOnSend,
  mergeWorkspaceReferences,
  type RevisionSendPorts,
} from '../../renderer/features/conversation/testing.js';

interface ObservedCall {
  kind: 'enqueue' | 'send';
  mode?: FollowUpMode;
  text?: string;
}

function routingPorts(calls: ObservedCall[]): RevisionSendPorts<{ sourceSessionId: string; draftSessionId: string }> {
  return {
    shellCopy: {
      sideChatUnavailableTitle: '',
      sideChatUnavailableDescription: '',
      sideChatContextPendingTitle: '',
      sideChatContextPendingDescription: '',
      swarmModeEnabledTitle: '',
      swarmModeDisabledTitle: '',
      swarmModeStatusDescription: '',
      graphModeEnabledTitle: '',
      graphModeDisabledTitle: '',
      graphModeStatusDescription: '',
      graphHistoryTitle: '',
      graphHistoryDescription: '',
    },
    toastApi: { info() {} },
    activeIdRef: { current: 'session-a' },
    revisionDraftRef: { current: null },
    composerRef: { current: null },
    retractedWorkspaceReferencesRef: { current: {} },
    captureStaging: () => ({
      draftKey: 'draft',
      hasPendingContext: false,
      hasStagedQuotes: false,
      submittableAttachments: undefined,
      directoryOptions: {},
      quotesForSend: () => undefined,
      retainAttachments: () => () => {},
      clearSubmittedContext: () => {},
      clearQuotes: () => {},
    }),
    prepareRevisionSend: async () => true,
    send: async (text) => {
      calls.push({ kind: 'send', text });
      return true;
    },
    enqueueFollowUp: async (_sessionId, text, mode) => {
      calls.push({ kind: 'enqueue', mode, text });
      return true;
    },
    settleNewTaskImageNoticeOwner: () => {},
    commitRevisionDraft: () => {},
    completeRevisionCopyAttempt: () => {},
    parseSlashCommand: () => null,
    mergeWorkspaceReferences,
    rebaseWorkspaceFileReferences: (_source, _projected, references) => [...references],
    revisionUnavailableCopy: {
      revisionUnavailableTitle: '',
      revisionAttachmentsUnsupported: '',
      revisionCommandUnsupported: '',
    },
    compactSession: async () => true,
    resolveNewTaskSessionHandler: () => () => {},
    openSideChat: () => {},
    getActiveOrchestrationMode: () => 'default',
    setOrchestrationModeActive: async () => true,
  };
}

describe('follow-up submit routing', () => {
  it('queues an ordinary follow-up on a healthy turn without calling stop', async () => {
    const calls: ObservedCall[] = [];
    const ports = routingPorts(calls);
    const send = createRevisionAwareOnSend({
      ...ports,
      setNewTaskSendPending: () => {},
    });
    // Composer sets queue for plain Enter while a healthy Turn is running.
    const metadata: ComposerSendMetadata = { followUpMode: 'queue' };
    assert.equal(await send('keep going', metadata), true);
    assert.deepEqual(calls, [{ kind: 'enqueue', mode: 'queue', text: 'keep going' }]);
  });

  it('keeps an explicit steer on the queue path and still does not stop', async () => {
    const calls: ObservedCall[] = [];
    const ports = routingPorts(calls);
    assert.equal(
      await createRevisionAwareOnSend({ ...ports, setNewTaskSendPending: () => {} })(
        'change direction',
        { followUpMode: 'steer' },
      ),
      true,
    );
    assert.deepEqual(calls, [{ kind: 'enqueue', mode: 'steer', text: 'change direction' }]);
  });

  it('sends a root turn when no follow-up mode is set, without calling stop', async () => {
    const calls: ObservedCall[] = [];
    const ports = routingPorts(calls);
    assert.equal(
      await createRevisionAwareOnSend({ ...ports, setNewTaskSendPending: () => {} })('hello'),
      true,
    );
    assert.deepEqual(calls, [{ kind: 'send', text: 'hello' }]);
  });

  it('restores workspace references after queued text returns to the draft', () => {
    assert.deepEqual(
      mergeWorkspaceReferences(
        'preface\n\nreview @src/app.ts',
        undefined,
        [{
          kind: 'workspace_file',
          value: '@src/app.ts',
          label: 'src/app.ts',
          start: 7,
        }],
      ),
      [{ value: '@src/app.ts', start: 16 }],
    );
  });
});

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
import type { MakaBridge } from '../../preload/bridge-contract.js';
import { createDesktopWorkbarServices } from '../../renderer/platform/desktop/create-workbar-services.js';

type RecordedCall = { name: string; args: unknown[] };

function createBridgeRecorder(): {
  bridge: MakaBridge;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const syncMethods = new Set([
    'sessions.subscribeEvents',
    'shellRuns.subscribePtyData',
    'shellRuns.subscribeResync',
    'todo.subscribeChanges',
    'browser.setActiveSession',
    'browser.setViewport',
    'browser.onState',
    'browser.onLive',
    'artifacts.subscribeChanges',
    'inspector.subscribeUsageChanges',
  ]);
  // Adapters that reshape a bridge answer need one to reshape.
  const answers = new Map<string, unknown>([
    [
      'sessions.submitMessage',
      {
        ok: true,
        disposition: 'steering',
        attachments: [],
        inlineReferences: [],
        skillInvocation: { loaded: [], failed: [], receipts: [] },
      },
    ],
  ]);
  const domain = (name: string) =>
    new Proxy({}, {
      get: (_target, property) => (...args: unknown[]) => {
        const callName = `${name}.${String(property)}`;
        calls.push({ name: callName, args });
        if (syncMethods.has(callName)) return () => undefined;
        return Promise.resolve(answers.get(callName));
      },
    });

  return {
    calls,
    bridge: {
      gitReview: domain('gitReview'),
      sessions: domain('sessions'),
      shellRuns: domain('shellRuns'),
      todo: domain('todo'),
      browser: domain('browser'),
      artifacts: domain('artifacts'),
      app: domain('app'),
      inspector: domain('inspector'),
      attachments: domain('attachments'),
      transcripts: domain('transcripts'),
    } as unknown as MakaBridge,
  };
}

describe('createDesktopWorkbarServices', () => {
  it('preserves the Side Conversation Stop identity kind', async () => {
    const { bridge, calls } = createBridgeRecorder();
    const services = createDesktopWorkbarServices(bridge, {
      readSettledMessages: async () => ({ messages: [], settled: true }),
    });

    await services.sideChat.stop('fork', { kind: 'admission', messageId: 'message-1' });
    await services.sideChat.stop('fork', { kind: 'turn', turnId: 'turn-1' });

    assert.deepEqual(
      calls.filter((call) => call.name === 'sessions.stop').map((call) => call.args),
      [
        ['fork', { source: 'stop_button', expectedAdmissionId: 'message-1' }],
        ['fork', { source: 'stop_button', expectedTurnId: 'turn-1' }],
      ],
    );
  });

  it('maps every Workbar capability to the existing Desktop bridge', async () => {
    const { bridge, calls } = createBridgeRecorder();
    const settledReads: unknown[][] = [];
    const services = createDesktopWorkbarServices(bridge, {
      readSettledMessages: async (...args) => {
        settledReads.push(args);
        return { messages: [], settled: true };
      },
    });
    const eventHandler = () => undefined;

    await services.review.read({ sessionId: 's', source: 'unstaged' });
    services.review.subscribeSessionEvents('s', eventHandler)();

    await services.terminal.start('s');
    await services.terminal.stop({ sessionId: 's', ref: 'term' });
    await services.terminal.attach({ sessionId: 's', ref: 'term' });
    await services.terminal.detach({ sessionId: 's', ref: 'term' });
    await services.terminal.write({ sessionId: 's', ref: 'term', input: 'ls' });
    services.terminal.subscribePtyData(eventHandler)();
    services.terminal.subscribeResync(eventHandler)();

    await services.todo.read('s');
    services.todo.subscribeChanges(eventHandler)();

    services.browser.setActiveSession('s');
    services.browser.setViewport({ sessionId: 's', rect: null });
    await services.browser.navigate('s', 'https://example.com');
    await services.browser.back('s');
    await services.browser.forward('s');
    await services.browser.reload('s');
    await services.browser.stop('s');
    await services.browser.close('s');
    await services.browser.getState('s');
    services.browser.subscribeState(eventHandler)();
    services.browser.subscribeLive(eventHandler)();

    await services.artifacts.list('s', { includeDeleted: true });
    await services.artifacts.readText('s', 'a');
    await services.artifacts.readBinary('s', 'a');
    await services.artifacts.delete('s', 'a');
    services.artifacts.subscribeChanges(eventHandler)();
    await services.artifacts.openPath('s', 'a');
    await services.artifacts.saveAs('s', 'a');

    await services.inspector.trace('s', 'cursor-1');
    await services.inspector.summary('s');
    await services.inspector.context('s');
    services.inspector.subscribeSessionEvents('s', eventHandler)();
    services.inspector.subscribeUsageChanges('s', eventHandler)();

    await services.attachments.pickFiles();
    await services.attachments.previewApproval('approval');

    await services.sideChat.listSessions();
    await services.sideChat.listTurns('s');
    await services.sideChat.readSettledMessages('s', {
      requiredAssistantMessageId: 'message',
    });
    await services.sideChat.branchFromTurn('s', {
      sourceTurnId: 'turn',
      copyId: 'copy',
      sideConversation: true,
    });
    await services.sideChat.cleanupSessionCopy('fork');
    await services.sideChat.abandonSessionCopy('s', 'copy');
    await services.sideChat.send('fork', {
      type: 'send',
      turnId: 'turn-2',
      text: 'hello',
    });
    await services.sideChat.stop('fork');
    await services.sideChat.steer('fork', 'more');
    await services.sideChat.setPermissionMode('fork', 'ask');
    await services.sideChat.regenerateTurn('fork', {
      sourceTurnId: 'turn-2',
      turnId: 'turn-3',
    });
    await services.sideChat.respondToSandboxBoundary('fork', {} as never);
    await services.sideChat.respondToClientCapability('fork', {} as never);
    await services.sideChat.respondToUserQuestion('fork', {} as never);
    services.sideChat.subscribeEvents('fork', eventHandler)();

    assert.deepEqual(
      calls.map((call) => call.name),
      [
        'gitReview.read',
        'sessions.subscribeEvents',
        'shellRuns.start',
        'shellRuns.stop',
        'shellRuns.attach',
        'shellRuns.detach',
        'shellRuns.write',
        'shellRuns.subscribePtyData',
        'shellRuns.subscribeResync',
        'todo.read',
        'todo.subscribeChanges',
        'browser.setActiveSession',
        'browser.setViewport',
        'browser.navigate',
        'browser.back',
        'browser.forward',
        'browser.reload',
        'browser.stop',
        'browser.close',
        'browser.getState',
        'browser.onState',
        'browser.onLive',
        'artifacts.list',
        'artifacts.readText',
        'artifacts.readBinary',
        'artifacts.delete',
        'artifacts.subscribeChanges',
        'app.openArtifactPath',
        'app.saveArtifactAs',
        'inspector.trace',
        'inspector.summary',
        'inspector.context',
        'sessions.subscribeEvents',
        'inspector.subscribeUsageChanges',
        'attachments.pickFiles',
        'attachments.previewApproval',
        'sessions.list',
        'sessions.listTurns',
        'sessions.branchFromTurn',
        'sessions.cleanupSessionCopy',
        'sessions.abandonSessionCopy',
        'sessions.send',
        'sessions.stop',
        'sessions.submitMessage',
        'sessions.setPermissionMode',
        'sessions.regenerateTurn',
        'sessions.respondToSandboxBoundary',
        'sessions.respondToClientCapability',
        'sessions.respondToUserQuestion',
        'sessions.subscribeEvents',
      ],
    );
    assert.deepEqual(calls.find((call) => call.name === 'browser.navigate')?.args, [
      's',
      'https://example.com',
    ]);
    assert.deepEqual(calls.find((call) => call.name === 'artifacts.readText')?.args, [
      's',
      'a',
    ]);
    assert.deepEqual(calls.find((call) => call.name === 'inspector.trace')?.args, [
      's',
      'cursor-1',
    ]);
    assert.equal(settledReads[0]?.[0], bridge.transcripts);
    assert.deepEqual(settledReads[0]?.slice(1), [
      's',
      { requiredAssistantMessageId: 'message' },
    ]);
  });
});

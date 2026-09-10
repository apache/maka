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
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import type { MessageContent } from '@maka/core/events';
import type { RootTurnAdmission, RootTurnAdmissionStore } from '@maka/storage/execution-stores';
import { RootAdmissionOwner } from '../server/root-admission-owner.js';

test('live and recovered historical content is collectible while owner and SQLite stay open', () => {
  const ownerUrl = new URL('../server/root-admission-owner.js', import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    [
      '--expose-gc',
      '--input-type=module',
      '-e',
      `
    import assert from 'node:assert/strict';
    import { mkdtemp, rm } from 'node:fs/promises';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    import { setImmediate } from 'node:timers/promises';
    import { randomBytes } from 'node:crypto';
    import { messageContentDigest } from '@maka/core/events';
    import { createSqliteAgentRunStore } from '@maka/storage/agent-run-store';
    import { RootAdmissionOwner } from ${JSON.stringify(ownerUrl)};
    const root = await mkdtemp(join(tmpdir(), 'maka-admission-retention-'));
    const store = createSqliteAgentRunStore(root);
    const count = 32;
    const observe = admission => [new WeakRef(admission.normalizedInput),
      new WeakRef(admission.sourceMessages[0].content)];
    const collect = async () => {
      for (let i = 0; i < 8; i++) { await setImmediate(); global.gc(); }
      await setImmediate();
    };
    const asInput = a => ({ sessionId: a.sessionId, turnId: a.turnId,
      proposedRunId: a.runId, proposedUserMessageId: a.userMessageId,
      execution: a.execution, normalizedInput: a.normalizedInput,
      sourceMessages: a.sourceMessages, admittedAt: a.admittedAt });
    try {
      for (const mode of ['live', 'recovery']) {
        const owner = new RootAdmissionOwner(store);
        const weak = await (async () => {
          if (mode === 'recovery') {
            const chain = await owner.recoverSession('session');
            assert.equal(chain.length, count);
            assert.ok(Object.isFrozen(chain));
            for (const a of chain) {
              assert.equal(a.normalizedInput.text.length, 48 * 1024);
              owner.assertKnownAdmission(a);
            }
            return chain.flatMap(observe);
          }
          const refs = [];
          for (let i = 0; i < count; i++) {
            const content = { text: randomBytes(36 * 1024).toString('base64') };
            const result = await owner.admitRootTurn({ sessionId: 'session', turnId: 'turn_' + i,
              proposedRunId: 'run_' + i, proposedUserMessageId: 'message_' + i,
              execution: { kind: 'external_message', inputDigest: messageContentDigest(content) },
              normalizedInput: content, sourceMessages: [{ messageId: 'message_' + i, content,
                placement: 'next_turn', disposition: 'turn_started' }], admittedAt: i + 1 });
            assert.equal(result.kind, 'admitted');
            refs.push(...observe(result.admission));
          }
          return refs;
        })();
        await collect();
        assert.equal(weak.slice(0, -2).filter(ref => ref.deref()).length, 0, mode);
        assert.ok(weak.at(-2).deref(), mode + ' retains normalized tip');
        assert.ok(weak.at(-1).deref(), mode + ' retains source tip');
        const conflictWeak = await (async () => {
          const old = await store.readRootTurnAdmission('session', 'turn_0');
          owner.assertKnownAdmission(old);
          const conflict = await owner.admitRootTurn(asInput(old));
          assert.equal(conflict.kind, 'conflict');
          assert.equal(conflict.admission.normalizedInput.text, old.normalizedInput.text);
          assert.ok(Object.isFrozen(conflict.admission.normalizedInput));
          return observe(conflict.admission);
        })();
        await collect();
        assert.equal(conflictWeak.filter(ref => ref.deref()).length, 0, mode + ' conflict released');
        assert.equal(owner.latestAdmission('session').turnId, 'turn_' + (count - 1));
        assert.equal((await store.listRootTurnAdmissionsForRecovery('session')).length, count);
      }
    } finally { store.close(); await rm(root, { recursive: true, force: true }); }
  `,
    ],
    { encoding: 'utf8', timeout: 30_000 },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('historical identity keeps canonical content equality and all admission metadata', async () => {
  const rich = admission('rich', {
    text: '/skill:writer',
    attachments: [
      {
        kind: 'image',
        name: 'a.png',
        mimeType: 'image/png',
        bytes: 42,
        ref: { kind: 'workspace_file', relativePath: 'a.png' },
      },
    ],
    quotes: [{ text: 'excerpt', label: 'Assistant', sourceTurnId: 'source' }],
    directoryReferences: [{ hostId: 'host', path: '/workspace' }],
    inlineReferences: [{ kind: 'skill', value: '/skill:writer', label: 'Writer', start: 0 }],
  });
  rich.sourceMessages = [
    ...rich.sourceMessages,
    {
      ...rich.sourceMessages[0]!,
      messageId: 'second',
      content: { text: 'second' },
    },
  ];
  const plain = admission('plain', { text: 'plain' });
  const empty = admission('empty', null);
  const owner = new RootAdmissionOwner(storeFor([rich, plain, empty]));
  await owner.recoverSession('session');
  for (const original of [rich, plain]) {
    const equivalent = structuredClone(original);
    for (const content of [equivalent.normalizedInput!, equivalent.sourceMessages[0]!.content]) {
      content.displayText = content.text;
      content.attachments ??= [];
      content.quotes ??= [];
      content.directoryReferences ??= [];
      if (content.attachments[0]) {
        const a = content.attachments[0];
        content.attachments[0] = {
          ref: a.ref,
          bytes: a.bytes,
          mimeType: a.mimeType,
          name: a.name,
          kind: a.kind,
        };
      }
    }
    equivalent.sourceMessages[0]!.submittedPlacement = 'next_turn';
    owner.assertKnownAdmission(equivalent);
  }
  const drifts: ((a: RootTurnAdmission) => void)[] = [
    (a) => Object.assign(a, { admittedAt: 2 }),
    (a) => {
      a.execution = { kind: 'external_message', inputDigest: `sha256:${'a'.repeat(64)}` };
    },
    (a) => Object.assign(a, { turnOrchestration: { mode: 'swarm', source: 'host_api' } }),
    (a) => Object.assign(a, { skillInvocation: { loaded: [], failed: [], receipts: [] } }),
    (a) => {
      a.authorization = {
        kind: 'session_turn_access_request',
        requestId: 'request',
        principalId: 'principal',
        grantId: 'grant',
        approvedAt: 1,
        approvedBy: 'owner',
      };
    },
    (a) => {
      a.normalizedInput!.text = 'changed';
    },
    (a) => {
      a.normalizedInput!.attachments![0]!.ref = { kind: 'workspace_file', relativePath: 'b' };
    },
    (a) => {
      a.normalizedInput!.quotes![0]!.sourceTurnId = 'changed';
    },
    (a) => {
      a.normalizedInput!.directoryReferences![0]!.hostId = 'changed';
    },
    (a) => {
      a.normalizedInput!.inlineReferences![0]!.label = 'changed';
    },
    (a) => {
      a.sourceMessages = a.sourceMessages.slice(1);
    },
    (a) => {
      a.sourceMessages = [...a.sourceMessages].reverse();
    },
    (a) => {
      a.sourceMessages[0]!.content.text = 'changed';
    },
    (a) => {
      a.sourceMessages[0]!.submittedContentDigest = `sha256:${'b'.repeat(64)}`;
    },
    (a) => {
      a.sourceMessages[0]!.submittedIntent = { skillIds: ['changed'] };
    },
  ];
  const ids = ['sessionId', 'turnId', 'runId', 'userMessageId', 'previousRootTurnId'] as const;
  for (const key of ids) {
    const changed = { ...rich, [key]: 'other' };
    assert.throws(() => owner.assertKnownAdmission(changed), /identity changed/);
  }
  for (const drift of drifts) {
    const changed = structuredClone(rich);
    drift(changed);
    assert.throws(() => owner.assertKnownAdmission(changed), /identity changed/);
  }
  for (const original of [plain, empty]) {
    const changed = structuredClone(original);
    changed.normalizedInput = original.normalizedInput
      ? { text: 'plain', inlineReferences: [] }
      : { text: '' };
    assert.throws(() => owner.assertKnownAdmission(changed), /identity changed/);
  }
  await assert.rejects(owner.recoverSession('session'), /already installed/);
});

test('historical conflict snapshots are complete and drifted or unknown conflicts poison the owner', async () => {
  for (const drift of ['content', 'metadata', 'unknown']) {
    const original = admission('old', { text: 'old', quotes: [{ text: 'quote' }] });
    original.sourceMessages[0]!.submittedIntent = { skillIds: ['writer'] };
    const saved = structuredClone(original);
    const latest = admission('latest', { text: 'latest' });
    const owner = new RootAdmissionOwner(storeFor([original, latest]));
    await owner.recoverSession('session');
    const input = {
      sessionId: 'session',
      turnId: 'retry',
      proposedRunId: 'retry',
      proposedUserMessageId: null,
      execution: original.execution,
      normalizedInput: original.normalizedInput,
      sourceMessages: [],
      admittedAt: 3,
    };
    const conflict = await owner.admitRootTurn(input);
    assert.equal(conflict.kind, 'conflict');
    assert.deepEqual(conflict.admission, saved);
    assert.notEqual(conflict.admission, original);
    assert.throws(() => {
      conflict.admission.normalizedInput!.quotes![0]!.text = 'mutation';
    }, TypeError);
    if (drift === 'content') original.sourceMessages[0]!.content.text = 'changed';
    if (drift === 'metadata') {
      (original.sourceMessages[0]!.submittedIntent!.skillIds as string[])[0] = 'other';
    }
    if (drift === 'unknown') original.turnId = 'unknown';
    owner.assertKnownAdmission(saved);
    assert.throws(() => owner.assertKnownAdmission(original), /identity changed/);
    await assert.rejects(owner.admitRootTurn(input), /outside the owned chain/);
    await assert.rejects(owner.admitRootTurn(input), /admission state is uncertain/);
    assert.equal(owner.latestAdmission('session')?.turnId, 'latest');
  }
});

function admission(turnId: string, content: MessageContent | null): RootTurnAdmission {
  return {
    schemaVersion: 1,
    sessionId: 'session',
    turnId,
    runId: `run-${turnId}`,
    userMessageId: null,
    previousRootTurnId: null,
    execution: { kind: 'external_message' },
    normalizedInput: content,
    sourceMessages: content
      ? [
          {
            messageId: `message-${turnId}`,
            content: structuredClone(content),
            placement: 'next_turn',
            disposition: 'turn_started',
          },
        ]
      : [],
    admittedAt: 1,
  };
}

function storeFor(admissions: RootTurnAdmission[]): RootTurnAdmissionStore {
  return {
    admitRootTurn: async () => ({ kind: 'conflict', admission: admissions[0]! }),
    readRootTurnAdmission: async () => admissions[0],
    readRootTurnContinuationAdmission: async () => undefined,
    readRootTurnSourceMessageReceipt: async () => undefined,
    listRootTurnAdmissionsForRecovery: async () => admissions,
  };
}

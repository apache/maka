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
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  type RootTurnAdmission,
  type RootTurnAdmissionStore,
  type RootTurnSourceMessage,
} from '@maka/storage';
import { createSqliteAgentRunStore } from '@maka/storage';
import { RootAdmissionOwner } from '../server/root-admission-owner.js';
import { SessionAdmissionGate } from '../server/session-admission-gate.js';

test('poisons a Session after an ambiguous durable admission failure', async () => {
  await withStore(async (durableStore) => {
    let failAfterCommit = true;
    const store: RootTurnAdmissionStore = {
      admitRootTurn: async (input) => {
        const result = await durableStore.admitRootTurn(input);
        if (failAfterCommit) {
          failAfterCommit = false;
          throw new Error('post-commit durability failure');
        }
        return result;
      },
      readRootTurnAdmission: (sessionId, turnId) =>
        durableStore.readRootTurnAdmission(sessionId, turnId),
      readRootTurnSourceMessageReceipt: (sessionId, sourceMessageId) =>
        durableStore.readRootTurnSourceMessageReceipt(sessionId, sourceMessageId),
      listRootTurnAdmissionsForRecovery: (sessionId) =>
        durableStore.listRootTurnAdmissionsForRecovery(sessionId),
    };
    const owner = new RootAdmissionOwner(store);
    await owner.recoverSession('session');
    const gate = new SessionAdmissionGate();

    const outcomes = await Promise.allSettled([
      gate.run('session', () => owner.admitRootTurn(admitInput('session', 'turn-1', 10))),
      gate.run('session', () => owner.admitRootTurn(admitInput('session', 'turn-2', 20))),
    ]);
    assert.equal(outcomes[0]?.status, 'rejected');
    assert.equal(outcomes[1]?.status, 'rejected');
    if (outcomes[0]?.status === 'rejected') {
      assert.match(String(outcomes[0].reason), /post-commit durability failure/);
    }
    if (outcomes[1]?.status === 'rejected') {
      assert.match(String(outcomes[1].reason), /admission state is uncertain/);
    }

    const chain = await durableStore.listRootTurnAdmissionsForRecovery('session');
    assert.deepEqual(
      chain.map((admission) => admission.turnId),
      ['turn-1'],
    );
  });
});

test('recovery installs the validated tip and the successor extends it', async () => {
  await withStore(async (store) => {
    await store.admitRootTurn({
      ...admitInput('session', 'turn-1', 100),
      previousRootTurnId: null,
    });
    await store.admitRootTurn({
      ...admitInput('session', 'turn-2', 100),
      previousRootTurnId: 'turn-1',
    });
    const owner = new RootAdmissionOwner(store);
    const chain = await owner.recoverSession('session');
    assert.deepEqual(
      chain.map((admission) => admission.turnId),
      ['turn-1', 'turn-2'],
    );

    const successor = await owner.admitRootTurn(admitInput('session', 'turn-3', 100));
    assert.equal(successor.admission.previousRootTurnId, 'turn-2');
    assert.doesNotThrow(() => owner.assertKnownAdmission(successor.admission));
  });
});

test('fails closed when a known durable admission identity drifts', async () => {
  await withStore(async (store) => {
    const first = await store.admitRootTurn({
      ...multiSourceAdmitInput('session', 'turn-1', 10),
      previousRootTurnId: null,
    });
    const firstInput = first.admission.normalizedInput;
    assert.ok(firstInput);
    const owner = new RootAdmissionOwner(store);
    await owner.recoverSession('session');
    owner.assertKnownAdmission(first.admission);
    assert.throws(
      () => owner.assertKnownAdmission({ ...first.admission, runId: 'run-drifted' }),
      /identity changed/,
    );
    assert.throws(
      () =>
        owner.assertKnownAdmission({
          ...first.admission,
          normalizedInput: { ...firstInput, displayText: 'drifted' },
        }),
      /identity changed/,
    );
    assert.throws(
      () =>
        owner.assertKnownAdmission({
          ...first.admission,
          execution: {
            kind: 'linked_child_resume',
            agentId: 'local-read',
            agentName: 'Local Read',
            sourceRunId: 'source-run',
          },
        }),
      /identity changed/,
    );
    assert.throws(
      () =>
        owner.assertKnownAdmission({
          ...first.admission,
          normalizedInput: {
            ...firstInput,
            attachments: firstInput.attachments?.map((attachment, index) =>
              index === 0 ? { ...attachment, name: 'drifted.png' } : attachment,
            ),
          },
        }),
      /identity changed/,
    );
    const [firstSource] = first.admission.sourceMessages;
    assert.ok(firstSource);
    const sourceDrifts: RootTurnAdmission[] = [
      {
        ...first.admission,
        sourceMessages: [...first.admission.sourceMessages].reverse(),
      },
      {
        ...first.admission,
        sourceMessages: [
          { ...firstSource, messageId: 'source-drifted' },
          ...first.admission.sourceMessages.slice(1),
        ],
      },
      {
        ...first.admission,
        sourceMessages: [
          { ...firstSource, content: { ...firstSource.content, displayText: 'drifted source' } },
          ...first.admission.sourceMessages.slice(1),
        ],
      },
      {
        ...first.admission,
        sourceMessages: [
          { ...firstSource, placement: 'next_turn' },
          ...first.admission.sourceMessages.slice(1),
        ],
      },
      {
        ...first.admission,
        sourceMessages: [
          { ...firstSource, disposition: 'followup' },
          ...first.admission.sourceMessages.slice(1),
        ],
      },
    ];
    for (const drifted of sourceDrifts) {
      assert.throws(() => owner.assertKnownAdmission(drifted), /identity changed/);
    }
    await assert.rejects(() => owner.recoverSession('session'), /already installed/);
  });
});

test('snapshots recovered admissions without retaining mutable caller references', async () => {
  const admission = mutableAdmission();
  const store: RootTurnAdmissionStore = {
    admitRootTurn: async () => ({ kind: 'admitted', admission }),
    readRootTurnAdmission: async () => admission,
    readRootTurnSourceMessageReceipt: async () => undefined,
    listRootTurnAdmissionsForRecovery: async () => [admission],
  };
  const owner = new RootAdmissionOwner(store);
  const [snapshot] = await owner.recoverSession('session');
  assert.ok(snapshot);
  const snapshotInput = snapshot.normalizedInput;
  const admissionInput = admission.normalizedInput;
  assert.ok(snapshotInput);
  assert.ok(admissionInput);
  const mutableSources = admission.sourceMessages as RootTurnSourceMessage[];
  assert.throws(
    () =>
      owner.assertKnownAdmission({
        ...snapshot,
        normalizedInput: {
          ...snapshotInput,
          quotes: [...(snapshotInput.quotes ?? [])].reverse(),
        },
      }),
    /identity changed/,
  );
  assert.throws(
    () =>
      owner.assertKnownAdmission({
        ...snapshot,
        normalizedInput: {
          ...snapshotInput,
          quotes: snapshotInput.quotes?.map((quote, index) =>
            index === 0 ? { ...quote, sourceTurnId: 'turn-drifted' } : quote,
          ),
        },
      }),
    /identity changed/,
  );

  admissionInput.displayText = 'mutated display';
  admissionInput.attachments![0]!.name = 'mutated.png';
  admissionInput.attachments![0]!.ref = {
    kind: 'external_file',
    absolutePath: '/mutated.png',
  };
  admissionInput.quotes![0]!.text = 'mutated quote';
  admissionInput.quotes!.reverse();
  mutableSources[0]!.content.text = 'mutated source';
  mutableSources[0]!.content.attachments![0]!.ref = {
    kind: 'external_file',
    absolutePath: '/mutated-source.png',
  };
  mutableSources[0]!.content.quotes![0]!.sourceTurnId = 'turn-mutated';
  mutableSources[0]!.placement = 'next_turn';
  mutableSources.reverse();

  assert.equal(snapshotInput.displayText, 'display text\n\nfollowup text');
  assert.equal(snapshotInput.attachments?.[0]?.name, 'image.png');
  assert.deepEqual(snapshotInput.attachments?.[0]?.ref, {
    kind: 'workspace_file',
    relativePath: 'image.png',
  });
  assert.deepEqual(snapshotInput.quotes, [
    { text: 'first excerpt', label: 'Assistant', sourceTurnId: 'turn-source-1' },
    { text: 'second excerpt', sourceTurnId: 'turn-source-2' },
  ]);
  assert.deepEqual(
    snapshot.sourceMessages.map((source) => [source.messageId, source.content.text]),
    [
      ['source-1', 'model text'],
      ['source-2', 'followup text'],
    ],
  );
  assert.throws(() => {
    snapshotInput.quotes![0]!.text = 'returned mutation';
  }, TypeError);
  assert.doesNotThrow(() => owner.assertKnownAdmission(snapshot));
  assert.throws(() => owner.assertKnownAdmission(admission), /identity changed/);
});

test('returns an owned admission instead of retaining the mutable store result', async () => {
  const durableAdmission = mutableAdmission();
  const store: RootTurnAdmissionStore = {
    admitRootTurn: async () => ({ kind: 'admitted', admission: durableAdmission }),
    readRootTurnAdmission: async () => durableAdmission,
    readRootTurnSourceMessageReceipt: async () => undefined,
    listRootTurnAdmissionsForRecovery: async () => [],
  };
  const owner = new RootAdmissionOwner(store);
  await owner.recoverSession('session');

  const result = await owner.admitRootTurn(quotedMultiSourceAdmitInput('session', 'turn-1', 10));
  const resultInput = result.admission.normalizedInput;
  const durableInput = durableAdmission.normalizedInput;
  assert.ok(resultInput);
  assert.ok(durableInput);
  assert.notEqual(result.admission, durableAdmission);

  durableInput.quotes![0]!.text = 'store mutation';
  durableAdmission.sourceMessages[0]!.content.quotes![0]!.label = 'Store mutation';
  assert.deepEqual(resultInput.quotes, [
    { text: 'first excerpt', label: 'Assistant', sourceTurnId: 'turn-source-1' },
    { text: 'second excerpt', sourceTurnId: 'turn-source-2' },
  ]);
  assert.doesNotThrow(() => owner.assertKnownAdmission(result.admission));
  assert.throws(() => owner.assertKnownAdmission(durableAdmission), /identity changed/);
});

function admitInput(sessionId: string, turnId: string, admittedAt: number) {
  return {
    sessionId,
    turnId,
    proposedRunId: `run-${turnId}`,
    proposedUserMessageId: `message-${turnId}`,
    execution: { kind: 'external_message' as const },
    normalizedInput: { text: `text-${turnId}` },
    sourceMessages: [],
    admittedAt,
  };
}

function multiSourceAdmitInput(sessionId: string, turnId: string, admittedAt: number) {
  const attachment = {
    kind: 'image' as const,
    name: 'image.png',
    mimeType: 'image/png',
    bytes: 42,
    ref: { kind: 'workspace_file' as const, relativePath: 'image.png' },
  };
  return {
    sessionId,
    turnId,
    proposedRunId: `run-${turnId}`,
    proposedUserMessageId: `message-${turnId}`,
    execution: { kind: 'external_message' as const },
    normalizedInput: {
      text: 'model text\n\nfollowup text',
      displayText: 'display text\n\nfollowup text',
      attachments: [attachment],
    },
    sourceMessages: [
      {
        messageId: 'source-1',
        content: { text: 'model text', displayText: 'display text', attachments: [attachment] },
        placement: 'current_turn' as const,
        disposition: 'steering' as const,
      },
      {
        messageId: 'source-2',
        content: { text: 'followup text' },
        placement: 'next_turn' as const,
        disposition: 'followup' as const,
      },
    ],
    admittedAt,
  };
}

function quotedMultiSourceAdmitInput(sessionId: string, turnId: string, admittedAt: number) {
  const input = multiSourceAdmitInput(sessionId, turnId, admittedAt);
  const quotes = [
    { text: 'first excerpt', label: 'Assistant', sourceTurnId: 'turn-source-1' },
    { text: 'second excerpt', sourceTurnId: 'turn-source-2' },
  ];
  return {
    ...input,
    normalizedInput: { ...input.normalizedInput, quotes },
    sourceMessages: [
      {
        ...input.sourceMessages[0]!,
        content: { ...input.sourceMessages[0]!.content, quotes: [quotes[0]!] },
      },
      {
        ...input.sourceMessages[1]!,
        content: { ...input.sourceMessages[1]!.content, quotes: [quotes[1]!] },
      },
    ],
  };
}

function mutableAdmission(): RootTurnAdmission {
  const input = quotedMultiSourceAdmitInput('session', 'turn-1', 10);
  return {
    schemaVersion: 1,
    sessionId: input.sessionId,
    turnId: input.turnId,
    runId: input.proposedRunId,
    userMessageId: input.proposedUserMessageId,
    execution: input.execution,
    previousRootTurnId: null,
    normalizedInput: input.normalizedInput,
    sourceMessages: input.sourceMessages,
    admittedAt: input.admittedAt,
  };
}

async function withStore(
  run: (store: ReturnType<typeof createSqliteAgentRunStore>) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-root-admission-owner-'));
  try {
    await run(createSqliteAgentRunStore(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

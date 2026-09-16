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
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { messageContentDigest } from '@maka/core/events';
import { createSqliteAgentRunStore } from '../agent-run-store.js';
import { createSqliteRuntimeStore } from '../sqlite-runtime-store.js';
import type { CreateSessionInput } from '@maka/core/runtime-inputs';
import { createSessionStore } from '../session-store.js';
import { SqliteContextOffloadStore } from '../sqlite-context-offload-store.js';
import { runWithContextValueMutation } from '../context-value-mutation-gate.js';
import { importSessionBundleState } from '../session-bundle-policy.js';

function input(name: string): CreateSessionInput {
  return {
    cwd: '/tmp/cwd',
    llmConnectionSlug: 'fake',
    model: 'fake-model',
    permissionMode: 'auto_review' as const,
    name,
    labels: [],
  };
}

const LIMITS = {
  ownerMaxBytes: { read_image_snapshot: 4096, tool_result_archive: 4096 },
  sessionLogicalBytes: 1_000_000,
  workspacePhysicalBytes: 10_000_000,
};

async function seedSessionWithPayload(stateRoot: string, name: string): Promise<string> {
  const sessions = createSessionStore(stateRoot);
  let sessionId: string;
  try {
    sessionId = (await sessions.create(input(name))).id;
  } finally {
    await sessions.close?.();
  }
  // The real Store, not an approximation of it: the fence being tested is the
  // one the Store takes for its own publication and collection.
  const store = new SqliteContextOffloadStore(join(stateRoot, 'context-offload.sqlite'), {
    limits: LIMITS,
  });
  try {
    const put = await store.put({
      sessionId,
      owner: { kind: 'read_image_snapshot', ownerId: `shot-${name}` },
      bytes: new TextEncoder().encode(`payload-${name}`),
      mediaType: 'image/png',
    });
    assert.equal(put.ok, true);
  } finally {
    store.close();
  }
  return sessionId;
}

test('an import takes its turn in the target root context mutation queue', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-context-fence-'));
  const source = join(base, 'source');
  const target = join(base, 'target');
  try {
    const sessionId = await seedSessionWithPayload(source, 'Exported');
    await seedSessionWithPayload(target, 'Unrelated');

    // The Store's operations read database state, await, and only then act on
    // files -- collection decides a payload is unreferenced, awaits, unlinks
    // it. An import publishing inside that await leaves a reference pointing at
    // a file about to be removed, and the re-check collection performs cannot
    // see it because the check and the unlink straddle the await. Holding the
    // turn stands in for a Store operation in flight.
    const canonicalTarget = await realpath(target);
    let settle!: () => void;
    const held = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const holding = runWithContextValueMutation(canonicalTarget, () => held);

    let finished = false;
    const importing = importSessionBundleState({
      stateRoot: target,
      bundleStateRoot: source,
    }).then((result) => {
      finished = true;
      return result;
    });

    // Long enough for an import that ignores the queue to have run to the end.
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(finished, false, 'the import must wait for the turn in flight');

    settle();
    await holding;
    const imported = await importing;
    assert.deepEqual([...imported.sessionIds], [sessionId]);
    assert.equal(imported.contextRefs, 1);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('local review authorization survives reopen but is not trusted after a bundle import', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-bundle-review-authorization-'));
  const source = join(base, 'source');
  const target = join(base, 'target');
  try {
    const sessions = createSessionStore(source);
    const sessionId = (await sessions.create(input('Authorization'))).id;
    const content = { text: 'Expanded instructions', displayText: 'Inspect my notes' };
    const authenticatedUserRequests = ['Inspect my notes'];
    await sessions.commitMessageAdmission({
      sessionId,
      turnId: 'turn',
      runId: 'run',
      messageId: 'queued',
      content,
      authenticatedUserRequests,
      submittedContentDigest: messageContentDigest(content),
      submittedPlacement: 'next_turn',
      placement: 'next_turn',
      disposition: 'followup',
      skillInvocation: { loaded: [], failed: [], receipts: [] },
      admittedAt: 1,
    });
    await sessions.close?.();
    const admissions = createSqliteAgentRunStore(source);
    await admissions.admitRootTurn({
      sessionId,
      turnId: 'turn',
      proposedRunId: 'run',
      proposedUserMessageId: 'message',
      execution: { kind: 'external_message' },
      previousRootTurnId: null,
      normalizedInput: content,
      authenticatedUserRequests,
      sourceMessages: [
        {
          messageId: 'message',
          content,
          authenticatedUserRequests,
          placement: 'next_turn',
          disposition: 'followup',
        },
      ],
      admittedAt: 1,
    });
    admissions.close?.();
    const runtime = createSqliteRuntimeStore(join(source, 'runtime.sqlite'));
    await runtime.appendRuntimeEvent(sessionId, 'run', {
      id: 'event',
      sessionId,
      runId: 'run',
      turnId: 'turn',
      invocationId: 'invocation',
      ts: 1,
      partial: false,
      role: 'user',
      author: 'user',
      content: { kind: 'text', text: content.text, authenticatedUserRequests },
    });
    runtime.close();

    const assertEvidence = async (root: string, expected: readonly string[] | undefined) => {
      const store = createSessionStore(root);
      const roots = createSqliteAgentRunStore(root);
      const events = createSqliteRuntimeStore(join(root, 'runtime.sqlite'));
      try {
        const pending = await store.readMessageAdmission(sessionId, 'queued');
        assert.deepEqual(pending?.authenticatedUserRequests, expected);
        assert.deepEqual(pending?.content, content);
        const admission = await roots.readRootTurnAdmission(sessionId, 'turn');
        assert.deepEqual(admission?.authenticatedUserRequests, expected);
        assert.deepEqual(admission?.sourceMessages[0]?.authenticatedUserRequests, expected);
        assert.deepEqual(admission?.normalizedInput, content);
        const event = (await events.readRuntimeEvents(sessionId, 'run'))[0];
        assert.equal(event?.content?.kind, 'text');
        if (event?.content?.kind === 'text') {
          assert.deepEqual(event.content.authenticatedUserRequests, expected);
          assert.equal(event.content.text, content.text);
        }
      } finally {
        await store.close?.();
        roots.close?.();
        events.close();
      }
    };
    await assertEvidence(source, authenticatedUserRequests);
    await importSessionBundleState({ stateRoot: target, bundleStateRoot: source });
    await assertEvidence(target, undefined);
    await assertEvidence(source, authenticatedUserRequests);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

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
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { AGENT_GRAPH_INTENT_CLAIM_SCHEMA_VERSION } from '@maka/core/agent-graph-control';
import type { RootExecutionDescriptor } from '@maka/core/agent-run';
import { createSqliteAgentRunStore, type AdmitRootTurnInput } from '../agent-run-store.js';

describe('claimed agent graph root admission', () => {
  test('round-trips an exact, deeply frozen durable descriptor', async () => {
    await withTempRoot(async (_root, openStore) => {
      const store = openStore();
      const result = await store.admitRootTurn(admissionInput());
      assert.equal(result.kind, 'admitted');
      assert.equal(result.admission.execution.kind, 'claimed_agent_graph_intent');
      if (result.admission.execution.kind !== 'claimed_agent_graph_intent') return;
      assert.deepEqual(result.admission.execution.claim, claim());
      assert.equal(result.admission.execution.agentId, 'trusted-agent');
      assert.equal(result.admission.execution.agentName, 'Trusted Agent');
      assert.equal(Object.isFrozen(result.admission.execution), true);
      assert.equal(Object.isFrozen(result.admission.execution.claim), true);

      const reopened = openStore();
      const stored = await reopened.readRootTurnAdmission('session-child', 'turn-next');
      assert.deepEqual(stored, result.admission);
      assert.equal(Object.isFrozen(stored?.execution), true);
      if (stored?.execution.kind === 'claimed_agent_graph_intent') {
        assert.equal(Object.isFrozen(stored.execution.claim), true);
      }
    });
  });

  test('rejects descriptor unknown fields and malformed claims', async () => {
    await withTempRoot(async (_root, openStore) => {
      const store = openStore();
      await assert.rejects(
        () =>
          store.admitRootTurn(
            admissionInput({
              execution: {
                ...admissionInput().execution,
                unexpected: true,
              } as unknown as RootExecutionDescriptor,
            }),
          ),
        /Invalid root execution descriptor/,
      );
      await assert.rejects(
        () =>
          store.admitRootTurn(
            admissionInput({
              execution: {
                kind: 'claimed_agent_graph_intent',
                claim: { ...claim(), claimId: 'not-a-claim-id' },
                agentId: 'trusted-agent',
                agentName: 'Trusted Agent',
              } as unknown as RootExecutionDescriptor,
            }),
          ),
        /Invalid root execution descriptor/,
      );
      await assert.rejects(
        () =>
          store.admitRootTurn(
            admissionInput({
              execution: {
                kind: 'claimed_agent_graph_intent',
                claim: { ...claim(), unexpected: true },
                agentId: 'trusted-agent',
                agentName: 'Trusted Agent',
              } as unknown as RootExecutionDescriptor,
            }),
          ),
        /Invalid root execution descriptor/,
      );
    });
  });

  test('rejects every claim target identity drift before writing admission', async () => {
    await withTempRoot(async (root, openStore) => {
      const store = openStore();
      for (const [field, value] of [
        ['targetSessionId', 'different-session'],
        ['targetTurnId', 'different-turn'],
        ['targetRunId', 'different-run'],
      ] as const) {
        const sessionId = `session-drift-${field}`;
        const turnId = 'turn-next';
        await assert.rejects(
          () =>
            store.admitRootTurn(
              admissionInput({
                sessionId,
                execution: {
                  kind: 'claimed_agent_graph_intent',
                  claim: {
                    ...claim({
                      targetSessionId: sessionId,
                      targetTurnId: turnId,
                      targetRunId: 'run-next',
                    }),
                    [field]: value,
                  },
                  agentId: 'trusted-agent',
                  agentName: 'Trusted Agent',
                },
              }),
            ),
          /claim target does not match admission identity/,
        );
        await assert.rejects(
          access(join(root, 'sessions', sessionId, 'turn-admissions', `${turnId}.json`)),
          (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT',
        );
      }
    });
  });

  test('rejects queue sources and a missing canonical UserMessage', async () => {
    await withTempRoot(async (root, openStore) => {
      const store = openStore();
      await assert.rejects(
        () =>
          store.admitRootTurn(
            admissionInput({
              normalizedInput: { text: 'queued graph prompt' },
              sourceMessages: [
                {
                  messageId: 'message-next',
                  content: { text: 'queued graph prompt' },
                  placement: 'current_turn',
                  disposition: 'turn_started',
                },
              ],
            }),
          ),
        /host-authored execution cannot have source messages/,
      );
      await assert.rejects(
        () =>
          store.admitRootTurn(
            admissionInput({
              proposedUserMessageId: null,
            }),
          ),
        /execution has an invalid UserMessage requirement/,
      );
      await assert.rejects(
        access(join(root, 'sessions', 'session-child', 'turn-admissions', 'turn-next.json')),
        (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT',
      );
    });
  });
});

function admissionInput(overrides: Partial<AdmitRootTurnInput> = {}): AdmitRootTurnInput {
  const sessionId = overrides.sessionId ?? 'session-child';
  const turnId = overrides.turnId ?? 'turn-next';
  const proposedRunId = overrides.proposedRunId ?? 'run-next';
  return {
    sessionId,
    turnId,
    proposedRunId,
    proposedUserMessageId: 'message-next',
    execution: {
      kind: 'claimed_agent_graph_intent',
      claim: claim({
        targetSessionId: sessionId,
        targetTurnId: turnId,
        targetRunId: proposedRunId,
      }),
      agentId: 'trusted-agent',
      agentName: 'Trusted Agent',
    },
    previousRootTurnId: null,
    normalizedInput: { text: 'canonical graph prompt' },
    sourceMessages: [],
    admittedAt: 50,
    ...overrides,
  };
}

function claim(
  overrides: Partial<ReturnType<typeof baseClaim>> = {},
): ReturnType<typeof baseClaim> {
  return { ...baseClaim(), ...overrides };
}

function baseClaim() {
  return {
    schemaVersion: AGENT_GRAPH_INTENT_CLAIM_SCHEMA_VERSION,
    claimId: `graph_claim_${'a'.repeat(32)}`,
    graphId: 'graph-1',
    intentId: `graph_intent_${'b'.repeat(32)}`,
    intentFingerprint: `sha256:${'c'.repeat(64)}`,
    readinessContextFingerprint: `sha256:${'d'.repeat(64)}`,
    targetOperatorId: 'summarizer',
    targetSessionId: 'session-child',
    targetTurnId: 'turn-next',
    targetRunId: 'run-next',
    claimedAt: 40,
  };
}

async function withTempRoot(
  run: (
    root: string,
    openStore: () => ReturnType<typeof createSqliteAgentRunStore>,
  ) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-claimed-graph-admission-'));
  const stores: ReturnType<typeof createSqliteAgentRunStore>[] = [];
  try {
    await run(root, () => {
      const store = createSqliteAgentRunStore(root);
      stores.push(store);
      return store;
    });
  } finally {
    for (const store of stores.reverse()) store.close?.();
    await rm(root, { recursive: true, force: true });
  }
}

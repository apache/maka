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
import { describe, test } from 'node:test';
import type { SessionHeader } from '@maka/core/session';
import type { SessionHeaderSnapshot } from '@maka/storage/execution-stores';
import type { RuntimePolicyStoresWriter } from '@maka/storage/runtime-policy-stores';
import type { ConnectionContext } from '../server/operation-dispatcher.js';
import { WorkHubActionEffectFailure } from '../server/workhub-coordination-action-gate.js';
import {
  HostWorkHubTargetExecutionAuthority,
  type WorkHubTargetExecutionAuthorityOptions,
} from '../server/workhub-target-execution-authority.js';

const CONTEXT: ConnectionContext = {
  hostEpoch: 'workhub-model-repair-test',
  connectionId: 'desktop',
  principal: 'local_os_user',
  acquireResidency: () => ({ release() {} }),
};

const PREPARATION = {
  actionId: 'delegate-tool',
  coordinationTurnId: 'coordination-turn',
  coordinationRunId: 'coordination-run',
  targetSessionId: 'target',
  targetSessionName: 'Target task',
};

describe('WorkHub target execution authority', () => {
  test('repairs an unavailable saved model before returning ready', async () => {
    const fixture = createFixture('removed-model', ['replacement-model']);
    await fixture.authority.prepare(PREPARATION, CONTEXT);

    assert.equal(fixture.model(), 'replacement-model');
    assert.equal(fixture.formRequests.length, 1);
    assert.equal(fixture.updates.length, 1);
    const request = await fixture.formRequests[0]!.create();
    assert.equal(request.fields[0]?.kind, 'single_select');
    assert.equal(request.fields[0]?.presentation, 'model_picker');
    await fixture.authority.assertReady('target');
  });

  test('offers compatible models from every configured connection', async () => {
    const fixture = createFixture('removed-model', ['same-connection-model'], 'accept', [
      configuredConnection('connection-2', 'second', 'Second account', ['cross-connection-model']),
    ]);

    await fixture.authority.prepare(PREPARATION, CONTEXT);

    const request = await fixture.formRequests[0]!.create();
    const field = request.fields[0];
    assert.equal(field?.kind, 'single_select');
    assert.deepEqual(
      field.options.map(({ label, description }) => ({ label, description })),
      [
        { label: 'same-connection-model', description: 'Test' },
        { label: 'cross-connection-model', description: 'Second account' },
      ],
    );
  });

  test('does not interrupt delegation when the saved model remains enabled', async () => {
    const fixture = createFixture('current-model', ['current-model', 'other-model']);
    await fixture.authority.prepare(PREPARATION, CONTEXT);

    assert.equal(fixture.formRequests.length, 0);
    assert.equal(fixture.updates.length, 0);
  });

  test('reopens model selection when the accepted replacement disappears before admission', async () => {
    const fixture = createFixture(
      'removed-model',
      ['first-replacement', 'second-replacement'],
      'accept',
      [],
      true,
    );

    await fixture.authority.prepare(PREPARATION, CONTEXT);

    assert.equal(fixture.model(), 'second-replacement');
    assert.equal(fixture.formRequests.length, 2);
    assert.equal(fixture.updates.length, 2);
  });

  test('cancellation leaves the target unchanged and fails before admission', async () => {
    const fixture = createFixture('removed-model', ['replacement-model'], 'cancel');

    await assert.rejects(
      fixture.authority.prepare(PREPARATION, CONTEXT),
      (error) => error instanceof WorkHubActionEffectFailure && error.code === 'operation_conflict',
    );
    assert.equal(fixture.model(), 'removed-model');
    assert.equal(fixture.updates.length, 0);
  });

  test('fails closed when the connection has no chat-capable replacement', async () => {
    const fixture = createFixture('removed-model', []);

    await assert.rejects(
      fixture.authority.prepare(PREPARATION, CONTEXT),
      (error) =>
        error instanceof WorkHubActionEffectFailure && error.code === 'operation_unavailable',
    );
    assert.equal(fixture.formRequests.length, 0);
  });
});

function createFixture(
  initialModel: string,
  enabledModelIds: readonly string[],
  answer: 'accept' | 'cancel' = 'accept',
  additionalConnections: readonly ReturnType<typeof configuredConnection>[] = [],
  invalidateFirstSelection = false,
) {
  let revision = 3;
  let model = initialModel;
  const formRequests: Array<Parameters<WorkHubTargetExecutionAuthorityOptions['requestForm']>[0]> =
    [];
  const updates: unknown[] = [];
  const snapshot = (): SessionHeaderSnapshot => ({
    header: {
      id: 'target',
      workspaceRoot: '/workspace',
      cwd: '/workspace',
      createdAt: 1,
      name: 'Target task',
      titleIsManual: false,
      isFlagged: false,
      labels: [],
      isArchived: false,
      status: 'active',
      statusUpdatedAt: 1,
      hasUnread: false,
      backend: 'ai-sdk',
      llmConnectionId: 'connection-1',
      llmConnectionSlug: 'test',
      connectionLocked: true,
      model,
      permissionMode: 'ask',
      collaborationMode: 'agent',
      orchestrationMode: 'default',
      schemaVersion: 1,
    } satisfies SessionHeader,
    revision,
    committedAt: revision,
  });
  const connection = configuredConnection('connection-1', 'test', 'Test', enabledModelIds);
  const connections = [connection, ...additionalConnections];
  const options: WorkHubTargetExecutionAuthorityOptions = {
    readSession: async () => snapshot(),
    runtimePolicy: {
      resolveExecutionConnection: async (
        locator: Parameters<
          RuntimePolicyStoresWriter['operations']['resolveExecutionConnection']
        >[0],
      ) => {
        const selected =
          locator.kind === 'bound'
            ? connections.find((candidate) => candidate.connectionId === locator.connectionId)
            : connections.find((candidate) => candidate.slug === locator.connectionSlug);
        return selected
          ? {
              kind: 'ready',
              connection: selected,
              secretMaterial: {},
              networkProxy: { enabled: false },
            }
          : { kind: 'not_found' };
      },
      connectionCatalog: {
        getSnapshot: async () => ({
          revision: 1,
          defaultTarget: null,
          connections,
        }),
      },
    } as unknown as WorkHubTargetExecutionAuthorityOptions['runtimePolicy'],
    requestForm: async (input) => {
      formRequests.push(input);
      const request = await input.create();
      const field = request.fields[0];
      assert.equal(field?.kind, 'single_select');
      return {
        createdAt: 1,
        answer:
          answer === 'cancel'
            ? { action: 'cancel', values: {} }
            : { action: 'accept', values: { targetModel: field.options[0]!.value } },
      };
    },
    updateModel: async (input) => {
      updates.push(input);
      if (input.expectedRevision !== revision) return 'revision_conflict';
      model = input.modelTarget.model;
      revision += 1;
      if (invalidateFirstSelection && updates.length === 1) {
        connection.enabledModelIds = connection.enabledModelIds.filter(
          (candidate) => candidate !== model,
        );
        connection.models = connection.models.filter((candidate) => candidate.id !== model);
        connection.catalogEntries = connection.catalogEntries.filter(
          (candidate) => candidate.id !== model,
        );
      }
      return 'committed';
    },
  };
  return {
    authority: new HostWorkHubTargetExecutionAuthority(options),
    formRequests,
    updates,
    model: () => model,
  };
}

function configuredConnection(
  connectionId: string,
  slug: string,
  name: string,
  enabledModelIds: readonly string[],
) {
  return {
    connectionId,
    revision: 1,
    slug,
    name,
    providerType: 'openai' as const,
    enabled: true,
    enabledModelIds,
    models: enabledModelIds.map((id) => ({ id, capabilities: { chat: true } })),
    modelSource: 'fetched' as const,
    catalogEntries: enabledModelIds.map((id) => ({
      id,
      displayName: id,
      canUseAsChatDefault: true,
      isDefault: false,
      thinkingLevels: [],
      supportsVision: false,
    })),
  };
}

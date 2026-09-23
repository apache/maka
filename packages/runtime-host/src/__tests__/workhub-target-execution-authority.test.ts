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
import { connectionModelChoiceValue } from '@maka/core/llm-connections';
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
    assert.equal(request.fields[0]?.kind, 'string');
    assert.equal(request.fields[0]?.presentation, 'model_picker');
    await fixture.authority.assertReady('target');
  });

  test('accepts a canonical model-catalog choice from another configured connection', async () => {
    const fixture = createFixture(
      'removed-model',
      ['same-connection-model'],
      'accept',
      [
        configuredConnection('connection-2', 'second', 'Second account', [
          'cross-connection-model',
        ]),
      ],
      false,
      1,
    );

    await fixture.authority.prepare(PREPARATION, CONTEXT);

    const request = await fixture.formRequests[0]!.create();
    const field = request.fields[0];
    assert.deepEqual(field, {
      kind: 'string',
      name: 'targetModel',
      label: 'Model for Target task',
      required: true,
      presentation: 'model_picker',
      minLength: 1,
    });
    assert.equal(fixture.model(), 'cross-connection-model');
  });

  test('does not interrupt delegation when the saved model remains enabled', async () => {
    const fixture = createFixture('current-model', ['current-model', 'other-model']);
    await fixture.authority.prepare(PREPARATION, CONTEXT);

    assert.equal(fixture.formRequests.length, 0);
    assert.equal(fixture.updates.length, 0);
  });

  test('does not truncate a catalog larger than the generic form option limit', async () => {
    const models = Array.from({ length: 70 }, (_, index) => `replacement-${index}`);
    const fixture = createFixture('removed-model', models, 'accept', [], false, 0, 69);

    await fixture.authority.prepare(PREPARATION, CONTEXT);

    assert.equal(fixture.model(), 'replacement-69');
  });

  test('reopens selection when the shared catalog choice is not currently executable', async () => {
    const unavailable = connectionModelChoiceValue('connection-2', 'offline', 'offline-model');
    const available = connectionModelChoiceValue('connection-1', 'test', 'replacement-model');
    const fixture = createFixture(
      'removed-model',
      ['replacement-model'],
      'accept',
      [],
      false,
      0,
      0,
      [unavailable, available],
    );

    await fixture.authority.prepare(PREPARATION, CONTEXT);

    assert.equal(fixture.formRequests.length, 2);
    assert.match(
      (await fixture.formRequests[1]!.create()).message,
      /selected model cannot currently run/,
    );
    assert.equal(fixture.model(), 'replacement-model');
  });

  test('uses a fresh repair interaction after a Host restart changes the run', async () => {
    const first = createFixture('removed-model', ['replacement-model'], 'cancel');
    const second = createFixture('removed-model', ['replacement-model'], 'cancel');

    await assert.rejects(first.authority.prepare(PREPARATION, CONTEXT));
    await assert.rejects(
      second.authority.prepare(
        { ...PREPARATION, coordinationRunId: 'coordination-run-after-restart' },
        CONTEXT,
      ),
    );

    assert.notEqual(first.formRequests[0]!.requestId, second.formRequests[0]!.requestId);
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
  answerConnectionIndex = 0,
  answerModelIndex = 0,
  answerValues: readonly string[] = [],
) {
  let revision = 3;
  let model = initialModel;
  let connectionId = 'connection-1';
  let connectionSlug = 'test';
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
      llmConnectionId: connectionId,
      llmConnectionSlug: connectionSlug,
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
      assert.equal(field?.kind, 'string');
      const selectedConnection = connections[answerConnectionIndex]!;
      const selectedModel = selectedConnection.enabledModelIds[answerModelIndex]!;
      const selectedValue =
        answerValues[formRequests.length - 1] ??
        connectionModelChoiceValue(
          selectedConnection.connectionId,
          selectedConnection.slug,
          selectedModel,
        );
      return {
        createdAt: 1,
        answer:
          answer === 'cancel'
            ? { action: 'cancel', values: {} }
            : {
                action: 'accept',
                values: { targetModel: selectedValue },
              },
      };
    },
    updateModel: async (input) => {
      updates.push(input);
      if (input.expectedRevision !== revision) return 'revision_conflict';
      model = input.modelTarget.model;
      connectionId = input.modelTarget.connectionId;
      connectionSlug = input.modelTarget.connectionSlug;
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

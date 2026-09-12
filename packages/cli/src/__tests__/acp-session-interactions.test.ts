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
import {
  agent,
  client,
  methods,
  RequestError,
  type ClientCapabilities,
  type CreateElicitationRequest,
  type CreateElicitationResponse,
  type ElicitationFormMode,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
} from '@agentclientprotocol/sdk';
import type { InteractionRequest } from '@maka/core/interaction';
import { RuntimeHostOperationError, type RuntimeHostConnection } from '@maka/runtime-host/client';
import type {
  InteractionAnswerInput,
  InteractionAnsweredSnapshot,
  InteractionClosedSnapshot,
  InteractionPendingSnapshot,
  InteractionResolvedSnapshot,
  InteractionSnapshot,
} from '@maka/runtime-host/protocol';
import {
  AcpSessionInteractions,
  type AcpInteractionClient,
  type AcpSessionInteractionsOptions,
} from '../acp/session-interactions.js';

describe('ACP Session interactions', () => {
  test('official SDK routes carry typed forms and Session-scoped permission choices', async () => {
    const inputs = [fullForm(), capability()];
    const fixtures: ReturnType<typeof interactionFixture>[] = [];
    const values = {
      email: 'sdk@example.com',
      count: 3,
      ratio: 0.5,
      enabled: true,
      color: 'r',
      tags: ['x'],
    };
    let elicitationCalls = 0;
    let permissionCalls = 0;
    const sdkAgent = agent({ name: 'interaction-test-agent' })
      .onRequest(methods.agent.initialize, () => ({ protocolVersion: 1, agentCapabilities: {} }))
      .onRequest(methods.agent.session.prompt, async ({ client: peer }) => {
        const pending = inputs.shift();
        assert.ok(pending);
        const fixture = interactionFixture(pending, {
          client: {
            capabilities: { elicitation: { form: {} } },
            createElicitation: (params, signal) =>
              peer.request(methods.client.elicitation.create, params, {
                cancellationSignal: signal,
              }),
            requestPermission: (params, signal) =>
              peer.request(methods.client.session.requestPermission, params, {
                cancellationSignal: signal,
              }),
          },
        });
        fixtures.push(fixture);
        await fixture.bridge.pending(pending);
        return { stopReason: 'end_turn' };
      });
    const sdkClient = client({ name: 'interaction-test-client' })
      .onRequest(methods.client.elicitation.create, ({ params }) => {
        elicitationCalls += 1;
        assert.equal(params.mode, 'form');
        return { action: 'accept', content: values };
      })
      .onRequest(methods.client.session.requestPermission, ({ params }) => {
        permissionCalls += 1;
        assert.equal(params.options[0].kind, 'allow_always');
        return { outcome: { outcome: 'selected', optionId: params.options[0].optionId } };
      });
    await sdkClient.connectWith(sdkAgent, async (peer) => {
      await peer.request(methods.agent.initialize, {
        protocolVersion: 1,
        clientCapabilities: { elicitation: { form: {} } },
      });
      for (let index = 0; index < 2; index += 1) {
        assert.deepEqual(
          await peer.request(methods.agent.session.prompt, {
            sessionId: 'session-1',
            prompt: [{ type: 'text', text: 'Go' }],
          }),
          { stopReason: 'end_turn' },
        );
      }
    });
    assert.equal(elicitationCalls, 1);
    assert.equal(permissionCalls, 1);
    assert.deepEqual(fixtures[0].answers[0].answer, { kind: 'form', action: 'accept', values });
    assert.deepEqual(fixtures[1].answers[0].answer, {
      kind: 'client_capability',
      decision: 'allow',
    });
    assert.deepEqual(
      fixtures.flatMap((fixture) => fixture.failures),
      [],
    );
  });

  test('questions preserve option hints, free text and individual unanswered questions', async () => {
    const pending = snapshot({
      kind: 'question',
      toolUseId: 'tool-1',
      questions: [
        {
          question: 'Approach?',
          options: [{ label: 'Small', description: 'Minimal edit' }, { label: 'Large' }],
        },
        { question: 'When?', options: [{ label: 'Now' }, { label: 'Later' }] },
        { question: 'Who?', options: [{ label: 'You' }, { label: 'Me' }] },
      ],
    });
    const fixture = interactionFixture(pending);
    const task = fixture.bridge.pending(pending);
    const request = await fixture.elicited.promise;
    assert.equal(request.mode, 'form');
    assert.ok('sessionId' in request);
    assert.ok('toolCallId' in request);
    assert.equal(request.sessionId, pending.sessionId);
    assert.equal(request.toolCallId, 'tool-1');
    const schema = (request as ElicitationFormMode).requestedSchema;
    assert.ok(schema.properties);
    assert.deepEqual(schema.required, []);
    assert.equal(schema.properties.q0.type, 'string');
    assert.equal(schema.properties.q0.title, 'Approach?');
    assert.match(String(schema.properties.q0.description), /Small: Minimal edit/);
    assert.equal('enum' in schema.properties.q0, false);
    fixture.elicitationResponse.resolve({
      action: 'accept',
      content: { q0: ' A third option ', q1: '   ' },
    });
    await task;
    assert.deepEqual(
      fixture.answers.map(({ answer }) => answer),
      [{ kind: 'question', answers: ['A third option', null, null] }],
    );
    assert.equal(fixture.answered.length, 1);
    assert.equal(fixture.resolutions.length, 1);
    assert.deepEqual(fixture.failures, []);
  });

  test('form schemas preserve all field types and constrain accepted values without coercion', async () => {
    const pending = fullForm();
    const fixture = interactionFixture(pending);
    const task = fixture.bridge.pending(pending);
    const request = (await fixture.elicited.promise) as ElicitationFormMode;
    const schema = request.requestedSchema;
    assert.ok(schema.properties);
    assert.deepEqual(schema.required, ['email', 'count', 'ratio', 'enabled', 'color', 'tags']);
    assert.deepEqual(schema.properties.email, {
      type: 'string',
      title: 'Email',
      description: 'Contact address',
      format: 'email',
      minLength: 3,
      maxLength: 100,
    });
    assert.deepEqual(schema.properties.count, {
      type: 'integer',
      title: 'Count',
      minimum: 2,
      maximum: 4,
    });
    assert.deepEqual(schema.properties.ratio, {
      type: 'number',
      title: 'Ratio',
      minimum: 0.1,
      maximum: 1,
    });
    assert.deepEqual(schema.properties.enabled, {
      type: 'boolean',
      title: 'Enabled',
      default: false,
    });
    assert.deepEqual(schema.properties.color, {
      type: 'string',
      title: 'Color',
      oneOf: [
        { const: 'r', title: 'Red' },
        { const: 'b', title: 'Blue' },
      ],
    });
    assert.deepEqual(schema.properties.tags, {
      type: 'array',
      title: 'Tags',
      items: {
        anyOf: [
          { const: 'x', title: 'X' },
          { const: 'y', title: 'Y' },
        ],
      },
      minItems: 1,
      maxItems: 2,
    });
    const values = {
      email: 'user@example.com',
      count: 2,
      ratio: 0.25,
      enabled: true,
      color: 'b',
      tags: ['x', 'y'],
    };
    fixture.elicitationResponse.resolve({ action: 'accept', content: values });
    await task;
    assert.deepEqual(fixture.answers[0]?.answer, { kind: 'form', action: 'accept', values });
    assert.deepEqual(fixture.failures, []);
  });

  test('form decline and cancel remain distinct and never submit content or defaults', async () => {
    for (const action of ['decline', 'cancel'] as const) {
      const fixture = interactionFixture(fullForm());
      fixture.elicitationResponse.resolve({
        action,
        content: { enabled: true },
      } as CreateElicitationResponse);
      await fixture.bridge.pending(fixture.initial);
      assert.deepEqual(fixture.answers[0]?.answer, { kind: 'form', action });
    }
    const fixture = interactionFixture(
      snapshot({
        kind: 'form',
        toolUseId: 'tool-1',
        requester: { name: 'MCP' },
        message: 'Optional fields',
        fields: [
          { name: 'optional', kind: 'boolean', label: 'Optional', required: false, default: true },
        ],
      }),
    );
    fixture.elicitationResponse.resolve({ action: 'accept', content: null });
    await fixture.bridge.pending(fixture.initial);
    assert.deepEqual(fixture.answers[0]?.answer, { kind: 'form', action: 'accept', values: {} });
  });

  test('question decline and cancel preserve the core unanswered meaning', async () => {
    for (const action of ['decline', 'cancel'] as const) {
      const fixture = interactionFixture(question());
      fixture.elicitationResponse.resolve({ action });
      await fixture.bridge.pending(fixture.initial);
      assert.deepEqual(fixture.answers[0]?.answer, { kind: 'question', answers: [null] });
      assert.deepEqual(fixture.cancelled, []);
    }
  });

  test('rejects invalid typed forms, unknown fields and oversized Unicode answers before Host mutation', async () => {
    const good = {
      email: 'user@example.com',
      count: 2,
      ratio: 0.25,
      enabled: false,
      color: 'r',
      tags: ['x'],
    };
    for (const content of [
      { ...good, count: '2' },
      { ...good, count: 2.5 },
      { ...good, count: 1 },
      { ...good, enabled: 'false' },
      { ...good, color: 'green' },
      { ...good, tags: ['x', 'x'] },
      { ...good, email: 'invalid-email' },
      { ...good, unexpected: true },
      {},
    ]) {
      const fixture = interactionFixture(fullForm());
      fixture.elicitationResponse.resolve({ action: 'accept', content });
      await fixture.bridge.pending(fixture.initial);
      assert.equal(fixture.answers.length, 0);
      assert.equal(fixture.failures.length, 1);
    }
    for (const content of [{ wrong: 'answer' }, { q0: false }, { q0: '界'.repeat(700) }]) {
      const fixture = interactionFixture(question());
      fixture.elicitationResponse.resolve({ action: 'accept', content });
      await fixture.bridge.pending(fixture.initial);
      assert.equal(fixture.answers.length, 0);
      assert.equal(errorCode(fixture.failures[0]), 'invalid_interaction_answer');
    }
  });

  test('permission options bind opaque identifiers to the exact Session capability target', async () => {
    const pending = capability();
    const fixture = interactionFixture(pending);
    const task = fixture.bridge.pending(pending);
    const request = await fixture.permissionRequested.promise;
    assert.equal(request.sessionId, pending.sessionId);
    assert.equal(request.toolCall.toolCallId, 'tool-1');
    assert.deepEqual(
      request.options.map((option) => option.kind),
      ['allow_always', 'reject_once'],
    );
    assert.match(request.options[0].name, /this Session/);
    assert.notEqual(request.options[0].optionId, 'allow');
    assert.notEqual(request.options[0].optionId, request.options[1].optionId);
    const content = request.toolCall.content?.[0];
    assert.equal(content?.type, 'content');
    assert.ok(content?.type === 'content' && content.content.type === 'text');
    assert.match(content.content.text, /provider-1/);
    assert.match(content.content.text, /contract-1/);
    assert.match(content.content.text, /mcp_tool/);
    fixture.permissionResponse.resolve({
      outcome: { outcome: 'selected', optionId: request.options[0].optionId },
    });
    await task;
    assert.deepEqual(fixture.answers, [
      {
        sessionId: 'session-1',
        interactionId: 'interaction-1',
        answer: { kind: 'client_capability', decision: 'allow' },
      },
    ]);
  });

  test('sandbox permissions display exact expansion and preserve Host conflict outcomes', async () => {
    const pending = snapshot({
      kind: 'sandbox_boundary',
      justification: 'Read shared fixtures',
      expansion: {
        filesystem: {
          entries: [{ path: '/workspace/fixtures', access: 'read', scope: 'subtree' }],
        },
        network: { enabled: true },
      },
    });
    const fixture = interactionFixture(pending);
    fixture.hostAnswer = async (input) => ({
      ...pending,
      revision: 2,
      status: 'answered',
      outcome: {
        kind: 'sandbox_boundary_decision',
        decision: 'allow',
        status: 'conflict',
        committedAt: 10,
      },
    });
    const task = fixture.bridge.pending(pending);
    const request = await fixture.permissionRequested.promise;
    assert.equal(request.toolCall.toolCallId, pending.interactionId);
    const serialized = JSON.stringify(request.toolCall.content);
    assert.match(serialized, /Read shared fixtures/);
    assert.match(serialized, /subtree/);
    assert.match(serialized, /network/);
    assert.equal(request.options[0].kind, 'allow_always');
    fixture.permissionResponse.resolve({
      outcome: { outcome: 'selected', optionId: request.options[0].optionId },
    });
    await task;
    assert.equal(fixture.resolutions[0]?.outcome.kind, 'sandbox_boundary_decision');
    assert.equal(
      fixture.resolutions[0]?.outcome.kind === 'sandbox_boundary_decision' &&
        fixture.resolutions[0].outcome.status,
      'conflict',
    );
  });

  test('permission cancellation stops the exact Turn and never becomes a denial', async () => {
    const fixture = interactionFixture(capability());
    fixture.permissionResponse.resolve({ outcome: { outcome: 'cancelled' } });
    await fixture.bridge.pending(fixture.initial);
    assert.deepEqual(fixture.cancelled, [fixture.initial]);
    assert.deepEqual(fixture.answers, []);
    assert.deepEqual(fixture.failures, []);
  });

  test('unadvertised elicitation and legacy live permission fail without synthetic answers', async () => {
    for (const capabilities of [
      {},
      { elicitation: {} },
      { elicitation: { form: null } },
      { elicitation: { url: {} } },
    ] as ClientCapabilities[]) {
      const fixture = interactionFixture(question(), { capabilities });
      await fixture.bridge.pending(fixture.initial);
      assert.equal(fixture.elicitationCalls, 0);
      assert.deepEqual(fixture.answers, []);
      assert.equal(errorCode(fixture.failures[0]), 'unsupported_interaction');
    }
    const fixture = interactionFixture(legacyPermission());
    await fixture.bridge.pending(fixture.initial);
    assert.equal(fixture.permissionCalls, 0);
    assert.deepEqual(fixture.answers, []);
    assert.equal(errorCode(fixture.failures[0]), 'unsupported_interaction');
  });

  test('an old permission already closed by Host recovery is observed without a dialog', async () => {
    const fixture = interactionFixture(legacyPermission());
    fixture.current = closed(fixture.initial, 'host_restarted');
    await fixture.bridge.pending(fixture.initial);
    assert.equal(fixture.permissionCalls, 0);
    assert.equal(fixture.resolutions[0]?.outcome.kind, 'closure');
    assert.equal(
      fixture.resolutions[0]?.outcome.kind === 'closure' && fixture.resolutions[0].outcome.reason,
      'host_restarted',
    );
    assert.deepEqual(fixture.answers, []);
    assert.deepEqual(fixture.failures, []);
  });

  test('deduplicates pending replay and publishes one authoritative external answer', async () => {
    const fixture = interactionFixture(question());
    const first = fixture.bridge.pending(fixture.initial);
    assert.equal(fixture.bridge.pending(fixture.initial), first);
    await fixture.elicited.promise;
    fixture.current = answered(fixture.initial, { kind: 'question', answers: ['External answer'] });
    await fixture.bridge.resolved(fixture.initial);
    await first;
    assert.equal(fixture.clientSignal?.aborted, true);
    fixture.elicitationResponse.resolve({ action: 'accept', content: { q0: 'Late answer' } });
    await fixture.bridge.pending(fixture.initial);
    await fixture.bridge.resolved(fixture.initial);
    assert.equal(fixture.elicitationCalls, 1);
    assert.deepEqual(fixture.answers, []);
    assert.equal(fixture.answered.length, 1);
    assert.equal(fixture.resolutions.length, 1);
  });

  test('late conflicting Host answers re-query canonical closure without failing the Turn', async () => {
    const fixture = interactionFixture(question());
    fixture.hostAnswer = async () => {
      fixture.current = closed(fixture.initial, 'producer_cancelled');
      throw new RuntimeHostOperationError(
        'interaction.answer',
        'already_resolved',
        'Already closed',
      );
    };
    fixture.elicitationResponse.resolve({ action: 'accept', content: { q0: 'Local reply' } });
    await fixture.bridge.pending(fixture.initial);
    assert.equal(fixture.answers.length, 1);
    assert.equal(
      fixture.resolutions[0]?.outcome.kind === 'closure' && fixture.resolutions[0].outcome.reason,
      'producer_cancelled',
    );
    assert.deepEqual(fixture.failures, []);
  });

  test('close and Turn cancellation release a client that ignores cancellation and late replies', async () => {
    for (const stop of ['close', 'cancel'] as const) {
      const fixture = interactionFixture(question());
      const task = fixture.bridge.pending(fixture.initial);
      await fixture.elicited.promise;
      if (stop === 'close') fixture.bridge.close();
      else fixture.bridge.cancelTurn(fixture.initial.turnId);
      await task;
      assert.equal(fixture.clientSignal?.aborted, true);
      fixture.elicitationResponse.reject(new Error('Late client failure'));
      await fixture.bridge.pending(fixture.initial);
      assert.deepEqual(fixture.answers, []);
      assert.deepEqual(fixture.failures, []);
      assert.equal(fixture.elicitationCalls, 1);
    }
  });

  test('closing while card delivery is blocked releases local work and sends no client request', async () => {
    const entered = deferred<void>();
    const delivery = deferred<void>();
    const fixture = interactionFixture(question(), {
      onPending: () => {
        entered.resolve();
        return delivery.promise;
      },
    });
    const task = fixture.bridge.pending(fixture.initial);
    await entered.promise;
    fixture.bridge.close();
    await task;
    delivery.reject(new Error('Late transport failure'));
    assert.equal(fixture.elicitationCalls, 0);
    assert.deepEqual(fixture.failures, []);
  });

  test('Turn cancellation releases reconciliation and notification delivery that have stalled', async () => {
    const querying = deferred<void>();
    const query = deferred<InteractionSnapshot>();
    const fixture = interactionFixture(question());
    fixture.hostAnswer = async () => {
      fixture.hostQuery = () => {
        querying.resolve();
        return query.promise;
      };
      throw new RuntimeHostOperationError('interaction.answer', 'already_resolved', 'Resolved');
    };
    fixture.elicitationResponse.resolve({ action: 'accept', content: { q0: 'Reply' } });
    const task = fixture.bridge.pending(fixture.initial);
    await querying.promise;
    fixture.bridge.cancelTurn(fixture.initial.turnId);
    await task;
    query.reject(new Error('Late Host failure'));
    assert.deepEqual(fixture.failures, []);

    const entered = deferred<void>();
    const delivery = deferred<void>();
    const notifying = interactionFixture(question(), {
      onResolved: () => {
        entered.resolve();
        return delivery.promise;
      },
    });
    notifying.elicitationResponse.resolve({ action: 'accept', content: { q0: 'Reply' } });
    const notificationTask = notifying.bridge.pending(notifying.initial);
    await entered.promise;
    notifying.bridge.cancelTurn(notifying.initial.turnId);
    await notificationTask;
    delivery.reject(new Error('Late notification failure'));
    assert.deepEqual(notifying.failures, []);
  });

  test('unknown permission choices and unrecognized elicitation actions fail instead of granting', async () => {
    const permission = interactionFixture(capability());
    permission.permissionResponse.resolve({ outcome: { outcome: 'selected', optionId: 'allow' } });
    await permission.bridge.pending(permission.initial);
    assert.deepEqual(permission.answers, []);
    assert.equal(errorCode(permission.failures[0]), 'invalid_interaction_answer');
    const form = interactionFixture(question());
    form.elicitationResponse.resolve({ action: '_unknown' });
    await form.bridge.pending(form.initial);
    assert.deepEqual(form.answers, []);
    assert.equal(errorCode(form.failures[0]), 'invalid_interaction_answer');
  });

  test('Host identities and failures cannot silently rebind a pending request', async () => {
    const fixture = interactionFixture(question());
    fixture.current = { ...fixture.initial, runId: 'another-run' };
    await fixture.bridge.pending(fixture.initial);
    assert.equal(fixture.elicitationCalls, 0);
    assert.deepEqual(fixture.answers, []);
    assert.equal(errorCode(fixture.failures[0]), 'invalid_interaction');
    const failing = interactionFixture(question());
    failing.hostAnswer = async () => {
      throw new RuntimeHostOperationError('interaction.answer', 'operation_conflict', 'Conflict');
    };
    failing.elicitationResponse.resolve({ action: 'accept', content: { q0: 'Reply' } });
    await failing.bridge.pending(failing.initial);
    assert.deepEqual(failing.failures[0]?.data, {
      source: 'runtime_host',
      operation: 'interaction.answer',
      code: 'operation_conflict',
    });
  });
});

function interactionFixture(
  initial: InteractionPendingSnapshot,
  options: {
    capabilities?: ClientCapabilities;
    client?: AcpInteractionClient;
    onPending?: AcpSessionInteractionsOptions['onPending'];
    onResolved?: AcpSessionInteractionsOptions['onResolved'];
  } = {},
) {
  const fixture = {
    initial,
    current: initial as InteractionSnapshot,
    answers: [] as InteractionAnswerInput[],
    answered: [] as InteractionAnsweredSnapshot[],
    resolutions: [] as InteractionResolvedSnapshot[],
    failures: [] as RequestError[],
    cancelled: [] as InteractionPendingSnapshot[],
    elicited: deferred<CreateElicitationRequest>(),
    permissionRequested: deferred<RequestPermissionRequest>(),
    elicitationResponse: deferred<CreateElicitationResponse>(),
    permissionResponse: deferred<RequestPermissionResponse>(),
    clientSignal: undefined as AbortSignal | undefined,
    elicitationCalls: 0,
    permissionCalls: 0,
    hostQuery: undefined as (() => Promise<InteractionSnapshot>) | undefined,
    hostAnswer: undefined as
      | ((input: InteractionAnswerInput) => Promise<InteractionAnsweredSnapshot>)
      | undefined,
    bridge: undefined! as AcpSessionInteractions,
  };
  const connection = {
    request: async (operation: string, input: InteractionAnswerInput) => {
      if (operation === 'interaction.query') return fixture.hostQuery?.() ?? fixture.current;
      assert.equal(operation, 'interaction.answer');
      fixture.answers.push(input);
      const result = fixture.hostAnswer
        ? await fixture.hostAnswer(input)
        : answered(initial, input.answer);
      fixture.current = result;
      return result;
    },
  } as Pick<RuntimeHostConnection, 'request'>;
  fixture.bridge = new AcpSessionInteractions({
    sessionId: initial.sessionId,
    connection,
    client: options.client ?? {
      capabilities: options.capabilities ?? { elicitation: { form: {} } },
      createElicitation: (request, signal) => {
        fixture.elicitationCalls += 1;
        fixture.clientSignal = signal;
        fixture.elicited.resolve(request);
        return fixture.elicitationResponse.promise;
      },
      requestPermission: (request, signal) => {
        fixture.permissionCalls += 1;
        fixture.clientSignal = signal;
        fixture.permissionRequested.resolve(request);
        return fixture.permissionResponse.promise;
      },
    },
    onPending: options.onPending ?? (async () => undefined),
    onAnswered: (result) => fixture.answered.push(result),
    onResolved: (result) => {
      fixture.resolutions.push(result);
      return options.onResolved?.(result, initial);
    },
    onFailure: (_, error) => fixture.failures.push(error),
    onCancelled: (pending) => fixture.cancelled.push(pending),
  });
  return fixture;
}

function snapshot(request: InteractionRequest): InteractionPendingSnapshot {
  return {
    schemaVersion: 1,
    interactionId: 'interaction-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    runId: 'run-1',
    revision: 1,
    status: 'pending',
    outcome: null,
    request,
  };
}

function question(): InteractionPendingSnapshot {
  return snapshot({
    kind: 'question',
    toolUseId: 'tool-1',
    questions: [{ question: 'Choose?', options: [{ label: 'A' }, { label: 'B' }] }],
  });
}

function fullForm(): InteractionPendingSnapshot {
  return snapshot({
    kind: 'form',
    toolUseId: 'tool-1',
    requester: { name: 'Example', source: 'MCP server' },
    message: 'Fill the form',
    fields: [
      {
        kind: 'string',
        name: 'email',
        label: 'Email',
        description: 'Contact address',
        required: true,
        minLength: 3,
        maxLength: 100,
        format: 'email',
      },
      {
        kind: 'integer',
        name: 'count',
        label: 'Count',
        required: true,
        minimum: 1.2,
        maximum: 4.9,
      },
      { kind: 'number', name: 'ratio', label: 'Ratio', required: true, minimum: 0.1, maximum: 1 },
      { kind: 'boolean', name: 'enabled', label: 'Enabled', required: true, default: false },
      {
        kind: 'single_select',
        name: 'color',
        label: 'Color',
        required: true,
        options: [
          { value: 'r', label: 'Red' },
          { value: 'b', label: 'Blue' },
        ],
      },
      {
        kind: 'multi_select',
        name: 'tags',
        label: 'Tags',
        required: true,
        options: [
          { value: 'x', label: 'X' },
          { value: 'y', label: 'Y' },
        ],
        minItems: 1,
        maxItems: 2,
      },
    ],
  });
}

function capability(): InteractionPendingSnapshot {
  return snapshot({
    kind: 'client_capability',
    toolUseId: 'tool-1',
    target: {
      providerId: 'provider-1',
      contractId: 'contract-1',
      serverId: 'server-1',
      toolName: 'read',
      capability: 'mcp',
      scope: { kind: 'mcp_tool', serverId: 'server-1', toolName: 'read' },
    },
  });
}

function legacyPermission(): InteractionPendingSnapshot {
  return snapshot({
    kind: 'permission',
    toolUseId: 'tool-1',
    prompt: {
      kind: 'tool_permission',
      toolName: 'Read',
      category: 'read',
      reason: 'custom',
      review: { kind: 'path', operation: 'read', path: '/workspace/file' },
      rememberForTurnAllowed: true,
    },
  });
}

function answered(
  pending: InteractionPendingSnapshot,
  answer: InteractionAnswerInput['answer'],
): InteractionAnsweredSnapshot {
  const base = { ...pending, revision: 2 as const, status: 'answered' as const };
  const committedAt = 10;
  switch (answer.kind) {
    case 'question':
      return {
        ...base,
        outcome: { kind: 'question_answer', answers: answer.answers, committedAt },
      };
    case 'form':
      return {
        ...base,
        outcome:
          answer.action === 'accept'
            ? { kind: 'form_answer', action: 'accept', values: answer.values, committedAt }
            : { kind: 'form_answer', action: answer.action, committedAt },
      };
    case 'client_capability':
      return {
        ...base,
        outcome: { kind: 'client_capability_decision', decision: answer.decision, committedAt },
      };
    case 'sandbox_boundary':
      return {
        ...base,
        outcome: {
          kind: 'sandbox_boundary_decision',
          decision: answer.decision,
          status: answer.decision === 'allow' ? 'approved' : 'denied',
          committedAt,
        },
      };
    case 'permission':
      throw new Error('Legacy permission has no live answer');
  }
}

function closed(
  pending: InteractionPendingSnapshot,
  reason: InteractionClosedSnapshot['outcome']['reason'],
): InteractionClosedSnapshot {
  return {
    ...pending,
    revision: 2,
    status: 'closed',
    outcome: { kind: 'closure', reason, committedAt: 10 },
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function errorCode(error: RequestError | undefined): unknown {
  const data = error?.data;
  return typeof data === 'object' && data !== null && 'code' in data ? data.code : undefined;
}

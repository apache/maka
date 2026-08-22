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
import { createManagedExecutionBoundary } from '@maka/core/sandbox-boundary';
import { createWorkspaceWritePermissionProfile } from '@maka/core/permission-profile';
import { ToolOutcomeUnknownError } from '@maka/core/events';
import type { McpCallResult } from '@maka/core/mcp';
import type { ClientCapabilityReplaceInput } from '../protocol/index.js';
import {
  ClientCapabilityInvocationError,
  HostClientCapabilityCoordinator,
} from '../server/client-capability-coordinator.js';
import type { ClientCapabilityConnection } from '../server/client-capability-service.js';
import { RuntimePolicyActivationGate } from '../server/runtime-policy-activation-gate.js';
import { clientCapabilityConnectionIdentity } from './fixtures/client-capability.js';

describe('Host Client Capability coordinator', () => {
  test('freezes active snapshots across replacement and releases stale registrations', async () => {
    const sent: unknown[] = [];
    const coordinator = createCoordinator();
    let connection!: ClientCapabilityConnection;
    connection = coordinator.attachConnection(clientCapabilityConnectionIdentity('connection-a'), {
      send: async (frame) => {
        sent.push(frame);
        if (frame.kind !== 'client.capability.call') return;
        queueMicrotask(() => {
          connection.accept({
            kind: 'client.capability.accepted',
            invocationId: frame.invocationId,
          });
          connection.accept({
            kind: 'client.capability.result',
            invocationId: frame.invocationId,
            result: textResult(`called:${frame.toolName}`),
          });
        });
      },
    });

    await replace(coordinator, 'connection-a', 'registration-a', 'opaque');
    assert.deepEqual(await coordinator.bindSession('session-a', 'connection-a'), { ok: true });
    const first = coordinator.snapshotForSession('session-a');
    assert.ok(first);
    assert.deepEqual(first.registrationIds, ['registration-a']);
    assert.equal(first.groups[0]?.label, 'Opaque capability');

    await replace(coordinator, 'connection-a', 'registration-b', 'opaque');
    assert.deepEqual(await coordinator.bindSession('session-a', 'connection-a'), { ok: true });
    const second = coordinator.snapshotForSession('session-a');
    assert.ok(second);
    assert.deepEqual(second.registrationIds, ['registration-b']);

    const firstResult = await invoke(first.tools[0]);
    assert.deepEqual(firstResult, textResult('called:opaque'));
    const call = sent.find(
      (
        frame,
      ): frame is {
        kind: 'client.capability.call';
        registrationId: string;
        sessionId: string;
        turnId: string;
        toolCallId: string;
        cwd: string;
      } => isRecord(frame) && frame.kind === 'client.capability.call',
    );
    assert.equal(call?.registrationId, 'registration-a');
    assert.deepEqual(
      call && {
        sessionId: call.sessionId,
        turnId: call.turnId,
        toolCallId: call.toolCallId,
        cwd: call.cwd,
      },
      {
        sessionId: 'session-a',
        turnId: 'turn-a',
        toolCallId: 'tool-call-a',
        cwd: '/tmp',
      },
    );

    first.release();
    assert.ok(
      sent.some(
        (frame) =>
          isRecord(frame) &&
          frame.kind === 'client.capability.registration_release' &&
          frame.registrationId === 'registration-a',
      ),
    );
    second.release();
    const unregistered = await coordinator.handlers['client.capability.unregister'](
      { registrationId: 'registration-b' },
      connectionContext('connection-a'),
    );
    assert.equal(unregistered.ok, true);
    assert.equal(coordinator.snapshotForSession('session-a'), undefined);
    connection.close();
    await coordinator.close();
  });

  test('does not trust a self-declared provider or disclose Host cwd', async () => {
    const coordinator = createCoordinator();
    let observedCall: unknown;
    let connection!: ClientCapabilityConnection;
    connection = coordinator.attachConnection(clientCapabilityConnectionIdentity('connection-a'), {
      send: async (frame) => {
        if (frame.kind !== 'client.capability.call') return;
        observedCall = frame;
        connection.accept({
          kind: 'client.capability.accepted',
          invocationId: frame.invocationId,
        });
        connection.accept({
          kind: 'client.capability.result',
          invocationId: frame.invocationId,
          result: textResult('path independent'),
        });
      },
    });
    const replaced = await coordinator.handlers['client.capability.replace'](
      {
        registrationId: 'registration-a',
        offers: [
          {
            offerId: 'path-independent',
            version: '0',
            affinity: 'session',
            hostPathAccess: 'none',
            label: 'Path independent',
            tools: [
              {
                serverId: 'remote',
                name: 'inspect',
                inputSchema: { type: 'object' },
              },
            ],
          },
        ],
      },
      connectionContext('connection-a'),
    );
    assert.equal(replaced.ok, true);
    assert.deepEqual(await coordinator.bindSession('session-a', 'connection-a'), { ok: true });
    const snapshot = coordinator.snapshotForSession('session-a');
    assert.ok(snapshot);
    assert.equal(snapshot.tools[0]?.categoryHint, 'client_capability');
    await invoke(snapshot.tools[0]);
    assert.ok(isRecord(observedCall));
    assert.equal(Object.hasOwn(observedCall, 'cwd'), false);
    snapshot.release();
    await connection.close();
    await coordinator.close();
  });

  test('trusted provider tools execute remotely without inheriting Host authority', async () => {
    const coordinator = createCoordinator();
    let observedCall: unknown;
    let connection!: ClientCapabilityConnection;
    connection = coordinator.attachConnection(
      clientCapabilityConnectionIdentity(
        'connection-a',
        'connection-a',
        'test-principal',
        'capability_provider',
      ),
      {
        send: async (frame) => {
          if (frame.kind !== 'client.capability.call') return;
          observedCall = frame;
          connection.accept({
            kind: 'client.capability.accepted',
            invocationId: frame.invocationId,
          });
          connection.accept({
            kind: 'client.capability.result',
            invocationId: frame.invocationId,
            result: textResult('remote result'),
          });
        },
      },
    );
    const input: ClientCapabilityReplaceInput = {
      registrationId: 'registration-a',
      offers: [
        {
          offerId: 'remote-provider',
          version: '0',
          affinity: 'session',
          hostPathAccess: 'none',
          label: 'Remote provider',
          tools: [
            {
              serverId: 'remote',
              name: 'inspect',
              inputSchema: { type: 'object' },
            },
          ],
        },
      ],
    };
    const trustedContext = connectionContext('connection-a');
    assert.equal(
      (await coordinator.handlers['client.capability.replace'](input, trustedContext)).ok,
      true,
    );
    assert.deepEqual(await coordinator.bindSession('session-a', 'connection-a'), { ok: true });
    const snapshot = coordinator.snapshotForSession('session-a');
    assert.ok(snapshot);
    const tool = snapshot.tools[0] ?? assert.fail('Expected trusted provider tool');
    assert.equal(tool.categoryHint, 'custom_tool');
    const result = await tool.impl(
      {},
      {
        sessionId: 'session-a',
        turnId: 'turn-a',
        cwd: '/host/workspace',
        toolCallId: 'tool-call-a',
        executionBoundary: createManagedExecutionBoundary(
          createWorkspaceWritePermissionProfile(),
          0,
        ),
        abortSignal: new AbortController().signal,
        emitOutput: () => undefined,
      },
    );
    assert.deepEqual(result, textResult('remote result'));
    assert.ok(isRecord(observedCall));
    assert.equal(Object.hasOwn(observedCall, 'cwd'), false);

    const rejected = await coordinator.handlers['client.capability.replace'](
      {
        ...input,
        registrationId: 'registration-b',
        offers: input.offers.map((offer) => ({ ...offer, affinity: 'call' as const })),
      },
      trustedContext,
    );
    assert.equal(rejected.ok, false);
    snapshot.release();
    await connection.close();
    await coordinator.close();
  });

  test('reports capability_lost before acceptance and outcome_unknown after acceptance', async () => {
    await assertLossClassification(false, 'capability_lost');
    await assertLossClassification(true, 'outcome_unknown');
  });

  test('prefers the initiating provider and reports otherwise ambiguous selection', async () => {
    const coordinator = createCoordinator();
    const first = coordinator.attachConnection(clientCapabilityConnectionIdentity('connection-a'), {
      send: async () => {},
    });
    const second = coordinator.attachConnection(
      clientCapabilityConnectionIdentity('connection-b'),
      { send: async () => {} },
    );
    await replace(coordinator, 'connection-a', 'registration-a', 'first');
    assert.deepEqual(await coordinator.bindSession('sole-session', 'observer'), { ok: true });
    const sole = coordinator.snapshotForSession('sole-session');
    assert.deepEqual(sole?.registrationIds, ['registration-a']);
    sole?.release();
    await replace(coordinator, 'connection-b', 'registration-b', 'first');

    const ambiguous = await coordinator.bindSession('ambiguous-session', 'observer');
    assert.equal(ambiguous.ok, false);
    if (!ambiguous.ok) assert.match(ambiguous.message, /Multiple Client Capability providers/);

    assert.deepEqual(await coordinator.bindSession('selected-session', 'connection-b'), {
      ok: true,
    });
    const snapshot = coordinator.snapshotForSession('selected-session');
    assert.deepEqual(snapshot?.registrationIds, ['registration-b']);
    snapshot?.release();
    first.close();
    second.close();
    await coordinator.close();
  });

  test('previews the initiating provider without persisting a Session binding', async () => {
    const coordinator = createCoordinator();
    const connection = coordinator.attachConnection(
      clientCapabilityConnectionIdentity('connection-a'),
      { send: async () => {} },
    );
    await replace(coordinator, 'connection-a', 'registration-a', 'inspect');

    assert.equal(coordinator.snapshotForSession('session-a'), undefined);
    const preview = await coordinator.runWithSessionBindingPreview(
      'session-a',
      'connection-a',
      async () => {
        const snapshot = coordinator.snapshotForSession('session-a');
        assert.deepEqual(snapshot?.registrationIds, ['registration-a']);
        snapshot?.release();
        return 'previewed';
      },
    );
    assert.equal(preview.ok, true);
    if (preview.ok) {
      assert.equal(preview.value, 'previewed');
      assert.equal(typeof preview.commit, 'function');
    }
    assert.equal(coordinator.snapshotForSession('session-a'), undefined);

    connection.close();
    await coordinator.close();
  });

  test('holds one registry view through preview and rejects a stale commit', async () => {
    const coordinator = createCoordinator();
    const connection = coordinator.attachConnection(
      clientCapabilityConnectionIdentity('connection-a'),
      { send: async () => {} },
    );
    await replace(coordinator, 'connection-a', 'registration-a', 'inspect');
    let markPreviewStarted!: () => void;
    const previewStarted = new Promise<void>((resolve) => {
      markPreviewStarted = resolve;
    });
    let releasePreview!: () => void;
    const previewGate = new Promise<void>((resolve) => {
      releasePreview = resolve;
    });
    const previewTask = coordinator.runWithSessionBindingPreview(
      'session-a',
      'connection-a',
      async () => {
        const before = coordinator.snapshotForSession('session-a');
        assert.deepEqual(before?.registrationIds, ['registration-a']);
        before?.release();
        markPreviewStarted();
        await previewGate;
        const after = coordinator.snapshotForSession('session-a');
        assert.deepEqual(after?.registrationIds, ['registration-a']);
        after?.release();
        return 'stable';
      },
    );
    await previewStarted;
    let replacementSettled = false;
    const replacement = replace(
      coordinator,
      'connection-a',
      'registration-b',
      'inspect_changed',
    ).finally(() => {
      replacementSettled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(replacementSettled, false);

    releasePreview();
    const preview = await previewTask;
    assert.equal(preview.ok, true);
    await replacement;
    if (preview.ok) {
      assert.equal(preview.value, 'stable');
      const committed = await preview.commit();
      assert.equal(committed.ok, false);
      if (!committed.ok) assert.match(committed.message, /registry changed/);
    }
    assert.equal(coordinator.snapshotForSession('session-a'), undefined);

    connection.close();
    await coordinator.close();
  });

  test('serializes connection release behind an active binding preview', async () => {
    const coordinator = createCoordinator();
    const connection = coordinator.attachConnection(
      clientCapabilityConnectionIdentity('connection-a'),
      { send: async () => {} },
    );
    await replace(coordinator, 'connection-a', 'registration-a', 'inspect');
    let markPreviewStarted!: () => void;
    const previewStarted = new Promise<void>((resolve) => {
      markPreviewStarted = resolve;
    });
    let releasePreview!: () => void;
    const previewGate = new Promise<void>((resolve) => {
      releasePreview = resolve;
    });
    const previewTask = coordinator.runWithSessionBindingPreview(
      'session-a',
      'connection-a',
      async () => {
        markPreviewStarted();
        await previewGate;
        const snapshot = coordinator.snapshotForSession('session-a');
        assert.deepEqual(snapshot?.registrationIds, ['registration-a']);
        snapshot?.release();
        return 'stable';
      },
    );
    await previewStarted;

    connection.close();
    releasePreview();
    const preview = await previewTask;
    assert.equal(preview.ok, true);
    await coordinator.close();
    if (preview.ok) {
      assert.equal(preview.value, 'stable');
      const committed = await preview.commit();
      assert.equal(committed.ok, false);
      if (!committed.ok) assert.match(committed.message, /registry changed/);
    }
    assert.equal(coordinator.snapshotForSession('session-a'), undefined);
  });

  test('composes disjoint contracts from multiple providers', async () => {
    const coordinator = createCoordinator();
    const first = coordinator.attachConnection(clientCapabilityConnectionIdentity('connection-a'), {
      send: async () => {},
    });
    const second = coordinator.attachConnection(
      clientCapabilityConnectionIdentity('connection-b'),
      { send: async () => {} },
    );
    await replace(
      coordinator,
      'connection-a',
      'registration-a',
      'inspect_first',
      '0',
      'first_offer',
    );
    await replace(
      coordinator,
      'connection-b',
      'registration-b',
      'inspect_second',
      '0',
      'second_offer',
    );

    assert.deepEqual(await coordinator.bindSession('session-a', 'observer'), { ok: true });
    const snapshot = coordinator.snapshotForSession('session-a');
    assert.ok(snapshot);
    assert.deepEqual([...snapshot.registrationIds].sort(), ['registration-a', 'registration-b']);
    assert.deepEqual(
      snapshot.groups.map((group) => group.label),
      ['Opaque capability', 'Opaque capability'],
    );
    assert.deepEqual(snapshot.tools.map((tool) => tool.name).sort(), [
      'mcp__first_offer__inspect_first',
      'mcp__second_offer__inspect_second',
    ]);

    snapshot.release();
    first.close();
    second.close();
    await coordinator.close();
  });

  test('rebinds a lost Session contract only to the same authenticated Client identity', async () => {
    const coordinator = createCoordinator();
    const first = coordinator.attachConnection(
      clientCapabilityConnectionIdentity('connection-a', 'client-a', 'principal-a'),
      { send: async () => {} },
    );
    await replace(coordinator, 'connection-a', 'registration-a', 'inspect');
    assert.deepEqual(await coordinator.bindSession('session-a', 'connection-a'), { ok: true });
    await first.close();

    const wrong = coordinator.attachConnection(
      clientCapabilityConnectionIdentity('connection-wrong', 'client-a', 'principal-wrong'),
      { send: async () => {} },
    );
    await replace(coordinator, 'connection-wrong', 'registration-wrong', 'inspect');
    assert.deepEqual(await coordinator.bindSession('session-a', 'connection-wrong'), {
      ok: false,
      message: 'A Session-bound Client Capability provider has not reconnected',
    });

    const replacement = coordinator.attachConnection(
      clientCapabilityConnectionIdentity('connection-b', 'client-a', 'principal-a'),
      { send: async () => {} },
    );
    await replace(coordinator, 'connection-b', 'registration-b', 'inspect');
    assert.deepEqual(await coordinator.bindSession('session-a', 'connection-b'), { ok: true });
    const snapshot = coordinator.snapshotForSession('session-a');
    assert.deepEqual(snapshot?.registrationIds, ['registration-b']);
    snapshot?.release();
    await Promise.all([wrong.close(), replacement.close()]);
    await coordinator.close();
  });

  test('a reconnecting Client takes over its provider lease before the stale connection closes', async () => {
    const coordinator = createCoordinator();
    const first = coordinator.attachConnection(
      clientCapabilityConnectionIdentity('connection-a', 'client-a', 'principal-a'),
      { send: async () => {} },
    );
    await replace(coordinator, 'connection-a', 'registration-a', 'inspect');
    assert.deepEqual(await coordinator.bindSession('session-a', 'connection-a'), { ok: true });

    const replacement = coordinator.attachConnection(
      clientCapabilityConnectionIdentity('connection-b', 'client-a', 'principal-a'),
      { send: async () => {} },
    );
    await replace(coordinator, 'connection-b', 'registration-b', 'inspect');
    assert.deepEqual(
      await coordinator.handlers['client.capability.replace'](
        replacementInput('registration-a-late', 'inspect'),
        connectionContext('connection-a'),
      ),
      {
        ok: false,
        error: {
          code: 'invalid_request',
          message: 'Client Capability connection has been superseded',
        },
      },
    );
    assert.deepEqual(
      await coordinator.handlers['client.capability.unregister'](
        { registrationId: 'registration-a' },
        connectionContext('connection-a'),
      ),
      {
        ok: false,
        error: {
          code: 'invalid_request',
          message: 'Client Capability registration is not current',
        },
      },
    );

    await first.close();
    assert.deepEqual(await coordinator.bindSession('session-a', 'connection-b'), { ok: true });
    const snapshot = coordinator.snapshotForSession('session-a');
    assert.deepEqual(snapshot?.registrationIds, ['registration-b']);
    snapshot?.release();
    await replacement.close();
    await coordinator.close();
  });

  test('forgets initiating Clients when replacement or unregister removes all call-affine offers', async () => {
    for (const mutation of ['replace', 'unregister'] as const) {
      const coordinator = createCoordinator();
      const first = coordinator.attachConnection(
        clientCapabilityConnectionIdentity('connection-a'),
        { send: async () => {} },
      );
      const second = coordinator.attachConnection(
        clientCapabilityConnectionIdentity('connection-b'),
        { send: async () => {} },
      );
      await replace(
        coordinator,
        'connection-a',
        'registration-a',
        'inspect',
        '0',
        'opaque_offer',
        'call',
      );
      assert.deepEqual(await coordinator.bindSession('session-a', 'connection-a'), { ok: true });

      if (mutation === 'replace') {
        await replace(
          coordinator,
          'connection-a',
          'registration-non-call',
          'inspect_session',
          '0',
          'session_offer',
          'session',
        );
      } else {
        const result = await coordinator.handlers['client.capability.unregister'](
          { registrationId: 'registration-a' },
          connectionContext('connection-a'),
        );
        assert.equal(result.ok, true);
      }

      await replace(
        coordinator,
        'connection-a',
        'registration-a-next',
        'inspect',
        '0',
        'opaque_offer',
        'call',
      );
      await replace(
        coordinator,
        'connection-b',
        'registration-b',
        'inspect',
        '0',
        'opaque_offer',
        'call',
      );
      const snapshot = coordinator.snapshotForSession('session-a');
      assert.ok(snapshot);
      await assert.rejects(
        () => invoke(snapshot.tools[0]),
        (error: unknown) =>
          error instanceof ClientCapabilityInvocationError && error.code === 'capability_ambiguous',
      );
      snapshot.release();
      first.close();
      second.close();
      await coordinator.close();
    }
  });

  test('does not retain an initiating Client for a Session with no capability state', async () => {
    const coordinator = createCoordinator();
    assert.deepEqual(await coordinator.bindSession('session-a', 'connection-a'), { ok: true });

    const first = coordinator.attachConnection(clientCapabilityConnectionIdentity('connection-a'), {
      send: async () => {},
    });
    const second = coordinator.attachConnection(
      clientCapabilityConnectionIdentity('connection-b'),
      { send: async () => {} },
    );
    await replace(
      coordinator,
      'connection-a',
      'registration-a',
      'inspect',
      '0',
      'opaque_offer',
      'call',
    );
    await replace(
      coordinator,
      'connection-b',
      'registration-b',
      'inspect',
      '0',
      'opaque_offer',
      'call',
    );

    const snapshot = coordinator.snapshotForSession('session-a');
    assert.ok(snapshot);
    await assert.rejects(
      () => invoke(snapshot.tools[0]),
      (error: unknown) =>
        error instanceof ClientCapabilityInvocationError && error.code === 'capability_ambiguous',
    );
    snapshot.release();
    first.close();
    second.close();
    await coordinator.close();
  });

  test('retires Session bindings after explicit replacement and unregister', async () => {
    const coordinator = createCoordinator();
    const connection = coordinator.attachConnection(
      clientCapabilityConnectionIdentity('connection-a'),
      { send: async () => {} },
    );
    await replace(coordinator, 'connection-a', 'registration-a', 'inspect');
    assert.deepEqual(await coordinator.bindSession('session-a', 'connection-a'), { ok: true });

    await replace(coordinator, 'connection-a', 'registration-b', 'inspect', '1');
    assert.deepEqual(await coordinator.bindSession('session-a', 'observer'), { ok: true });
    const replacement = coordinator.snapshotForSession('session-a');
    assert.deepEqual(replacement?.registrationIds, ['registration-b']);
    replacement?.release();

    const unregistered = await coordinator.handlers['client.capability.unregister'](
      { registrationId: 'registration-b' },
      connectionContext('connection-a'),
    );
    assert.equal(unregistered.ok, true);
    assert.deepEqual(await coordinator.bindSession('session-a', 'observer'), { ok: true });
    assert.equal(coordinator.snapshotForSession('session-a'), undefined);
    connection.close();
    await coordinator.close();
  });

  test('isolates call-affine ambiguity and freezes the initiating provider in a snapshot', async () => {
    const coordinator = createCoordinator();
    let first!: ClientCapabilityConnection;
    first = coordinator.attachConnection(clientCapabilityConnectionIdentity('connection-a'), {
      send: async (frame) => {
        if (frame.kind !== 'client.capability.call') return;
        first.accept({
          kind: 'client.capability.accepted',
          invocationId: frame.invocationId,
        });
        first.accept({
          kind: 'client.capability.result',
          invocationId: frame.invocationId,
          result: textResult('first'),
        });
      },
    });
    let second!: ClientCapabilityConnection;
    second = coordinator.attachConnection(clientCapabilityConnectionIdentity('connection-b'), {
      send: async (frame) => {
        if (frame.kind !== 'client.capability.call') return;
        second.accept({
          kind: 'client.capability.accepted',
          invocationId: frame.invocationId,
        });
        second.accept({
          kind: 'client.capability.result',
          invocationId: frame.invocationId,
          result: textResult('second'),
        });
      },
    });
    await replace(
      coordinator,
      'connection-a',
      'registration-a',
      'inspect',
      '0',
      'opaque_offer',
      'call',
    );
    await replace(
      coordinator,
      'connection-b',
      'registration-b',
      'inspect',
      '0',
      'opaque_offer',
      'call',
    );

    assert.deepEqual(await coordinator.bindSession('session-a', 'observer'), { ok: true });
    const ambiguous = coordinator.snapshotForSession('session-a');
    assert.ok(ambiguous);
    await assert.rejects(
      () => invoke(ambiguous.tools[0]),
      (error: unknown) =>
        error instanceof ClientCapabilityInvocationError && error.code === 'capability_ambiguous',
    );
    ambiguous.release();

    assert.deepEqual(await coordinator.bindSession('session-a', 'connection-a'), { ok: true });
    const frozen = coordinator.snapshotForSession('session-a');
    assert.ok(frozen);
    assert.deepEqual(await invoke(frozen.tools[0]), textResult('first'));
    assert.deepEqual(await coordinator.bindSession('session-a', 'connection-b'), { ok: true });
    assert.deepEqual(await invoke(frozen.tools[0]), textResult('first'));
    frozen.release();

    first.close();
    assert.deepEqual(await coordinator.bindSession('session-a', 'observer'), { ok: true });
    const sole = coordinator.snapshotForSession('session-a');
    assert.ok(sole);
    assert.deepEqual(await invoke(sole.tools[0]), textResult('second'));
    sole.release();
    second.close();
    await coordinator.close();
  });

  test('omits ambiguous turn-affine contracts without creating a Session tombstone', async () => {
    const coordinator = createCoordinator();
    const first = coordinator.attachConnection(clientCapabilityConnectionIdentity('connection-a'), {
      send: async () => {},
    });
    const second = coordinator.attachConnection(
      clientCapabilityConnectionIdentity('connection-b'),
      { send: async () => {} },
    );
    await replace(
      coordinator,
      'connection-a',
      'registration-a',
      'inspect',
      '0',
      'opaque_offer',
      'turn',
    );
    await replace(
      coordinator,
      'connection-b',
      'registration-b',
      'inspect',
      '0',
      'opaque_offer',
      'turn',
    );

    assert.deepEqual(await coordinator.bindSession('session-a', 'observer'), { ok: true });
    assert.equal(coordinator.snapshotForSession('session-a'), undefined);
    assert.deepEqual(await coordinator.bindSession('session-a', 'connection-b'), { ok: true });
    const selected = coordinator.snapshotForSession('session-a');
    assert.deepEqual(selected?.registrationIds, ['registration-b']);
    selected?.release();

    second.close();
    assert.deepEqual(await coordinator.bindSession('session-a', 'observer'), { ok: true });
    const rebound = coordinator.snapshotForSession('session-a');
    assert.deepEqual(rebound?.registrationIds, ['registration-a']);
    rebound?.release();
    first.close();
    await coordinator.close();
  });

  test('keeps load_tools group identity provider-independent and contract-sensitive', async () => {
    const coordinator = createCoordinator();
    const first = coordinator.attachConnection(clientCapabilityConnectionIdentity('connection-a'), {
      send: async () => {},
    });
    const second = coordinator.attachConnection(
      clientCapabilityConnectionIdentity('connection-b'),
      { send: async () => {} },
    );
    await replace(coordinator, 'connection-a', 'registration-a', 'shared_tool');
    await replace(coordinator, 'connection-b', 'registration-b', 'shared_tool');

    await coordinator.bindSession('session-a', 'connection-a');
    await coordinator.bindSession('session-b', 'connection-b');
    const firstSnapshot = coordinator.snapshotForSession('session-a');
    const secondSnapshot = coordinator.snapshotForSession('session-b');
    first.close();
    second.close();

    const changed = coordinator.attachConnection(
      clientCapabilityConnectionIdentity('connection-c'),
      { send: async () => {} },
    );
    await replace(coordinator, 'connection-c', 'registration-c', 'shared_tool', '1');
    await coordinator.bindSession('session-c', 'connection-c');
    const changedSnapshot = coordinator.snapshotForSession('session-c');
    assert.ok(firstSnapshot);
    assert.ok(secondSnapshot);
    assert.ok(changedSnapshot);
    assert.equal(firstSnapshot.groups[0]?.id, secondSnapshot.groups[0]?.id);
    assert.notEqual(firstSnapshot.groups[0]?.id, changedSnapshot.groups[0]?.id);

    firstSnapshot.release();
    secondSnapshot.release();
    changedSnapshot.release();
    changed.close();
    await coordinator.close();
  });

  test('bounds concurrent invocations for one provider connection', async () => {
    const coordinator = createCoordinator();
    const connection = coordinator.attachConnection(
      clientCapabilityConnectionIdentity('connection-a'),
      { send: async () => {} },
    );
    await replace(coordinator, 'connection-a', 'registration-a', 'opaque');
    await coordinator.bindSession('session-a', 'connection-a');
    const snapshot = coordinator.snapshotForSession('session-a');
    assert.ok(snapshot);
    const tool = snapshot.tools[0];
    assert.ok(tool);
    const aborts = Array.from({ length: 8 }, () => new AbortController());
    const active = aborts.map((abort, index) =>
      Promise.resolve(
        tool.impl(
          {},
          {
            sessionId: 'session-a',
            turnId: 'turn-a',
            cwd: '/tmp',
            toolCallId: `tool-call-${index}`,
            abortSignal: abort.signal,
            emitOutput: () => undefined,
          },
        ),
      ),
    );
    await assert.rejects(
      async () =>
        tool.impl(
          {},
          {
            sessionId: 'session-a',
            turnId: 'turn-a',
            cwd: '/tmp',
            toolCallId: 'tool-call-overflow',
            abortSignal: new AbortController().signal,
            emitOutput: () => undefined,
          },
        ),
      (error: unknown) =>
        error instanceof ClientCapabilityInvocationError && error.code === 'provider_overloaded',
    );

    for (const abort of aborts) {
      abort.abort(new DOMException('Test cleanup', 'AbortError'));
    }
    await Promise.allSettled(active);
    snapshot.release();
    connection.close();
    await coordinator.close();
  });

  test('cancels accepted work as outcome_unknown and ignores a late provider outcome', async () => {
    const coordinator = createCoordinator();
    const sent: Array<{ kind: string; invocationId?: string }> = [];
    let connection!: ClientCapabilityConnection;
    let callArrived!: () => void;
    const receivedCall = new Promise<void>((resolve) => {
      callArrived = resolve;
    });
    connection = coordinator.attachConnection(clientCapabilityConnectionIdentity('connection-a'), {
      send: async (frame) => {
        sent.push(frame);
        if (frame.kind !== 'client.capability.call') return;
        connection.accept({
          kind: 'client.capability.accepted',
          invocationId: frame.invocationId,
        });
        callArrived();
      },
    });
    await replace(coordinator, 'connection-a', 'registration-a', 'opaque');
    await coordinator.bindSession('session-a', 'connection-a');
    const snapshot = coordinator.snapshotForSession('session-a');
    assert.ok(snapshot);
    const abort = new AbortController();
    const pending = snapshot.tools[0]?.impl(
      {},
      {
        sessionId: 'session-a',
        turnId: 'turn-a',
        cwd: '/tmp',
        toolCallId: 'tool-call-a',
        abortSignal: abort.signal,
        emitOutput: () => undefined,
      },
    );
    assert.ok(pending);
    await receivedCall;
    abort.abort(new DOMException('Cancelled by test', 'AbortError'));
    await assert.rejects(
      Promise.resolve(pending),
      (error: unknown) => error instanceof ToolOutcomeUnknownError,
    );
    const invocationId = sent.find(
      (frame) => frame.kind === 'client.capability.call',
    )?.invocationId;
    assert.ok(invocationId);
    assert.ok(
      sent.some(
        (frame) => frame.kind === 'client.capability.cancel' && frame.invocationId === invocationId,
      ),
    );
    assert.ok(
      sent.some(
        (frame) =>
          frame.kind === 'client.capability.release' && frame.invocationId === invocationId,
      ),
    );
    connection.accept({
      kind: 'client.capability.failed',
      invocationId,
      message: 'Late provider outcome',
    });
    snapshot.release();
    connection.close();
    await coordinator.close();
  });

  test('rejects malformed chunk-state transitions without losing invocation ownership', async () => {
    const cases = [
      {
        name: 'start before acceptance',
        transition: (connection: ClientCapabilityConnection, invocationId: string) => {
          connection.accept({
            kind: 'client.capability.result_start',
            invocationId,
            byteLength: 2,
            chunkCount: 1,
          });
        },
        message: /chunks started outside the accepted phase/,
      },
      {
        name: 'chunk before start',
        transition: (connection: ClientCapabilityConnection, invocationId: string) => {
          connection.accept({ kind: 'client.capability.accepted', invocationId });
          connection.accept({
            kind: 'client.capability.result_chunk',
            invocationId,
            index: 0,
            data: Buffer.from('{}').toString('base64'),
          });
        },
        message: /chunk is out of sequence/,
      },
      {
        name: 'duplicate start',
        transition: (connection: ClientCapabilityConnection, invocationId: string) => {
          connection.accept({ kind: 'client.capability.accepted', invocationId });
          connection.accept({
            kind: 'client.capability.result_start',
            invocationId,
            byteLength: 2,
            chunkCount: 1,
          });
          connection.accept({
            kind: 'client.capability.result_start',
            invocationId,
            byteLength: 2,
            chunkCount: 1,
          });
        },
        message: /chunks started outside the accepted phase/,
      },
      {
        name: 'unchunked result after start',
        transition: (connection: ClientCapabilityConnection, invocationId: string) => {
          connection.accept({ kind: 'client.capability.accepted', invocationId });
          connection.accept({
            kind: 'client.capability.result_start',
            invocationId,
            byteLength: 2,
            chunkCount: 1,
          });
          connection.accept({
            kind: 'client.capability.result',
            invocationId,
            result: textResult('invalid terminal form'),
          });
        },
        message: /result arrived outside the accepted phase/,
      },
      {
        name: 'out-of-order chunk',
        transition: (connection: ClientCapabilityConnection, invocationId: string) => {
          connection.accept({ kind: 'client.capability.accepted', invocationId });
          connection.accept({
            kind: 'client.capability.result_start',
            invocationId,
            byteLength: 2,
            chunkCount: 1,
          });
          connection.accept({
            kind: 'client.capability.result_chunk',
            invocationId,
            index: 1,
            data: Buffer.from('{}').toString('base64'),
          });
        },
        message: /chunk is out of sequence/,
      },
    ] as const;

    for (const malformed of cases) {
      const coordinator = createCoordinator();
      let resolveInvocation!: (invocationId: string) => void;
      const invocationArrived = new Promise<string>((resolve) => {
        resolveInvocation = resolve;
      });
      const connection = coordinator.attachConnection(
        clientCapabilityConnectionIdentity('connection-a'),
        {
          send: async (frame) => {
            if (frame.kind === 'client.capability.call') {
              resolveInvocation(frame.invocationId);
            }
          },
        },
      );
      await replace(coordinator, 'connection-a', 'registration-a', 'opaque');
      await coordinator.bindSession('session-a', 'connection-a');
      const snapshot = coordinator.snapshotForSession('session-a');
      assert.ok(snapshot);
      const pending = invoke(snapshot.tools[0]);
      const invocationId = await invocationArrived;

      try {
        assert.throws(
          () => malformed.transition(connection, invocationId),
          malformed.message,
          malformed.name,
        );
      } finally {
        connection.close();
        const outcome = await Promise.allSettled([pending]);
        snapshot.release();
        await coordinator.close();
        assert.equal(outcome[0]?.status, 'rejected', malformed.name);
      }
    }
  });
});

async function assertLossClassification(
  accept: boolean,
  expected: ClientCapabilityInvocationError['code'] | 'outcome_unknown',
): Promise<void> {
  const coordinator = createCoordinator();
  let connection!: ClientCapabilityConnection;
  connection = coordinator.attachConnection(clientCapabilityConnectionIdentity('connection-a'), {
    send: async (frame) => {
      if (frame.kind !== 'client.capability.call') return;
      if (accept) {
        connection.accept({
          kind: 'client.capability.accepted',
          invocationId: frame.invocationId,
        });
      }
      connection.close();
    },
  });
  await replace(coordinator, 'connection-a', 'registration-a', 'opaque');
  assert.deepEqual(await coordinator.bindSession('session-a', 'connection-a'), { ok: true });
  const snapshot = coordinator.snapshotForSession('session-a');
  assert.ok(snapshot);
  await assert.rejects(
    () => invoke(snapshot.tools[0]),
    (error: unknown) =>
      expected === 'outcome_unknown'
        ? error instanceof ToolOutcomeUnknownError
        : error instanceof ClientCapabilityInvocationError && error.code === expected,
  );
  snapshot.release();
  await coordinator.close();
}

function createCoordinator(
  onModelToolsChanged: () => void = () => undefined,
): HostClientCapabilityCoordinator {
  return new HostClientCapabilityCoordinator({
    activation: new RuntimePolicyActivationGate(),
    onModelToolsChanged,
  });
}

async function replace(
  coordinator: HostClientCapabilityCoordinator,
  connectionId: string,
  registrationId: string,
  toolName: string,
  version = '0',
  offerId = 'opaque_offer',
  affinity: 'call' | 'turn' | 'session' = 'session',
): Promise<void> {
  const outcome = await coordinator.handlers['client.capability.replace'](
    replacementInput(registrationId, toolName, version, offerId, affinity),
    {
      ...connectionContext(connectionId),
    },
  );
  assert.equal(outcome.ok, true);
}

function replacementInput(
  registrationId: string,
  toolName: string,
  version = '0',
  offerId = 'opaque_offer',
  affinity: 'call' | 'turn' | 'session' = 'session',
): ClientCapabilityReplaceInput {
  return {
    registrationId,
    offers: [
      {
        offerId,
        version,
        affinity,
        hostPathAccess: 'cwd',
        label: 'Opaque capability',
        description: 'Known only to the provider.',
        tools: [
          {
            serverId: offerId,
            name: toolName,
            description: 'An open-world fixture tool.',
            inputSchema: { type: 'object', additionalProperties: false },
          },
        ],
      },
    ],
  };
}

function connectionContext(connectionId: string) {
  return {
    hostEpoch: 'host',
    connectionId,
    principal: 'local_os_user' as const,
    acquireResidency: () => ({ release: () => undefined }),
  };
}

test('Host services stay bound to the explicitly initiating Client connection', async () => {
  const coordinator = createCoordinator();
  const calls: string[] = [];
  const attach = (connectionId: string) => {
    let connection!: ReturnType<HostClientCapabilityCoordinator['attachConnection']>;
    connection = coordinator.attachConnection(clientCapabilityConnectionIdentity(connectionId), {
      send: async (frame) => {
        if (frame.kind === 'client.capability.service_call') {
          calls.push(connectionId);
          connection.accept({
            kind: 'client.capability.accepted',
            invocationId: frame.invocationId,
          });
          return;
        }
        if (frame.kind === 'client.capability.admitted') {
          connection.accept({
            kind: 'client.capability.result',
            invocationId: frame.invocationId,
            result: { content: [], structuredContent: { kind: 'presented' } },
          });
        }
      },
    });
    return connection;
  };
  const first = attach('connection-a');
  const second = attach('connection-b');
  for (const connectionId of ['connection-a', 'connection-b']) {
    const outcome = await coordinator.handlers['client.capability.replace'](
      {
        registrationId: `registration-${connectionId}`,
        offers: [],
        services: [{ serviceId: 'vendor_service', version: '1' }],
      },
      connectionContext(connectionId),
    );
    assert.equal(outcome.ok, true);
  }

  assert.deepEqual(await coordinator.bindSession('session-b', 'connection-b'), { ok: true });
  const result = await coordinator.callServiceForSession({
    sessionId: 'session-b',
    serviceId: 'vendor_service',
    version: '1',
    method: 'present',
    input: {},
  });
  assert.deepEqual(result, { kind: 'presented' });
  assert.deepEqual(calls, ['connection-b']);
  first.close();
  second.close();
  await coordinator.close();
});

test('Host services never fail over to a different Session owner', async () => {
  const coordinator = createCoordinator();
  const owner = coordinator.attachConnection(clientCapabilityConnectionIdentity('connection-a'), {
    send: async () => {},
  });
  const other = coordinator.attachConnection(clientCapabilityConnectionIdentity('connection-b'), {
    send: async () => {},
  });
  assert.equal(
    (
      await coordinator.handlers['client.capability.replace'](
        {
          registrationId: 'owner',
          offers: [],
          services: [{ serviceId: 'vendor_service', version: '1' }],
        },
        connectionContext('connection-a'),
      )
    ).ok,
    true,
  );
  assert.equal(
    (
      await coordinator.handlers['client.capability.replace'](
        {
          registrationId: 'other',
          offers: [],
          services: [{ serviceId: 'vendor_service', version: '1' }],
        },
        connectionContext('connection-b'),
      )
    ).ok,
    true,
  );
  assert.deepEqual(await coordinator.bindSession('session-a', 'connection-a'), { ok: true });
  assert.equal(
    (
      await coordinator.handlers['client.capability.replace'](
        { registrationId: 'owner-without-service', offers: [], services: [] },
        connectionContext('connection-a'),
      )
    ).ok,
    true,
  );
  await assert.rejects(
    () =>
      coordinator.callServiceForSession({
        sessionId: 'session-a',
        serviceId: 'vendor_service',
        version: '1',
        method: 'present',
        input: {},
      }),
    (error: unknown) =>
      error instanceof ClientCapabilityInvocationError && error.code === 'capability_lost',
  );
  owner.close();
  other.close();
  await coordinator.close();
});

test('service-only registration lifecycle does not invalidate model backends', async () => {
  let modelToolChanges = 0;
  const coordinator = createCoordinator(() => {
    modelToolChanges += 1;
  });
  const connection = coordinator.attachConnection(
    clientCapabilityConnectionIdentity('connection-a'),
    { send: async () => {} },
  );
  for (const registrationId of ['service-a', 'service-b']) {
    const outcome = await coordinator.handlers['client.capability.replace'](
      {
        registrationId,
        offers: [],
        services: [{ serviceId: 'vendor_service', version: '1' }],
      },
      connectionContext('connection-a'),
    );
    assert.equal(outcome.ok, true);
  }
  const unregistered = await coordinator.handlers['client.capability.unregister'](
    { registrationId: 'service-b' },
    connectionContext('connection-a'),
  );
  assert.equal(unregistered.ok, true);
  assert.equal(modelToolChanges, 0);

  const serviceConnection = coordinator.attachConnection(
    clientCapabilityConnectionIdentity('connection-b'),
    { send: async () => {} },
  );
  const serviceRegistered = await coordinator.handlers['client.capability.replace'](
    {
      registrationId: 'service-disconnect',
      offers: [],
      services: [{ serviceId: 'vendor_service', version: '1' }],
    },
    connectionContext('connection-b'),
  );
  assert.equal(serviceRegistered.ok, true);
  serviceConnection.close();
  assert.equal(modelToolChanges, 0);

  await replace(coordinator, 'connection-a', 'tool-registration', 'inspect');
  assert.equal(modelToolChanges, 1);
  connection.close();
  await coordinator.close();
  assert.equal(modelToolChanges, 2);
});

async function invoke(tool: NonNullable<ReturnType<typeof toolAt>>): Promise<unknown> {
  return tool.impl(
    {},
    {
      sessionId: 'session-a',
      turnId: 'turn-a',
      cwd: '/tmp',
      toolCallId: 'tool-call-a',
      abortSignal: new AbortController().signal,
      emitOutput: () => undefined,
    },
  );
}

function toolAt(
  snapshot: ReturnType<HostClientCapabilityCoordinator['snapshotForSession']>,
  index: number,
) {
  return snapshot?.tools[index];
}

function textResult(text: string): McpCallResult {
  return { content: [{ type: 'text', text }] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

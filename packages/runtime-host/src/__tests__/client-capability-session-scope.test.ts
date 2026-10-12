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
import { test } from 'node:test';
import type { ClientCapabilitySessionGrantKey } from '@maka/core/client-capability-grant';
import { createManagedExecutionBoundary } from '@maka/core/sandbox-boundary';
import { createWorkspaceWritePermissionProfile } from '@maka/core/permission-profile';
import {
  decodeClientCapabilityReplaceInput,
  type ClientCapabilityHostFrame,
  type ClientCapabilityReplaceInput,
} from '../protocol/index.js';
import {
  HostClientCapabilityCoordinator,
  MAX_SESSION_REGISTRATIONS_PER_PROVIDER,
} from '../server/client-capability-coordinator.js';
import { RuntimePolicyActivationGate } from '../server/runtime-policy-activation-gate.js';
import { ClientCapabilityChannel } from '../client/client-capability-channel.js';
import { clientCapabilityConnectionIdentity } from './fixtures/client-capability.js';

test('one connection isolates same-named Session tools, replacements and unregisters', async (t) => {
  const { coordinator, attach, publish, invoke } = fixture();
  t.after(() => coordinator.close());
  attach('one');
  await publish('one', 'a', 'a-first');
  await publish('one', 'b', 'b-first');
  await coordinator.bindSession('a', 'one');
  await coordinator.bindSession('b', 'one');
  const a = coordinator.snapshotForSession('a')!;
  const b = coordinator.snapshotForSession('b')!;
  t.after(() => {
    a.release();
    b.release();
  });
  assert.deepEqual(await invoke(a, 'a'), result('one:a-first:a'));
  assert.deepEqual(await invoke(b, 'b'), result('one:b-first:b'));
  await coordinator.bindSession('unrelated', 'one');
  assert.equal(coordinator.snapshotForSession('unrelated'), undefined);

  // A matching target ID alone does not opt an unrelated initiating provider
  // into this publication, including the local-owner singleton fallback.
  attach('other', 'other-client');
  await coordinator.bindSession('unbound', 'other');
  await publish('one', 'unbound', 'injected');
  await coordinator.bindSession('unbound', 'other');
  assert.equal(coordinator.snapshotForSession('unbound'), undefined);
  await coordinator.bindSession('unbound', '');
  assert.equal(coordinator.snapshotForSession('unbound'), undefined);

  await publish('one', 'a', 'a-second');
  await coordinator.bindSession('a', 'one');
  const next = coordinator.snapshotForSession('a')!;
  t.after(() => next.release());
  assert.deepEqual(await invoke(a, 'a'), result('one:a-first:a'));
  assert.deepEqual(await invoke(next, 'a'), result('one:a-second:a'));
  assert.deepEqual(await invoke(b, 'b'), result('one:b-first:b'));
  assert.equal(
    (
      await coordinator.handlers['client.capability.unregister'](
        { registrationId: 'a-second' },
        context('one'),
      )
    ).ok,
    true,
  );
  assert.equal(coordinator.snapshotForSession('a'), undefined);
  assert.deepEqual(await invoke(b, 'b'), result('one:b-first:b'));
  await assert.rejects(() => invoke(b, 'a'), /another Session/);
});

test('remote connections with one authenticated provider own independent Session slots and hand off a scope', async (t) => {
  const { coordinator, attach, publish, invoke, sent } = fixture('remote_owner');
  t.after(() => coordinator.close());
  const aConnection = attach('a-connection');
  attach('b-connection');
  attach('default-replacement');
  await publish('a-connection', undefined, 'default-old', 'auxiliary');
  await publish('a-connection', 'a', 'a-old');
  await publish('b-connection', 'b', 'b-old');
  await coordinator.bindSession('a', 'a-connection');
  await coordinator.bindSession('b', 'b-connection');
  const a = coordinator.snapshotForSession('a')!;
  const b = coordinator.snapshotForSession('b')!;
  t.after(() => b.release());
  assert.deepEqual(await invoke(a, 'a'), result('a-connection:a-old:a'));
  assert.deepEqual(await invoke(b, 'b'), result('b-connection:b-old:b'));

  await publish('default-replacement', undefined, 'default-new', 'auxiliary');
  assert.deepEqual(await invoke(a, 'a'), result('a-connection:a-old:a'));
  assert.deepEqual(await invoke(b, 'b'), result('b-connection:b-old:b'));
  const takeover = await coordinator.handlers['client.capability.replace'](
    input('a', 'steal-a'),
    context('default-replacement'),
  );
  assert.equal(takeover.ok, true);
  const handedOff = coordinator.snapshotForSession('a')!;
  t.after(() => handedOff.release());
  assert.deepEqual(await invoke(handedOff, 'a'), result('default-replacement:steal-a:a'));
  a.release();
  assert.ok(
    sent.some(
      (frame) =>
        frame.kind === 'client.capability.registration_release' && frame.registrationId === 'a-old',
    ),
  );
  const foreignRemoval = await coordinator.handlers['client.capability.unregister'](
    { registrationId: 'a-old' },
    context('b-connection'),
  );
  assert.equal(foreignRemoval.ok, false);

  await aConnection.close();
  assert.deepEqual(await invoke(b, 'b'), result('b-connection:b-old:b'));
  attach('a-reconnected');
  await publish('a-reconnected', 'a', 'a-new');
  assert.equal((await coordinator.bindSession('a', 'a-reconnected')).ok, true);
  const reconnected = coordinator.snapshotForSession('a')!;
  t.after(() => reconnected.release());
  assert.deepEqual(await invoke(reconnected, 'a'), result('a-reconnected:a-new:a'));
  assert.deepEqual(await invoke(b, 'b'), result('b-connection:b-old:b'));
});

test('Session retirement releases scoped registrations and prevents rebinding retired tools', async (t) => {
  const { coordinator, attach, publish, sent } = fixture();
  t.after(() => coordinator.close());
  attach('one');
  await publish('one', 'archived', 'archive-registration');
  await publish('one', 'removed', 'remove-registration');
  await coordinator.bindSession('archived', 'one');
  await coordinator.bindSession('removed', 'one');

  await coordinator.retireSessions(['archived']);
  await coordinator.retireSessions(['removed']);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(
    sent
      .filter((frame) => frame.kind === 'client.capability.registration_release')
      .map((frame) => frame.registrationId),
    ['archive-registration', 'remove-registration'],
  );
  assert.equal((await coordinator.bindSession('archived', 'one')).ok, true);
  assert.equal((await coordinator.bindSession('removed', 'one')).ok, true);
  assert.equal(coordinator.snapshotForSession('archived'), undefined);
  assert.equal(coordinator.snapshotForSession('removed'), undefined);
});

for (const empty of [false, true])
  test(`a provider cannot retain unbounded ${empty ? 'empty' : 'populated'} Session registrations`, async (t) => {
    const { coordinator, attach, publish } = fixture();
    t.after(() => coordinator.close());
    attach('one');
    for (let index = 0; index < MAX_SESSION_REGISTRATIONS_PER_PROVIDER; index++) {
      const registration = input(`fabricated-${index}`, `registration-${index}`);
      const outcome = await coordinator.handlers['client.capability.replace'](
        empty ? { ...registration, offers: [] } : registration,
        context('one'),
      );
      assert.equal(outcome.ok, true);
    }
    const rejected = await coordinator.handlers['client.capability.replace'](
      input('fabricated-over-limit', 'over-limit'),
      context('one'),
    );
    assert.deepEqual(rejected, {
      ok: false,
      error: {
        code: 'invalid_request',
        message: 'Client Capability Session registration limit reached',
      },
    });
    await publish('one', 'fabricated-0', 'replacement-at-limit');
    assert.equal(
      (
        await coordinator.handlers['client.capability.unregister'](
          { registrationId: 'registration-1' },
          context('one'),
        )
      ).ok,
      true,
    );
    await publish('one', 'new-after-unregister', 'new-registration');
  });

test('Session retirement follows an already queued replacement', async (t) => {
  const { coordinator, activation, attach, publish } = fixture();
  t.after(() => coordinator.close());
  attach('one');
  await publish('one', 'retired', 'old');
  await coordinator.bindSession('retired', 'one');

  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const activeRead = activation.runReadActivation(() => barrier);
  const replacing = coordinator.handlers['client.capability.replace'](
    input('retired', 'new'),
    context('one'),
  );
  const retiring = coordinator.retireSessions(['retired']);
  release();
  await activeRead;
  assert.equal((await replacing).ok, true);
  await retiring;
  assert.equal((await coordinator.bindSession('retired', 'one')).ok, true);
  assert.equal(coordinator.snapshotForSession('retired'), undefined);
});

test('Session retirement invalidates a provider-wide binding preview before commit', async (t) => {
  const { coordinator, attach, publish } = fixture();
  t.after(() => coordinator.close());
  attach('one');
  await publish('one', undefined, 'default');

  const preview = await coordinator.runWithSessionBindingPreview('retired', 'one', async () =>
    Promise.resolve('previewed'),
  );
  assert.equal(preview.ok, true);
  if (!preview.ok) return;

  await coordinator.retireSessions(['retired']);
  const committed = await preview.commit();
  assert.equal(committed.ok, false);
  assert.equal(coordinator.snapshotForSession('retired'), undefined);
});

test('retirement rejects a later queued refresh and notifies the current Client provider', async (t) => {
  const { coordinator, activation, retiredSessions } = fixture();
  let retired = 0;
  const channel = new ClientCapabilityChannel({
    write: async () => undefined,
    replace: async (registration) => {
      const outcome = await coordinator.handlers['client.capability.replace'](
        registration,
        context('one'),
      );
      if (!outcome.ok) throw new Error(outcome.error.message);
      return outcome.result;
    },
    unregister: async (registration) => {
      const outcome = await coordinator.handlers['client.capability.unregister'](
        registration,
        context('one'),
      );
      if (!outcome.ok) throw new Error(outcome.error.message);
      return outcome.result;
    },
    onFailure: (error) => {
      throw error;
    },
  });
  coordinator.attachConnection(clientCapabilityConnectionIdentity('one'), {
    send: async (frame) => channel.accept(frame),
  });
  t.after(async () => {
    await coordinator.close();
    channel.close(new Error('test complete'));
  });
  const provider = {
    offers: () => input('retired', 'unused').offers,
    currentRegistrationRetired: () => {
      retired += 1;
    },
  };
  await channel.replace(provider, 1_000, 'retired');
  await coordinator.bindSession('retired', 'one');
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const active = activation.runReadActivation(() => barrier);
  const retiring = coordinator.retireSessions(['retired']);
  const refresh = assert.rejects(channel.replace(provider, 1_000, 'retired'), /retired/);
  // The lifecycle owner commits archive/removal before capability retirement.
  // Change it after replace was called: the guard must run inside the queue.
  retiredSessions.add('retired');
  release();
  await Promise.all([active, retiring, refresh]);
  assert.equal(retired, 1);
  assert.equal(coordinator.snapshotForSession('retired'), undefined);
  await assert.rejects(channel.unregister(1_000, 'retired'), /No Client Capability registration/);
  await assert.rejects(channel.replace(provider, 1_000, 'retired'), /retired/);
  // Pre-creation publication and unrelated Session slots remain available.
  await channel.replace(provider, 1_000, 'new-session');
});

test('an empty scoped replacement reconciles lost tools without touching other Sessions', async (t) => {
  const { coordinator, attach, publish } = fixture();
  t.after(() => coordinator.close());
  const first = attach('first');
  await publish('first', 'a', 'old-a');
  await publish('first', 'b', 'old-b');
  await coordinator.bindSession('a', 'first');
  await coordinator.bindSession('b', 'first');
  await first.close();
  attach('reconnected');
  const outcome = await coordinator.handlers['client.capability.replace'](
    { sessionId: 'a', registrationId: 'empty-a', offers: [] },
    context('reconnected'),
  );
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  assert.equal((await coordinator.bindSession('a', 'reconnected')).ok, true);
  assert.equal(coordinator.snapshotForSession('a'), undefined);
  assert.equal((await coordinator.bindSession('b', 'reconnected')).ok, false);
  await publish('reconnected', 'a', 'recovered-a');
  assert.equal((await coordinator.bindSession('a', 'reconnected')).ok, true);
  const recovered = coordinator.snapshotForSession('a');
  assert.ok(recovered);
  recovered.release();
});

test('connection and Session publications reject overlapping identities in either direction', async (t) => {
  const { coordinator, attach, publish } = fixture();
  t.after(() => coordinator.close());
  attach('one');
  await publish('one', 'a', 'a');
  assert.equal(
    (
      await coordinator.handlers['client.capability.replace'](
        input(undefined, 'default'),
        context('one'),
      )
    ).ok,
    false,
  );
  await publish('one', undefined, 'default-other', 'other');
  assert.equal(
    (
      await coordinator.handlers['client.capability.replace'](
        input('b', 'b-overlap', 'other'),
        context('one'),
      )
    ).ok,
    false,
  );
  await publish('one', 'b', 'b');
});

test('republication removes contracts that disappeared during a scoped disconnect', async (t) => {
  const { coordinator, attach, publish } = fixture();
  t.after(() => coordinator.close());
  const first = attach('first');
  await publish('first', 'a', 'old');
  await coordinator.bindSession('a', 'first');
  await first.close();
  attach('reconnected');
  await publish('reconnected', 'a', 'new', 'replacement');
  assert.equal((await coordinator.bindSession('a', 'reconnected')).ok, true);
  const current = coordinator.snapshotForSession('a')!;
  t.after(() => current.release());
  assert.deepEqual(
    current.tools.map((tool) => tool.displayName),
    ['replacement'],
  );
});

test('local and remote MCP admission grant only the declared tool in its target Session', async (t) => {
  for (const principalKind of ['local_owner', 'remote_owner'] as const) {
    const { coordinator, attach, publish, invoke, approvals, sent } = fixture(principalKind);
    t.after(() => coordinator.close());
    attach('one');
    await publish('one', 'a', 'a-first');
    await publish('one', 'b', 'b-first');
    await coordinator.bindSession('a', 'one');
    await coordinator.bindSession('b', 'one');
    const a = coordinator.snapshotForSession('a')!;
    const b = coordinator.snapshotForSession('b')!;
    t.after(() => {
      a.release();
      b.release();
    });
    assert.deepEqual(await invoke(a, 'a', true), result('one:a-first:a'));
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0]?.capability, 'mcp');
    assert.deepEqual(approvals[0]?.scope, {
      kind: 'mcp_tool',
      serverId: 'fixture',
      toolName: 'echo',
    });
    await invoke(a, 'a', true);
    assert.equal(approvals.length, 1);
    await invoke(b, 'b', true);
    assert.equal(approvals.length, 2);
    assert.deepEqual(
      approvals.map((approval) => approval.sessionId),
      ['a', 'b'],
    );

    // A list refresh with the same contract does not widen or forget a grant.
    await publish('one', 'a', 'a-refreshed');
    const refreshed = coordinator.snapshotForSession('a')!;
    t.after(() => refreshed.release());
    await invoke(refreshed, 'a', true);
    assert.equal(approvals.length, 2);
    const calls = sent.filter((frame) => frame.kind === 'client.capability.call').length;
    await assert.rejects(() => invoke(refreshed, 'b', true), /another Session/);
    assert.equal(sent.filter((frame) => frame.kind === 'client.capability.call').length, calls);
  }
});

test('MCP policy requires a target, session affinity, no Host paths and no services', () => {
  const valid = input('a', 'a');
  assert.equal(decodeClientCapabilityReplaceInput(valid).sessionId, 'a');
  assert.deepEqual(decodeClientCapabilityReplaceInput({ ...valid, offers: [] }).offers, []);
  for (const sessionId of [undefined, '', null]) {
    assert.throws(() => decodeClientCapabilityReplaceInput({ ...valid, sessionId, offers: [] }));
  }
  for (const invalid of [
    { ...valid, sessionId: undefined },
    { ...valid, sessionId: '' },
    { ...valid, services: [{ serviceId: 'form', version: '0' }] },
    { ...valid, offers: valid.offers.map((offer) => ({ ...offer, affinity: 'call' })) },
    { ...valid, offers: valid.offers.map((offer) => ({ ...offer, hostPathAccess: 'cwd' })) },
    { ...valid, offers: valid.offers.map((offer) => ({ ...offer, admission: 'browser' })) },
  ])
    assert.throws(() => decodeClientCapabilityReplaceInput(invalid));
});

function fixture(principalKind: 'local_owner' | 'remote_owner' = 'local_owner') {
  const activation = new RuntimePolicyActivationGate();
  const retiredSessions = new Set<string>();
  const approvals: ClientCapabilitySessionGrantKey[] = [];
  const grants = new Map<string, ClientCapabilitySessionGrantKey>();
  const sent: ClientCapabilityHostFrame[] = [];
  const key = (value: ClientCapabilitySessionGrantKey) =>
    JSON.stringify([
      value.sessionId,
      value.providerId,
      value.contractId,
      value.capability,
      value.scope,
    ]);
  const coordinator = new HostClientCapabilityCoordinator({
    activation,
    isSessionRetired: async (sessionId) => retiredSessions.has(sessionId),
    onModelToolsChanged: () => undefined,
    grants: {
      readClientCapabilitySessionGrant: async (value) =>
        grants.has(key(value)) ? { ...value, version: 1, grantedAt: 0 } : undefined,
    },
    interactions: {
      requestClientCapabilityApproval: async (value) => {
        // The provider has accepted but has not crossed the admission cut.
        const latest = sent.at(-1);
        assert.equal(latest?.kind, 'client.capability.call');
        const granted = { sessionId: value.sessionId, ...value.target };
        approvals.push(granted);
        grants.set(key(granted), granted);
        return 'allow';
      },
    },
  });
  const attach = (connectionId: string, clientId = 'shared-client') => {
    const calls = new Map<
      string,
      Extract<ClientCapabilityHostFrame, { kind: 'client.capability.call' }>
    >();
    const connection = coordinator.attachConnection(
      clientCapabilityConnectionIdentity(connectionId, clientId, 'principal', principalKind),
      {
        send: async (frame) => {
          sent.push(frame);
          if (frame.kind === 'client.capability.call') {
            calls.set(frame.invocationId, frame);
            connection.accept({
              kind: 'client.capability.accepted',
              invocationId: frame.invocationId,
              admissionEvidence: { kind: 'none' },
            });
          } else if (frame.kind === 'client.capability.admitted') {
            const call = calls.get(frame.invocationId)!;
            connection.accept({
              kind: 'client.capability.result',
              invocationId: frame.invocationId,
              result: result(`${connectionId}:${call.registrationId}:${call.sessionId}`),
            });
          }
        },
      },
    );
    return connection;
  };
  const publish = async (
    connectionId: string,
    sessionId: string | undefined,
    registrationId: string,
    name = 'echo',
  ) => {
    const outcome = await coordinator.handlers['client.capability.replace'](
      input(sessionId, registrationId, name),
      context(connectionId),
    );
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
  };
  const invoke = async (
    snapshot: NonNullable<ReturnType<HostClientCapabilityCoordinator['snapshotForSession']>>,
    sessionId: string,
    ask = false,
  ) => {
    const tool = snapshot.tools.find((candidate) => candidate.displayName === 'echo')!;
    assert.ok(tool);
    const invocation = {
      sessionId,
      turnId: 'turn',
      runId: 'run',
      toolCallId: 'call',
      cwd: '/tmp',
      abortSignal: new AbortController().signal,
      emitOutput: () => undefined,
    };
    if (!ask) return tool.impl({}, invocation);
    const prepared = await tool.prepareExecution!(
      {},
      {
        ...invocation,
        permissionMode: 'ask',
        executionBoundary: createManagedExecutionBoundary(
          createWorkspaceWritePermissionProfile(),
          0,
        ),
      },
    );
    return prepared.execute(invocation);
  };
  return { coordinator, activation, attach, publish, invoke, approvals, sent, retiredSessions };
}

function input(
  sessionId: string | undefined,
  registrationId: string,
  name = 'echo',
): ClientCapabilityReplaceInput {
  return {
    registrationId,
    ...(sessionId === undefined ? {} : { sessionId }),
    offers: [
      {
        offerId: 'mcp_fixture',
        version: '0',
        affinity: 'session',
        hostPathAccess: 'none',
        ...(sessionId === undefined ? {} : { admission: 'mcp' }),
        label: 'Fixture',
        tools: [{ serverId: 'fixture', name, inputSchema: { type: 'object' } }],
      },
    ],
  };
}

function context(connectionId: string) {
  return {
    hostEpoch: 'host',
    connectionId,
    principal: 'local_os_user',
    acquireResidency: () => ({ release: () => undefined }),
  };
}

function result(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

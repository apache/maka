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
import { createDefaultRuntimePolicy } from '@maka/core/runtime-policy';
import { HostExternalAgentSetupCoordinator } from '../server/external-agent-setup-coordinator.js';
import {
  AcpSetupError,
  AcpSetupCleanupError,
  type AcpConnectionOwner,
} from '../server/acp/connection.js';
import type { ConnectionContext } from '../server/operation-dispatcher.js';
import {
  EXTERNAL_AGENT_SETUP_OPERATION_SPECS,
  decodeExternalAgentSetupProjection,
  decodeExternalAgentAuthenticationProjection,
  type ExternalAgentSetupProjection,
} from '../protocol/external-agent-setup.js';
import { operationAllowsRemoteOwner } from '../protocol/operations.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const policy = {
  revision: 1,
  policy: {
    ...createDefaultRuntimePolicy(),
    externalAgents: { antigravity: { executable: '/agent/agy_acp_server.par' } },
  },
};
const input = {
  attemptId: 'attempt-1',
  action: 'login' as const,
  expectedExecutable: '/agent/agy_acp_server.par',
};
const context: ConnectionContext = {
  hostEpoch: 'epoch',
  connectionId: 'client-1',
  principal: 'local_os_user',
  principalKind: 'local_owner',
  acquireResidency: () => ({ release() {} }),
};
async function projection(
  coordinator: HostExternalAgentSetupCoordinator,
): Promise<ExternalAgentSetupProjection> {
  const result = await coordinator.handlers['external_agents.setup.query'](
    { attemptId: input.attemptId },
    context,
  );
  assert.ok(result.ok);
  return result.result;
}

test('deduplicates admission, preserves cancellation until cleanup, and isolates clients', async () => {
  const cleanup = deferred();
  const admitted = deferred();
  let runs = 0;
  let released = 0;
  const coordinator = new HostExternalAgentSetupCoordinator({
    readPolicy: async () => policy,
    platform: 'darwin',
    arch: 'arm64',
    acquireResidency: () => ({
      release: () => {
        released++;
      },
    }),
    onCleanupFailure() {},
    capabilities: { callService: async () => ({ kind: 'presented' }) },
    run: async ({ signal }) => {
      runs++;
      admitted.resolve();
      await cleanup.promise;
      signal.throwIfAborted();
    },
  });
  try {
    const [first, duplicate] = await Promise.all([
      coordinator.handlers['external_agents.setup.start'](input, context),
      coordinator.handlers['external_agents.setup.start'](input, context),
    ]);
    assert.ok(first.ok && duplicate.ok);
    await admitted.promise;
    assert.equal(runs, 1);
    const competing = await coordinator.handlers['external_agents.setup.start'](
      { ...input, attemptId: 'attempt-2' },
      context,
    );
    assert.ok(!competing.ok && competing.error.code === 'operation_conflict');
    const stranger = await coordinator.handlers['external_agents.setup.cancel'](
      { attemptId: input.attemptId },
      { ...context, connectionId: 'client-2' },
    );
    assert.ok(!stranger.ok && stranger.error.code === 'not_found');
    await coordinator.handlers['external_agents.setup.cancel'](
      { attemptId: input.attemptId },
      context,
    );
    assert.equal((await projection(coordinator)).phase, 'cancelling');
    assert.equal(released, 0);
    cleanup.resolve();
    await coordinator.close();
    assert.equal((await projection(coordinator)).phase, 'cancelled');
    assert.equal(released, 1);
  } finally {
    cleanup.resolve();
    await coordinator.close();
  }
});
test('checks saved config, local ownership, platform and drain before spawning', async () => {
  let runs = 0;
  const deps = {
    readPolicy: async () => policy,
    acquireResidency: () => ({ release() {} }),
    onCleanupFailure() {},
    capabilities: { callService: async () => ({ kind: 'presented' }) },
    run: async () => {
      runs++;
    },
  };
  const coordinator = new HostExternalAgentSetupCoordinator({
    ...deps,
    platform: 'darwin',
    arch: 'arm64',
  });
  const stale = await coordinator.handlers['external_agents.setup.start'](
    { ...input, expectedExecutable: '/changed' },
    context,
  );
  assert.ok(!stale.ok && stale.error.code === 'operation_conflict');
  const remote = await coordinator.handlers['external_agents.setup.start'](input, {
    ...context,
    principalKind: 'remote_owner',
  });
  assert.ok(!remote.ok && remote.error.code === 'unauthorized');
  const unsupported = new HostExternalAgentSetupCoordinator({ ...deps, platform: 'linux' });
  const result = await unsupported.handlers['external_agents.setup.start'](input, context);
  assert.ok(!result.ok && result.error.code === 'operation_unavailable');
  coordinator.beginDrain();
  const drained = await coordinator.handlers['external_agents.setup.start'](input, context);
  assert.ok(!drained.ok && drained.error.code === 'host_draining');
  assert.equal(runs, 0);
});
test('connection release cancels; failed cleanup drains instead of accepting a retry', async () => {
  const waiting = deferred();
  let fatal = 0;
  const coordinator = new HostExternalAgentSetupCoordinator({
    readPolicy: async () => policy,
    platform: 'darwin',
    arch: 'arm64',
    acquireResidency: () => ({ release() {} }),
    onCleanupFailure: () => {
      fatal++;
    },
    capabilities: { callService: async () => ({ kind: 'presented' }) },
    run: async ({ signal }) => {
      signal.addEventListener('abort', waiting.resolve, { once: true });
      await waiting.promise;
      throw new AcpSetupError('cleanup_failed');
    },
  });
  await coordinator.handlers['external_agents.setup.start'](input, context);
  coordinator.releaseConnection(context.connectionId);
  await coordinator.close();
  assert.equal((await projection(coordinator)).failure, 'cleanup_failed');
  assert.equal(fatal, 1);
});
test('browser presentation is addressed to the initiating client and attempt', async () => {
  const shown = deferred();
  let sent: unknown;
  const coordinator = new HostExternalAgentSetupCoordinator({
    readPolicy: async () => policy,
    platform: 'darwin',
    arch: 'arm64',
    acquireResidency: () => ({ release() {} }),
    onCleanupFailure() {},
    capabilities: {
      callService: async (value) => {
        sent = value;
        shown.resolve();
        return { kind: 'presented' };
      },
    },
    run: async ({ onAuthorizationUrl }) => {
      await onAuthorizationUrl('https://accounts.google.com/test');
    },
  });
  await coordinator.handlers['external_agents.setup.start'](input, context);
  await shown.promise;
  assert.equal((sent as { connectionId: string }).connectionId, context.connectionId);
  assert.deepEqual((sent as { input: unknown }).input, {
    url: 'https://accounts.google.com/test',
    stateHint: input.attemptId,
  });
  await coordinator.close();
});
test('protocol is strict, failure has a producer-visible code, and remote grants exclude setup', () => {
  const valid = { ...input, phase: 'failed', failure: 'authentication_failed' };
  assert.deepEqual(decodeExternalAgentSetupProjection(valid), valid);
  for (const invalid of [
    { ...valid, sessionId: 'unused' },
    { ...valid, failure: 'unknown' },
    { ...valid, phase: 'succeeded' },
    { ...input, phase: 'failed' },
  ])
    assert.throws(() => decodeExternalAgentSetupProjection(invalid));
  const spec = EXTERNAL_AGENT_SETUP_OPERATION_SPECS['external_agents.setup.start'];
  assert.throws(() => spec.decodeInput({ ...input, executable: '/arbitrary' }));
  assert.throws(() =>
    spec.assertOutputForInput!(input, { ...input, action: 'check', phase: 'succeeded' }),
  );
  for (const operation of Object.keys(EXTERNAL_AGENT_SETUP_OPERATION_SPECS))
    assert.equal(
      operationAllowsRemoteOwner(operation as keyof typeof EXTERNAL_AGENT_SETUP_OPERATION_SPECS),
      false,
    );
});

test('install admits an empty saved path, reports progress and checks without authentication', async () => {
  const installing = deferred();
  let downloads = 0;
  const checks: string[] = [];
  const coordinator = new HostExternalAgentSetupCoordinator({
    readPolicy: async () => ({ ...policy, policy: createDefaultRuntimePolicy() }),
    platform: 'darwin',
    arch: 'arm64',
    acquireResidency: () => ({ release() {} }),
    onCleanupFailure() {},
    capabilities: {
      callService: async () => {
        throw new Error('must not open browser');
      },
    },
    install: async ({ onProgress }) => {
      downloads++;
      onProgress('downloading', 50);
      await installing.promise;
      return '/managed/agy_acp_server.par';
    },
    run: async ({ action, executable }) => {
      checks.push(`${action}:${executable}`);
    },
  });
  const request = { ...input, action: 'install' as const, expectedExecutable: '' };
  try {
    await coordinator.handlers['external_agents.setup.start'](request, context);
    await coordinator.handlers['external_agents.setup.start'](request, context);
    assert.equal(downloads, 1);
    assert.equal((await projection(coordinator)).downloadPercent, 50);
    installing.resolve();
    for (let i = 0; i < 30 && (await projection(coordinator)).phase !== 'succeeded'; i++)
      await new Promise((r) => setTimeout(r, 5));
    const result = await projection(coordinator);
    assert.equal(result.phase, 'succeeded');
    assert.equal(result.installedExecutable, '/managed/agy_acp_server.par');
    assert.deepEqual(checks, ['check:/managed/agy_acp_server.par']);
    assert.deepEqual(decodeExternalAgentSetupProjection(result), result);
  } finally {
    installing.resolve();
    await coordinator.close();
  }
});
test('installation projection rejects invented progress, phase and output paths', () => {
  const base = {
    ...input,
    action: 'install',
    phase: 'succeeded',
    installedExecutable: '/managed/agy_acp_server.par',
  };
  for (const invalid of [
    { ...base, installedExecutable: undefined },
    { ...base, installedExecutable: 'relative' },
    { ...base, action: 'login' },
    { ...base, downloadPercent: 101 },
    { ...input, phase: 'downloading' },
  ])
    assert.throws(() => decodeExternalAgentSetupProjection(invalid));
});

for (const reason of ['cancel', 'disconnect', 'drain'] as const) {
  test(`installation ${reason} retains ownership until cleanup and never starts ACP`, async () => {
    const cleanup = deferred();
    let released = false;
    let checked = false;
    const coordinator = new HostExternalAgentSetupCoordinator({
      readPolicy: async () => policy,
      platform: 'darwin',
      arch: 'arm64',
      acquireResidency: () => ({
        release() {
          released = true;
        },
      }),
      onCleanupFailure() {},
      capabilities: { callService: async () => ({ kind: 'presented' }) },
      install: async () => {
        await cleanup.promise;
        return '/managed/agy_acp_server.par';
      },
      run: async () => {
        checked = true;
      },
    });
    try {
      await coordinator.handlers['external_agents.setup.start'](
        { ...input, action: 'install' },
        context,
      );
      if (reason === 'cancel')
        await coordinator.handlers['external_agents.setup.cancel'](
          { attemptId: input.attemptId },
          context,
        );
      if (reason === 'disconnect') coordinator.releaseConnection(context.connectionId);
      if (reason === 'drain') coordinator.beginDrain();
      assert.equal((await projection(coordinator)).phase, 'cancelling');
      assert.equal(released, false);
      cleanup.resolve();
      await coordinator.close();
      assert.equal((await projection(coordinator)).phase, 'cancelled');
      assert.equal(checked, false);
      assert.equal(released, true);
    } finally {
      cleanup.resolve();
      await coordinator.close();
    }
  });
}

type SetupDependencies = ConstructorParameters<typeof HostExternalAgentSetupCoordinator>[0];

function authenticationHarness(overrides: Partial<SetupDependencies> = {}) {
  let currentPolicy = structuredClone(policy);
  const released = deferred();
  const coordinator = new HostExternalAgentSetupCoordinator({
    readPolicy: async () => currentPolicy,
    platform: 'darwin',
    arch: 'arm64',
    acquireResidency: () => ({ release: released.resolve }),
    onCleanupFailure() {},
    capabilities: { callService: async () => ({ kind: 'presented' }) },
    run: async () => {},
    ...overrides,
  });
  return {
    coordinator,
    released,
    changeExecutable(executable: string, revision: number) {
      currentPolicy = {
        ...currentPolicy,
        revision,
        policy: { ...currentPolicy.policy, externalAgents: { antigravity: { executable } } },
      };
      coordinator.observePolicy(currentPolicy);
    },
  };
}

async function authentication(coordinator: HostExternalAgentSetupCoordinator) {
  const result = await coordinator.handlers['external_agents.authentication.query']({}, context);
  assert.ok(result.ok);
  return result.result;
}

test('authentication query is Host-local, read-only and independent of setup attempt ownership', async () => {
  let reads = 0;
  const { coordinator } = authenticationHarness({
    readPolicy: async () => {
      reads++;
      return policy;
    },
    run: async () => assert.fail('query must not start an ACP process'),
    acquireResidency: () => assert.fail('query must not hold setup residency'),
  });
  assert.deepEqual(await authentication(coordinator), {
    acpAgentId: 'antigravity',
    executable: input.expectedExecutable,
    status: 'unverified',
  });
  const otherLocal = await coordinator.handlers['external_agents.authentication.query'](
    {},
    {
      ...context,
      connectionId: 'another-local-client',
    },
  );
  assert.ok(otherLocal.ok);
  assert.equal(otherLocal.result.status, 'unverified');
  const remote = await coordinator.handlers['external_agents.authentication.query'](
    {},
    {
      ...context,
      principalKind: 'remote_owner',
    },
  );
  assert.ok(!remote.ok && remote.error.code === 'unauthorized');
  assert.equal(reads, 2);
  await coordinator.close();
});

test('login creates authentication evidence only after the runner completes cleanup', async () => {
  const cleanup = deferred();
  const { coordinator, released } = authenticationHarness({ run: async () => cleanup.promise });
  await coordinator.handlers['external_agents.setup.start'](input, context);
  assert.equal((await authentication(coordinator)).status, 'unverified');
  cleanup.resolve();
  await released.promise;
  assert.equal((await projection(coordinator)).phase, 'succeeded');
  assert.equal((await authentication(coordinator)).status, 'verified');
  const restarted = authenticationHarness();
  assert.equal((await authentication(restarted.coordinator)).status, 'unverified');
  await coordinator.close();
  await restarted.coordinator.close();
});

for (const action of ['check', 'install'] as const) {
  test(`${action} success does not create authentication evidence`, async () => {
    const { coordinator, released } = authenticationHarness({
      install: async () => '/managed/agy_acp_server.par',
    });
    await coordinator.handlers['external_agents.setup.start']({ ...input, action }, context);
    await released.promise;
    assert.equal((await projection(coordinator)).phase, 'succeeded');
    assert.equal((await authentication(coordinator)).status, 'unverified');
    await coordinator.close();
  });
}

test('a changed executable invalidates evidence even when switched back before querying', async () => {
  const { coordinator, released, changeExecutable } = authenticationHarness();
  await coordinator.handlers['external_agents.setup.start'](input, context);
  await released.promise;
  assert.equal((await authentication(coordinator)).status, 'verified');
  changeExecutable(input.expectedExecutable, 2);
  assert.equal((await authentication(coordinator)).status, 'verified');
  changeExecutable('/agent/replacement', 3);
  changeExecutable(input.expectedExecutable, 4);
  assert.equal((await authentication(coordinator)).status, 'unverified');
  coordinator.observePolicy({
    ...policy,
    revision: 1,
    policy: { ...policy.policy, externalAgents: { antigravity: { executable: '/stale' } } },
  });
  assert.equal((await authentication(coordinator)).executable, input.expectedExecutable);
  assert.equal((await authentication(coordinator)).status, 'unverified');
  await coordinator.close();
});

test('late login success cannot authenticate a newer executable generation', async () => {
  const cleanup = deferred();
  const { coordinator, released, changeExecutable } = authenticationHarness({
    run: async () => cleanup.promise,
  });
  await coordinator.handlers['external_agents.setup.start'](input, context);
  changeExecutable('/agent/replacement', 2);
  changeExecutable(input.expectedExecutable, 3);
  cleanup.resolve();
  await released.promise;
  assert.equal((await projection(coordinator)).phase, 'succeeded');
  assert.equal((await authentication(coordinator)).status, 'unverified');
  await coordinator.close();
});

test('cancelled and failed login attempts never create authentication evidence', async () => {
  const cleanup = deferred();
  const cancelled = authenticationHarness({ run: async () => cleanup.promise });
  await cancelled.coordinator.handlers['external_agents.setup.start'](input, context);
  await cancelled.coordinator.handlers['external_agents.setup.cancel'](
    { attemptId: input.attemptId },
    context,
  );
  cleanup.resolve();
  await cancelled.released.promise;
  assert.equal((await projection(cancelled.coordinator)).phase, 'cancelled');
  assert.equal((await authentication(cancelled.coordinator)).status, 'unverified');
  await cancelled.coordinator.close();

  const failed = authenticationHarness({
    run: async () => {
      throw new AcpSetupError('authentication_failed');
    },
  });
  await failed.coordinator.handlers['external_agents.setup.start'](input, context);
  await failed.released.promise;
  assert.equal((await projection(failed.coordinator)).failure, 'authentication_failed');
  assert.equal((await authentication(failed.coordinator)).status, 'unverified');
  await failed.coordinator.close();
});

test('the authentication wire contract does not expose execution or saved credential claims', () => {
  const query = EXTERNAL_AGENT_SETUP_OPERATION_SPECS['external_agents.authentication.query'];
  assert.deepEqual(query.decodeInput({}), {});
  for (const invalid of [null, [], { executable: '/arbitrary' }, { sessionId: 'unused' }])
    assert.throws(() => query.decodeInput(invalid));
  const valid = { acpAgentId: 'antigravity', executable: '', status: 'unverified' };
  assert.deepEqual(decodeExternalAgentAuthenticationProjection(valid), valid);
  for (const invalid of [
    { ...valid, status: 'ready' },
    { ...valid, status: 'verified' },
    { ...valid, acpAgentId: 'unknown' },
    { ...valid, model: 'invented-model' },
    { ...valid, credential: 'secret' },
    { ...valid, executable: 42 },
  ])
    assert.throws(() => decodeExternalAgentAuthenticationProjection(invalid));
  assert.equal(operationAllowsRemoteOwner('external_agents.authentication.query'), false);
});

for (const action of ['check', 'login', 'install'] as const) {
  test(`${action} resolves the current process environment immediately before its ACP run`, async () => {
    const calls: string[] = [];
    const expected = { HTTPS_PROXY: 'http://localhost:12345', NO_PROXY: 'localhost' };
    const { coordinator, released } = authenticationHarness({
      install: async () => {
        calls.push('install');
        return '/managed/agy_acp_server.par';
      },
      resolveEnvironment: async () => {
        calls.push('environment');
        return expected;
      },
      run: async ({ env }) => {
        calls.push('run');
        assert.deepEqual(env, expected);
      },
    });
    await coordinator.handlers['external_agents.setup.start']({ ...input, action }, context);
    await released.promise;
    assert.deepEqual(
      calls,
      action === 'install' ? ['install', 'environment', 'run'] : ['environment', 'run'],
    );
    assert.equal((await projection(coordinator)).phase, 'succeeded');
    await coordinator.close();
  });
}

test('environment resolution failure prevents spawning and keeps its actionable setup code', async () => {
  const { coordinator, released } = authenticationHarness({
    resolveEnvironment: async () => {
      throw new AcpSetupError('proxy_unsupported');
    },
    run: async () => assert.fail('unsupported proxy must not start a process'),
  });
  await coordinator.handlers['external_agents.setup.start'](input, context);
  await released.promise;
  assert.equal((await projection(coordinator)).failure, 'proxy_unsupported');
  assert.equal((await authentication(coordinator)).status, 'unverified');
  await coordinator.close();
});

test('cancellation while resolving environment never starts the agent', async () => {
  const resolveEnvironment = deferred();
  const { coordinator, released } = authenticationHarness({
    resolveEnvironment: async () => {
      await resolveEnvironment.promise;
      return {};
    },
    run: async () => assert.fail('cancelled setup must not start a process'),
  });
  await coordinator.handlers['external_agents.setup.start'](input, context);
  await coordinator.handlers['external_agents.setup.cancel'](
    { attemptId: input.attemptId },
    context,
  );
  resolveEnvironment.resolve();
  await released.promise;
  assert.equal((await projection(coordinator)).phase, 'cancelled');
  assert.equal((await authentication(coordinator)).status, 'unverified');
  await coordinator.close();
});

test('cleanup failure retains its connection owner across failed shutdown retries', async () => {
  let retries = 0;
  let fatal = 0;
  const owner = {
    async dispose() {
      retries++;
      if (retries === 1) throw new AcpSetupError('cleanup_failed');
    },
  } as AcpConnectionOwner;
  const { coordinator, released } = authenticationHarness({
    run: async () => {
      throw new AcpSetupCleanupError(owner);
    },
    onCleanupFailure: () => {
      fatal++;
    },
  });
  await coordinator.handlers['external_agents.setup.start'](input, context);
  await released.promise;
  assert.equal((await projection(coordinator)).failure, 'cleanup_failed');
  assert.equal(fatal, 1);
  const status = await coordinator.handlers['external_agents.authentication.query']({}, context);
  assert.ok(!status.ok && status.error.code === 'host_draining');
  await assert.rejects(coordinator.close(), /cleanup_failed/);
  assert.equal(retries, 1);
  await coordinator.close();
  assert.equal(retries, 2);
  await coordinator.close();
  assert.equal(retries, 2);
});

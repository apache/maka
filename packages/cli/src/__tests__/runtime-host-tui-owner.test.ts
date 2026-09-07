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
import test from 'node:test';
import {
  LOCAL_RUNTIME_HOST_PROFILE,
  type RuntimeHostConnection,
  type RuntimeHostProfile,
} from '@maka/runtime-host/client';
import type { LocalHostDeploymentRecord } from '@maka/runtime-host/operator';
import type { HostDiagnosticsResult } from '@maka/runtime-host/protocol';
import { describeTuiHost, prepareTuiHostOwnerAction } from '../runtime-host-tui-owner.js';

type Deps = NonNullable<Parameters<typeof prepareTuiHostOwnerAction>[1]>;
type Input = Parameters<typeof prepareTuiHostOwnerAction>[0];

function fixture() {
  const owner = { kind: 'cli' as const, installationId: 'npm-global:owner' };
  const selected = { kind: 'npm_registry' as const, version: '1.0.0', integrity: 'sha512-proof' };
  let record: LocalHostDeploymentRecord = {
    schemaVersion: 1,
    rootId: 'a'.repeat(64),
    revision: 'revision',
    state: { kind: 'owned', owner, selected },
  };
  let diagnostics = {
    hostEpoch: 'epoch',
    pid: 123,
    state: 'ready',
    compositionId: 'interactive',
    compositionRevision: 'older-compatible-release',
    connections: 1,
    activeOperations: 1,
    activeResidencies: 0,
    residencies: [],
    upgradeBlockingActivity: false,
  } as unknown as HostDiagnosticsResult;
  const connection = {
    rootId: record.rootId,
    hostEpoch: 'epoch',
    request: async () => diagnostics,
    status: async () => diagnostics,
    close: async () => {},
  } as unknown as RuntimeHostConnection;
  let epoch = 'epoch';
  const events: string[] = [];
  const deps: Deps = {
    resolveInstallation: async () => ({
      owner,
      observedRelease: {
        version: '1.0.0',
        packageRoot: '/npm/maka-agent',
        cliPath: '/npm/maka-agent/dist/cli.js',
      },
    }),
    readRecord: async () => record,
    connectExisting: async () =>
      ({
        kind: 'connected',
        connection,
        registration: {
          rootId: record.rootId,
          hostEpoch: epoch,
          lifecycleMode: 'ephemeral',
          pid: 123,
        },
      }) as Awaited<ReturnType<NonNullable<Deps['connectExisting']>>>,
    withAuthority: async (_root, operation) => {
      events.push('authority');
      return operation(
        {
          read: async () => record,
          apply: async () => {
            throw new Error('No journal mutation expected');
          },
        },
        7,
      );
    },
    retire: async (request) => {
      await request.connectExisting!({ rootPath: request.rootPath, protocol: { min: 1, max: 1 } });
      events.push(request.allowInterruptActiveTasks ? 'interrupt' : 'safe-retire');
      return {
        kind: 'retired',
        owner: {
          close: async () => {
            events.push('writer-released');
          },
        },
      } as Awaited<ReturnType<NonNullable<Deps['retire']>>>;
    },
    openStaged: async (request) => {
      assert.deepEqual(request.target, selected);
      events.push('open-selected');
      return {
        cliPath: '/verified/cli.js',
        packageRoot: '/verified',
        candidateEntrypoint: '/verified/candidate.js',
        launchGeneration: request.transactionId,
      } as Awaited<ReturnType<NonNullable<Deps['openStaged']>>>;
    },
    activate: async (request) => {
      assert.equal(request.inheritableAuthorityLeaseFd, 7);
      assert.deepEqual(request.target, selected);
      events.push('activate-selected');
      return {
        kind: 'ready',
        settle: async () => {
          events.push('settle-existing-owner');
        },
      };
    },
    update: async (request) => {
      assert.equal(request.allowInterruptActiveTasks, false);
      assert.deepEqual(request.expectedSource, {
        rootId: 'a'.repeat(64),
        deploymentRevision: 'revision',
        ownerInstallationId: owner.installationId,
        hostEpoch: 'epoch',
      });
      events.push(`update:${request.selector.kind}`);
      return 0;
    },
  };
  const input: Input = {
    profile: LOCAL_RUNTIME_HOST_PROFILE,
    connection,
    rootPath: '/root',
    action: { action: 'stop' },
    confirm: async () => {
      throw new Error('Idle action needs no confirmation');
    },
  };
  return {
    input,
    deps,
    events,
    changeOwner: () => {
      record = { ...record, revision: 'changed' };
    },
    changeEpoch: () => {
      epoch = 'new-epoch';
    },
    busy: () => {
      diagnostics = {
        ...diagnostics,
        activeResidencies: 1,
        residencies: [{ label: 'goal', count: 1 }],
        upgradeBlockingActivity: true,
      };
    },
    changeActivity: () => {
      diagnostics = { ...diagnostics, connections: 2 };
    },
  };
}

test('owner status remains readable for a compatible attached Host without granting mutation rights', async () => {
  const { input } = fixture();
  const status = await describeTuiHost(input);
  assert.match(status, /older-compatible-release/);
  assert.match(status, /epoch/);
});

test('Host status, owner refusals, and busy confirmation follow the TUI locale', async () => {
  for (const locale of ['zh-CN', 'zh-TW'] as const) {
    const f = fixture();
    const status = await describeTuiHost({ ...f.input, locale });
    assert.match(status, /就绪|就緒/);
    assert.match(status, /连接数|連線數/);
    assert.match(status, /older-compatible-release/);
    await assert.rejects(
      prepareTuiHostOwnerAction(
        { ...f.input, locale },
        { ...f.deps, readRecord: async () => undefined },
      ),
      /不是本地 Host 的所有者|不是本機 Host 的擁有者/,
    );
    f.busy();
    const cancelled = await prepareTuiHostOwnerAction(
      {
        ...f.input,
        locale,
        action: { action: 'update' },
        confirm: async (detail) => {
          assert.match(detail, /更新/);
          assert.match(detail, /安全交接/);
          assert.match(detail, /npm-global:owner/);
          assert.doesNotMatch(detail, /Connections:|Owner:|safe handoff only/);
          return 'cancel';
        },
      },
      f.deps,
    );
    assert.equal(cancelled, undefined);
    assert.deepEqual(f.events, []);
  }
});

test('remote attachment and foreign installation owner cannot mint owner actions', async () => {
  const f = fixture();
  await assert.rejects(
    prepareTuiHostOwnerAction(
      {
        ...f.input,
        profile: { id: 'remote', name: 'Remote', kind: 'remote' } as RuntimeHostProfile,
      },
      f.deps,
    ),
    /another Host/,
  );
  await assert.rejects(
    prepareTuiHostOwnerAction(f.input, { ...f.deps, readRecord: async () => undefined }),
    /does not own/,
  );
  assert.deepEqual(f.events, []);
});

test('preflight is read-only and stop retains the durable owner instead of launching a replacement', async () => {
  const f = fixture();
  const execute = await prepareTuiHostOwnerAction(f.input, f.deps);
  assert.deepEqual(f.events, []);
  assert.ok(execute);
  assert.equal(await execute(), 0);
  assert.deepEqual(f.events, ['authority', 'safe-retire', 'writer-released']);
});

test('same-artifact restart reuses selected package and existing durable owner', async () => {
  const f = fixture();
  const execute = await prepareTuiHostOwnerAction(
    { ...f.input, action: { action: 'restart' } },
    f.deps,
  );
  assert.ok(execute);
  await execute();
  assert.deepEqual(f.events, [
    'authority',
    'open-selected',
    'safe-retire',
    'writer-released',
    'activate-selected',
    'settle-existing-owner',
  ]);
});

test('changed owner or Host epoch invalidates the pending action before retirement', async () => {
  for (const change of ['changeOwner', 'changeEpoch'] as const) {
    const f = fixture();
    const execute = await prepareTuiHostOwnerAction(f.input, f.deps);
    assert.ok(execute);
    f[change]();
    await assert.rejects(execute(), /changed/);
    assert.deepEqual(f.events, ['authority']);
  }
});

test('busy work requires confirmation and changed activity invalidates interruption consent', async () => {
  const f = fixture();
  f.busy();
  const cancelled = await prepareTuiHostOwnerAction(
    {
      ...f.input,
      confirm: async (detail) => {
        assert.match(detail, /npm-global:owner/);
        assert.match(detail, /epoch/);
        assert.match(detail, /goal/);
        return 'cancel';
      },
    },
    f.deps,
  );
  assert.equal(cancelled, undefined);
  assert.deepEqual(f.events, []);
  const execute = await prepareTuiHostOwnerAction(
    { ...f.input, confirm: async () => 'interrupt' },
    f.deps,
  );
  assert.ok(execute);
  f.changeActivity();
  await assert.rejects(execute(), /activity changed/);
  assert.deepEqual(f.events, ['authority']);
});

test('update delegates to the existing safe installed-update coordinator', async () => {
  const f = fixture();
  const execute = await prepareTuiHostOwnerAction(
    { ...f.input, action: { action: 'update', target: 'next' } },
    f.deps,
  );
  assert.ok(execute);
  await execute();
  assert.deepEqual(f.events, ['update:channel']);
});

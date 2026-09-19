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
import { createDefaultRuntimePolicy, type RuntimePolicy } from '@maka/core/runtime-policy';
import { MakaCompositionLoader } from '@maka/runtime/plugin-composition-loader';
import { PluginExecutorService } from '@maka/runtime/plugin-executor-service';
import { Context } from '@maka/runtime/plugin-kernel';
import {
  HostBuiltinExternalAgentPluginCoordinator,
  resolveBuiltinExternalAgentPluginEntries,
} from '../server/builtin-external-agent-plugins.js';
import { HostPluginPlatform } from '../server/plugin-platform.js';

test('built-in ACP packages load their production bundles and follow RuntimePolicy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-builtin-acp-plugins-'));
  let policy = configuredPolicy('/opt/antigravity/agy_acp_server.par');
  try {
    const first = createPlatform(join(root, 'control'));
    await first.platform.recover();
    const coordinator = new HostBuiltinExternalAgentPluginCoordinator({
      platform: first.platform,
      controlDirectory: join(root, 'control'),
      readPolicy: async () => ({ revision: 4, policy }),
      entries: resolveBuiltinExternalAgentPluginEntries(),
    });

    await coordinator.recover();
    assert.deepEqual(
      first.platform.inspectExecutors('profile').map(({ id, entryId, extensionId }) => ({
        id,
        entryId,
        extensionId,
      })),
      [
        {
          id: 'antigravity-acp',
          entryId: 'antigravity-acp',
          extensionId: 'antigravity-acp',
        },
      ],
    );
    assert.deepEqual(
      (await first.platform.packageProjections()).map(({ extensionId }) => extensionId),
      ['acp-executor', 'antigravity-acp'],
    );
    const initialEpoch = (await first.platform.status()).authorityEpoch;
    await coordinator.reconcile();
    assert.equal((await first.platform.status()).authorityEpoch, initialEpoch);

    policy = configuredPolicy('/Applications/Antigravity/agy_acp_server.par');
    await coordinator.reconcile();
    const adapter = first.platform
      .desiredComposition()
      .roots.profile[0]?.children?.find(({ id }) => id === 'antigravity-acp');
    assert.deepEqual(adapter?.config, {
      executable: '/Applications/Antigravity/agy_acp_server.par',
    });
    assert.equal((await first.platform.status()).authorityEpoch, initialEpoch + 1);
    await first.platform.close();

    const restarted = createPlatform(join(root, 'control'));
    await restarted.platform.recover();
    const recoveredEpoch = (await restarted.platform.status()).authorityEpoch;
    const recoveredCoordinator = new HostBuiltinExternalAgentPluginCoordinator({
      platform: restarted.platform,
      controlDirectory: join(root, 'control'),
      readPolicy: async () => ({ revision: 5, policy }),
      entries: resolveBuiltinExternalAgentPluginEntries(),
    });
    await recoveredCoordinator.recover();
    assert.equal((await restarted.platform.status()).authorityEpoch, recoveredEpoch);
    assert.equal(restarted.platform.inspectExecutors('profile')[0]?.id, 'antigravity-acp');

    policy = createDefaultRuntimePolicy();
    await recoveredCoordinator.reconcile();
    assert.deepEqual(restarted.platform.inspectExecutors('profile'), []);
    assert.deepEqual(await restarted.platform.packageProjections(), []);
    await restarted.platform.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function createPlatform(controlDirectory: string): {
  readonly platform: HostPluginPlatform;
} {
  const root = new Context();
  const executors = new PluginExecutorService(root);
  return {
    platform: new HostPluginPlatform(controlDirectory, {
      composition: new MakaCompositionLoader({ root }),
      executors,
    }),
  };
}

function configuredPolicy(executable: string): RuntimePolicy {
  const policy = createDefaultRuntimePolicy();
  return {
    ...policy,
    externalAgents: { antigravity: { executable } },
  };
}

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
import { REQUEST_COMPOSITION_MAX_TOOL_DESCRIPTION_LENGTH } from '@maka/core/run-composition';
import { Context } from '../plugin-kernel.js';
import { MakaCompositionLoader } from '../plugin-composition-loader.js';
import { PluginToolService } from '../plugin-tool-service.js';
import type { MakaPluginPackage } from '../plugin-runtime.js';
import { toolActivationKey } from '../tool-activation-identity.js';
import type { MakaTool } from '../tool-runtime.js';

test('Profile tools are inherited and exact Session tools shadow them', async () => {
  const changed: string[] = [];
  let eventCount = 0;
  const root = new Context();
  root.on('tools/change', () => {
    eventCount += 1;
  });
  const tools = new PluginToolService(root, { onChanged: (rootId) => changed.push(rootId) });
  const loader = new MakaCompositionLoader({ root });
  await loader.install(toolPackage('profile-package', tool('answer', 'profile')));
  await loader.install(toolPackage('session-package', tool('answer', 'session')));
  await loader.create('profile', { id: 'profile-entry', packageId: 'profile-package' });
  await loader.create('session:alpha', { id: 'session-entry', packageId: 'session-package' });

  const alpha = tools.resolve('alpha', []);
  const beta = tools.resolve('beta', []);
  assert.equal(await invoke(alpha.tools[0]!), 'session');
  assert.equal(await invoke(beta.tools[0]!), 'profile');
  assert.deepEqual(changed, ['profile', 'session:alpha']);

  await loader.remove('session-entry');
  assert.equal(await invoke(tools.resolve('alpha', []).tools[0]!), 'profile');
  assert.equal(eventCount, 3);
  await loader.close();
});

test('Tool publication is atomic with Entry activation', async () => {
  const root = new Context();
  const tools = new PluginToolService(root);
  const loader = new MakaCompositionLoader({ root });
  await loader.install({
    packageId: 'broken-package',
    host: (ctx) => {
      ctx.tools.register(tool('partial', 'never-visible'));
      throw new Error('activation failed');
    },
  });

  await assert.rejects(
    () => loader.create('profile', { id: 'broken-entry', packageId: 'broken-package' }),
    /activation failed/u,
  );
  assert.deepEqual(tools.inspect(), []);
  assert.deepEqual(tools.resolve('alpha', []).tools, []);
  await loader.close();
});

test('a failing tools/change listener rolls registration back atomically', async () => {
  const root = new Context();
  root.on('tools/change', () => {
    throw new Error('change rejected');
  });
  const tools = new PluginToolService(root);
  const loader = new MakaCompositionLoader({ root });
  await loader.install(toolPackage('rejected-package', tool('rejected', 'never-visible')));

  await assert.rejects(
    () => loader.create('profile', { id: 'rejected-entry', packageId: 'rejected-package' }),
    /change rejected/u,
  );
  assert.deepEqual(tools.inspect(), []);
  await loader.close();
});

test('ctx.tools.register returns a live disposer', async () => {
  let dispose!: () => Promise<void>;
  const root = new Context();
  const tools = new PluginToolService(root);
  const loader = new MakaCompositionLoader({ root });
  await loader.install({
    packageId: 'dynamic-package',
    host: (ctx) => {
      dispose = ctx.tools.register(tool('dynamic', 'visible'));
    },
  });
  await loader.create('profile', { id: 'dynamic-entry', packageId: 'dynamic-package' });

  assert.deepEqual(
    tools.resolve('alpha', []).tools.map(({ name }) => name),
    ['dynamic'],
  );
  await dispose();
  assert.deepEqual(tools.resolve('alpha', []).tools, []);
  await loader.close();
});

test('Plugin Tool activation identity is stable within and fenced across generations', async () => {
  const root = new Context();
  const tools = new PluginToolService(root);
  const loader = new MakaCompositionLoader({ root });
  await loader.install(toolPackage('dynamic-package', tool('dynamic', 'visible')));
  await loader.create('profile', { id: 'dynamic-entry', packageId: 'dynamic-package' });

  const first = tools.resolve('alpha', []).tools[0]!;
  assert.equal(toolActivationKey(tools.resolve('alpha', []).tools[0]!), toolActivationKey(first));

  await loader.remove('dynamic-entry');
  await loader.create('profile', { id: 'dynamic-entry', packageId: 'dynamic-package' });
  const replacement = tools.resolve('alpha', []).tools[0]!;
  assert.notEqual(toolActivationKey(replacement), toolActivationKey(first));
  await loader.close();
});

test('retirement rejects stale starts and waits for an active call to drain', async () => {
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const root = new Context();
  const tools = new PluginToolService(root);
  const loader = new MakaCompositionLoader({ root });
  await loader.install(
    toolPackage('slow-package', {
      ...tool('slow', 'done'),
      impl: async () => {
        await gate;
        return 'done';
      },
    }),
  );
  await loader.create('profile', { id: 'slow-entry', packageId: 'slow-package' });
  const exposed = tools.resolve('alpha', []).tools[0]!;
  const call = invoke(exposed);
  let retired = false;
  const removal = loader.remove('slow-entry').then(() => {
    retired = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(retired, false);
  await assert.rejects(() => invoke(exposed), /no longer active/u);
  finish();
  assert.equal(await call, 'done');
  await removal;
  assert.deepEqual(tools.inspect(), []);
  await loader.close();
});

test('desktop-ui and Host-owned Tool conflicts fail closed', async () => {
  const root = new Context();
  const tools = new PluginToolService(root);
  const loader = new MakaCompositionLoader({ root });
  await loader.install(toolPackage('plugin-package', tool('Read', 'plugin')));
  await assert.rejects(
    () => loader.create('desktop-ui', { id: 'ui-entry', packageId: 'plugin-package' }),
    /desktop-ui plugins cannot register Host tools/u,
  );
  await loader.create('profile', { id: 'host-conflict-entry', packageId: 'plugin-package' });
  assert.throws(() => tools.resolve('alpha', [tool('Read', 'host')]), /Host-owned Tool/u);
  await loader.close();
});

test('Plugin Tool descriptions satisfy the Request Composition bound', async () => {
  const root = new Context();
  const tools = new PluginToolService(root);
  const loader = new MakaCompositionLoader({ root });
  await loader.install({
    packageId: 'oversized-description-package',
    host: (ctx) => {
      ctx.tools.register({
        ...tool('oversized', 'unused'),
        description: 'x'.repeat(REQUEST_COMPOSITION_MAX_TOOL_DESCRIPTION_LENGTH + 1),
      });
    },
  });

  await assert.rejects(
    () =>
      loader.create('profile', {
        id: 'oversized-description-entry',
        packageId: 'oversized-description-package',
      }),
    /description of at most 16384 characters/u,
  );
  assert.deepEqual(tools.inspect(), []);
  await loader.close();
});

function tool(name: string, result: string): MakaTool {
  return {
    name,
    description: name,
    parameters: {},
    impl: async () => result,
  };
}

function toolPackage(packageId: string, definition: MakaTool): MakaPluginPackage {
  return {
    packageId,
    host: (ctx) => {
      ctx.tools.register(definition);
    },
  };
}

async function invoke(definition: MakaTool): Promise<unknown> {
  return await definition.impl({}, {} as never);
}

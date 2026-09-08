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
import { Context } from '../plugin-kernel.js';
import { MakaCompositionLoader } from '../plugin-composition-loader.js';
import {
  PLUGIN_SYSTEM_PROMPT_SOURCE_ID,
  PluginSystemPromptService,
  type PluginSystemPromptContext,
} from '../plugin-system-prompt-service.js';

const assemblyContext: PluginSystemPromptContext = {
  sessionId: 'alpha',
  turnId: 'turn-1',
  cwd: '/workspace',
};

test('Profile sections are inherited and exact Session sections shadow them', async () => {
  const { loader, prompts } = setup();
  await loader.install({
    packageId: 'profile-package',
    host: (ctx) => ctx.systemPrompt.section({ name: 'plugin:policy', order: 10, text: 'profile' }),
  });
  await loader.install({
    packageId: 'session-package',
    host: (ctx) => ctx.systemPrompt.section({ name: 'plugin:policy', order: 10, text: 'session' }),
  });
  await loader.create('profile', { id: 'profile-entry', packageId: 'profile-package' });
  await loader.create('session:alpha', { id: 'session-entry', packageId: 'session-package' });

  assert.equal((await prompts.assemble(assemblyContext, 'base')).text, 'base\n\nsession');
  assert.equal(
    (await prompts.assemble({ ...assemblyContext, sessionId: 'beta' }, 'base')).text,
    'base\n\nprofile',
  );

  await loader.remove('session-entry');
  assert.equal((await prompts.assemble(assemblyContext, 'base')).text, 'base\n\nprofile');
  await loader.close();
});

test('sections and variables resolve for every assembly from a stable membership snapshot', async () => {
  const { loader, prompts } = setup();
  let value = 'first';
  let late = false;
  await loader.install({
    packageId: 'dynamic-package',
    host: (ctx) => {
      ctx.systemPrompt.variable('mode', () => value);
      ctx.systemPrompt.section({
        name: 'plugin:dynamic',
        order: 20,
        text: () => {
          if (!late) {
            late = true;
            ctx.systemPrompt.section({ name: 'plugin:late', order: 30, text: 'late' });
          }
          return 'mode={{mode}}';
        },
      });
    },
  });
  await loader.create('profile', { id: 'dynamic-entry', packageId: 'dynamic-package' });

  const first = await prompts.assemble(assemblyContext, 'base');
  value = 'second';
  const second = await prompts.assemble(assemblyContext, 'base');
  assert.equal(first.text, 'base\n\nmode=first');
  assert.equal(second.text, 'base\n\nmode=second\n\nlate');
  assert.equal(first.sourceRevision?.id, PLUGIN_SYSTEM_PROMPT_SOURCE_ID);
  assert.notEqual(first.sourceRevision?.revision, second.sourceRevision?.revision);
  await loader.close();
});

test('complete sections replace the Host base and multiple complete sections fail closed', async () => {
  const { loader, prompts } = setup();
  await loader.install({
    packageId: 'complete-package',
    host: (ctx) => {
      ctx.systemPrompt.section({ name: 'plugin:extra', order: 1, text: 'extra' });
      ctx.systemPrompt.section({
        name: 'plugin:complete',
        order: 2,
        text: 'replacement',
        complete: true,
      });
    },
  });
  await loader.create('profile', { id: 'complete-entry', packageId: 'complete-package' });
  assert.equal((await prompts.assemble(assemblyContext, 'base')).text, 'replacement');

  await loader.install({
    packageId: 'second-complete-package',
    host: (ctx) =>
      ctx.systemPrompt.section({
        name: 'plugin:second-complete',
        order: 3,
        text: 'second',
        complete: true,
      }),
  });
  await loader.create('profile', {
    id: 'second-complete-entry',
    packageId: 'second-complete-package',
  });
  await assert.rejects(() => prompts.assemble(assemblyContext, 'base'), /Multiple complete/u);
  await loader.close();
});

test('failed activation publishes no partial System Prompt contribution', async () => {
  const { loader, prompts } = setup();
  await loader.install({
    packageId: 'broken-package',
    host: (ctx) => {
      ctx.systemPrompt.section({ name: 'plugin:partial', order: 1, text: 'partial' });
      throw new Error('activation failed');
    },
  });

  await assert.rejects(
    () => loader.create('profile', { id: 'broken-entry', packageId: 'broken-package' }),
    /activation failed/u,
  );
  assert.deepEqual(prompts.inspect(), []);
  assert.equal((await prompts.assemble(assemblyContext, 'base')).text, 'base');
  await loader.close();
});

test('replacement restores the prior generation when the candidate rolls back', async () => {
  const { loader, prompts } = setup();
  await loader.install({
    packageId: 'replaceable-package',
    host: (ctx) =>
      ctx.systemPrompt.section({ name: 'plugin:replaceable', order: 1, text: 'current' }),
  });
  await loader.create('profile', { id: 'replaceable-entry', packageId: 'replaceable-package' });

  await assert.rejects(
    () =>
      loader.reload({
        packageId: 'replaceable-package',
        host: (ctx) => {
          ctx.systemPrompt.section({ name: 'plugin:replaceable', order: 1, text: 'candidate' });
          throw new Error('candidate failed');
        },
      }),
    /candidate failed/u,
  );
  assert.equal((await prompts.assemble(assemblyContext, 'base')).text, 'base\n\ncurrent');
  await loader.close();
});

test('successful replacement does not resurrect its retired predecessor', async () => {
  const { loader, prompts } = setup();
  await loader.install({
    packageId: 'replaceable-package',
    host: (ctx) => ctx.systemPrompt.section({ name: 'plugin:replaceable', order: 1, text: 'old' }),
  });
  await loader.create('profile', { id: 'replaceable-entry', packageId: 'replaceable-package' });
  await loader.reload({
    packageId: 'replaceable-package',
    host: (ctx) => ctx.systemPrompt.section({ name: 'plugin:replaceable', order: 1, text: 'new' }),
  });
  assert.equal((await prompts.assemble(assemblyContext, 'base')).text, 'base\n\nnew');

  await loader.remove('replaceable-entry');
  assert.equal((await prompts.assemble(assemblyContext, 'base')).text, 'base');
  await loader.close();
});

test('desktop-ui registration and unresolved variables fail closed', async () => {
  const { loader, prompts } = setup();
  await loader.install({
    packageId: 'ui-package',
    host: (ctx) => ctx.systemPrompt.section({ name: 'plugin:ui', order: 1, text: 'ui' }),
  });
  await assert.rejects(
    () => loader.create('desktop-ui', { id: 'ui-entry', packageId: 'ui-package' }),
    /desktop-ui plugins cannot contribute Host System Prompt/u,
  );

  await loader.install({
    packageId: 'variable-package',
    host: (ctx) =>
      ctx.systemPrompt.section({ name: 'plugin:missing', order: 1, text: '{{missing}}' }),
  });
  await loader.create('profile', { id: 'variable-entry', packageId: 'variable-package' });
  await assert.rejects(
    () => prompts.assemble(assemblyContext, 'base'),
    /Unknown System Prompt variable/u,
  );
  await loader.close();
});

function setup(): { loader: MakaCompositionLoader; prompts: PluginSystemPromptService } {
  const root = new Context();
  const prompts = new PluginSystemPromptService(root);
  const loader = new MakaCompositionLoader({ root });
  return { loader, prompts };
}

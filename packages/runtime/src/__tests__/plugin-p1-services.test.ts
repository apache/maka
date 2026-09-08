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
import { PluginCommandService } from '../plugin-command-service.js';
import { MakaCompositionLoader } from '../plugin-composition-loader.js';
import { Context } from '../plugin-kernel.js';
import { PluginLspService } from '../plugin-lsp-service.js';
import { PluginShellEnvService } from '../plugin-shell-env-service.js';
import { PluginSkillService } from '../plugin-skill-service.js';

test('P1 contributions inherit, shadow, and restore with their Plugin Fiber', async () => {
  const root = new Context();
  const skills = new PluginSkillService(root);
  const commands = new PluginCommandService(root);
  const lsp = new PluginLspService(root);
  const shellEnv = new PluginShellEnvService(root);
  const loader = new MakaCompositionLoader({ root });
  const plugin = (marker: string) => ({
    apply(ctx: Context) {
      ctx.skills.register({
        name: 'probe-skill',
        description: marker,
        instructions: `# ${marker}`,
      });
      ctx.commands.register({ name: 'probe', description: marker, execute: () => marker });
      ctx.lsp.registerProvider({
        id: `lsp-${marker}`,
        extensionToLanguage: { ts: `typescript-${marker}` },
        query: async ({ languageId }) => languageId,
      });
      ctx.shellEnv.register({
        name: `env-${marker}`,
        variables: { MAKA_PLUGIN_MARKER: { description: marker } },
        resolve: () => ({ MAKA_PLUGIN_MARKER: marker }),
      });
    },
  });
  try {
    await loader.install({ packageId: 'profile-package', host: plugin('profile') });
    await loader.install({ packageId: 'session-package', host: plugin('session') });
    await loader.create('profile', { id: 'profile-entry', packageId: 'profile-package' });
    await loader.create('session:alpha', { id: 'session-entry', packageId: 'session-package' });

    assert.equal(skills.get('other', 'probe-skill')?.description, 'profile');
    assert.equal(skills.get('alpha', 'probe-skill')?.description, 'session');
    assert.equal(await commands.execute('probe', { sessionId: 'other', args: [] }), 'profile');
    assert.equal(await commands.execute('probe', { sessionId: 'alpha', args: [] }), 'session');
    assert.equal(
      await lsp.query({
        sessionId: 'alpha',
        filePath: 'index.TS',
        position: { line: 0, character: 0 },
        operation: 'hover',
      }),
      'typescript-session',
    );
    assert.deepEqual(await shellEnv.collect(invocation('alpha')), {
      MAKA_PLUGIN_MARKER: 'session',
    });

    await loader.remove('session-entry');
    assert.equal(skills.get('alpha', 'probe-skill')?.description, 'profile');
    assert.equal(await commands.execute('probe', { sessionId: 'alpha', args: [] }), 'profile');
    assert.deepEqual(await shellEnv.collect(invocation('alpha')), {
      MAKA_PLUGIN_MARKER: 'profile',
    });
  } finally {
    await loader.close();
  }
});

function invocation(sessionId: string) {
  return {
    sessionId,
    turnId: 'turn',
    cwd: '/workspace',
    abortSignal: new AbortController().signal,
  };
}

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
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { test } from 'node:test';
import { createServer } from 'vite';
import { workspacePackagesPlugin } from '../vite-workspace-packages.ts';

test('renderer loads a newly exported workspace module after its manifest changes', async (t) => {
  const repoRoot = await realpath(await mkdtemp(join(tmpdir(), 'maka-workspace-exports-')));
  let server;
  t.after(async () => {
    await server?.close();
    await rm(repoRoot, { recursive: true, force: true });
  });
  const root = join(repoRoot, 'apps/desktop/src/renderer');
  const core = join(repoRoot, 'packages/core');
  await mkdir(root, { recursive: true });
  await mkdir(join(core, 'dist'), { recursive: true });
  await mkdir(join(repoRoot, 'node_modules/@maka'), { recursive: true });
  await symlink(core, join(repoRoot, 'node_modules/@maka/core'), 'junction');
  await writeFile(join(repoRoot, 'package.json'), JSON.stringify({ workspaces: ['packages/core'] }));
  const manifest = { name: '@maka/core', type: 'module', exports: { './session': './dist/session.js' } };
  await writeFile(join(core, 'package.json'), JSON.stringify(manifest));
  await writeFile(join(core, 'dist/session.js'), 'export const session = 1;');
  await writeFile(join(root, 'entry.js'), "export { session } from '@maka/core/session';");

  server = await createServer({
    configFile: false,
    root,
    logLevel: 'silent',
    server: { host: '127.0.0.1', port: 0 },
    optimizeDeps: { noDiscovery: true, include: [] },
    plugins: [workspacePackagesPlugin(repoRoot)],
  });
  await server.listen();
  const url = server.resolvedUrls.local[0];
  assert.equal((await fetch(`${url}entry.js`)).status, 200);

  // The workspace build has emitted the new module before the manifest changes.
  await writeFile(join(core, 'dist/workhub-session-resolver.js'), 'export const resolver = 2;');
  manifest.exports['./workhub-session-resolver'] = './dist/workhub-session-resolver.js';
  await writeFile(join(core, 'package.json'), JSON.stringify(manifest));
  await writeFile(join(root, 'entry.js'), "export { resolver } from '@maka/core/workhub-session-resolver';");

  let failure;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}entry.js`);
      const body = await response.text();
      assert.equal(response.status, 200, body);
      assert.match(body, /\/packages\/core\/dist\/workhub-session-resolver\.js/);
      return;
    } catch (error) {
      failure = error;
      await setTimeout(50);
    }
  }
  throw failure;
});

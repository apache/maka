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
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { build, resolveConfig } from 'vite';

// Exercise the actual Desktop resolution graph: isolated Slot unit tests cannot
// detect two React Context instances created by source/dist entry-point mixing.
test('built Desktop public UI and Client Plugin entries share their Slot provider', async () => {
  const desktop = resolve(import.meta.dirname, '..');
  const cache = join(desktop, '../../node_modules/.cache');
  await mkdir(cache, { recursive: true });
  const root = await mkdtemp(join(cache, 'client-slots-'));
  try {
    const entry = join(root, 'entry.jsx');
    await writeFile(entry, `
      import React from 'react';
      import { renderToStaticMarkup } from 'react-dom/server';
      import { MakaClientSlotOutlet as NativeOutlet } from '@maka/ui';
      import { MakaClientSlotOutlet as PublicOutlet } from '@maka/ui/client-plugin';
      import { MakaClientRoot, MakaClientRootOutlet } from '@maka/ui/client-plugin-runtime';
      const root = new MakaClientRoot();
      root.snapshot().slots.register({ name: 'sidebar.footer', id: 'fixture' }, () => React.createElement('b', null, 'plugin-visible'));
      export const sameOutlet = NativeOutlet === PublicOutlet;
      export const rendered = renderToStaticMarkup(React.createElement(MakaClientRootOutlet, {root}, React.createElement(NativeOutlet, {name:'sidebar.footer',owner:{collapsed:false}})));
    `);
    const config = await resolveConfig({ configFile: join(desktop, 'vite.config.ts') }, 'build');
    await build({
      configFile: false, root, logLevel: 'error', resolve: { alias: config.resolve.alias, dedupe: config.resolve.dedupe },
      ssr: { noExternal: ['@maka/ui'] },
      build: { ssr: entry, outDir: join(root, 'out'), minify: false, rolldownOptions: { output: { entryFileNames: 'entry.mjs' } } },
    });
    const result = await import(pathToFileURL(join(root, 'out/entry.mjs')).href);
    assert.equal(result.sameOutlet, true, 'native and SDK Slot outlets must be the same module');
    assert.match(result.rendered, /plugin-visible/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

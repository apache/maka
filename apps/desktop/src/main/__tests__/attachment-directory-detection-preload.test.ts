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
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { MAX_ATTACHMENT_DROP_COUNT } from '@maka/core/attachments';
import { build } from 'esbuild';
import type { MakaBridge } from '../../preload/bridge-contract.js';

// Any renderer code can call the exposed bridge with a list of any length. The
// composer never asks about more files than one drop may carry (#5279), so a
// longer list is refused before a single path is read or main is asked.

const dropped = (count: number) =>
  Array.from({ length: count }, (_, index) => new File([], `file-${index}.txt`));

test('a list longer than one drop reads no path and never reaches main', async () => {
  const preload = await preloadHarness();
  await assert.rejects(
    preload.bridge.attachments.detectDirectories(dropped(MAX_ATTACHMENT_DROP_COUNT + 1)),
    /Too many files to check for folders/,
  );
  assert.equal(preload.pathsRead(), 0);
  assert.deepEqual(preload.requests, []);
});

test('the largest drop is checked in one request main accepts', async () => {
  const preload = await preloadHarness();
  const answer = await preload.bridge.attachments.detectDirectories(dropped(MAX_ATTACHMENT_DROP_COUNT));
  assert.equal(answer.length, MAX_ATTACHMENT_DROP_COUNT);
  assert.equal(preload.pathsRead(), MAX_ATTACHMENT_DROP_COUNT);
  assert.deepEqual(preload.requests, [MAX_ATTACHMENT_DROP_COUNT]);
});

async function preloadHarness() {
  const requests: number[] = [];
  let pathsRead = 0;
  const ipcRenderer = {
    on() {}, off() {}, send() {},
    async invoke(channel: string, ...args: unknown[]) {
      if (channel === 'app:bootstrapReady') return undefined;
      if (channel !== 'attachments:detectDirectories') throw new Error('Unexpected channel: ' + channel);
      const paths = args[0] as readonly string[];
      requests.push(paths.length);
      return paths.map(() => false);
    },
  };
  let bridge: MakaBridge | undefined;
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL('../../../src/preload/preload.ts', import.meta.url))],
    bundle: true, write: false, platform: 'node', format: 'cjs', external: ['electron'],
  });
  const require = createRequire(import.meta.url);
  runInNewContext(bundle.outputFiles[0]!.text, {
    require: (id: string) => id === 'electron' ? {
      ipcRenderer,
      webUtils: { getPathForFile: (file: File) => { pathsRead += 1; return `/dropped/${file.name}`; } },
      contextBridge: { exposeInMainWorld: (name: string, value: MakaBridge) => {
        if (name === 'maka') bridge = value;
      } },
    } : require(id),
    process: { env: {} }, Buffer, console, setTimeout, clearTimeout, TextEncoder, TextDecoder,
    crypto: globalThis.crypto,
  });
  assert.ok(bridge);
  return { bridge, requests, pathsRead: () => pathsRead };
}

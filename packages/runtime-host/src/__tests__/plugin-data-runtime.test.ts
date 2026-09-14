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
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { HostPluginDataRuntime } from '../server/plugin-data-runtime.js';

const namespace = Object.freeze({ extensionId: 'fixture.extension', scopeId: 'session:test' });

test('Plugin data persists CAS mutations and seals credentials at rest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-plugin-data-'));
  try {
    const runtime = new HostPluginDataRuntime(root);
    assert.deepEqual(await runtime.read(namespace, 'settings', 'mode'), {
      revision: 0,
      value: undefined,
    });
    assert.deepEqual(
      await runtime.mutate(namespace, 'settings', [
        { key: 'mode', value: 'strict', expectedRevision: 0 },
      ]),
      {
        mode: { revision: 1, value: 'strict' },
      },
    );
    await assert.rejects(
      runtime.mutate(namespace, 'settings', [{ key: 'mode', value: 'loose', expectedRevision: 0 }]),
      /revision conflict/u,
    );
    await runtime.mutate(namespace, 'storage', [
      { key: 'state/count', value: 1 },
      { key: 'state/name', value: 'fixture' },
    ]);
    await runtime.commitCredential(namespace, 'token', 'never-plaintext', { provider: 'fixture' });

    const restarted = new HostPluginDataRuntime(root);
    assert.deepEqual(await restarted.read(namespace, 'settings', 'mode'), {
      revision: 1,
      value: 'strict',
    });
    assert.deepEqual(Object.keys(await restarted.list(namespace, 'storage', 'state/')), [
      'state/count',
      'state/name',
    ]);
    assert.equal(
      await restarted.useCredential(namespace, 'token', (secret) => secret),
      'never-plaintext',
    );

    const files = await findJson(root);
    const disk = (await Promise.all(files.map((path) => readFile(path, 'utf8')))).join('\n');
    assert.equal(disk.includes('never-plaintext'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function findJson(root: string): Promise<string[]> {
  const { readdir } = await import('node:fs/promises');
  const output: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.name.endsWith('.json')) output.push(path);
    }
  };
  await visit(root);
  return output;
}

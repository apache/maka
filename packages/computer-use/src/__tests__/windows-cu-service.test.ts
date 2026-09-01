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
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WindowsCuLifecycleError, WindowsCuService } from '../windows-cu-service.js';

test('Windows supervisor performs private initialize handshake and forwards requests', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('cmd fixture requires Windows');
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), 'maka-windows-cu-service-'));
  try {
    const script = join(directory, 'helper.mjs');
    await writeFile(
      script,
      `import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => { const m = JSON.parse(line); if (m.method === 'initialize') console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocol:'maka.cu.windows/0',generation:'fixture',capabilities:{observation:{uia:true},capture:{targetWindowWgc:true}}}})); else if (m.method === 'list_windows') console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{windows:[]}})); });\n`,
      'utf8',
    );
    const hash = createHash('sha256')
      .update(await readFile(process.execPath))
      .digest('hex');
    const service = new WindowsCuService({
      binaryPath: process.execPath,
      childArgs: [script],
      expectedBinarySha256: hash,
      maxRestartAttempts: 1,
    });
    const handshake = await service.ensureStarted();
    assert.equal(handshake.protocol, 'maka.cu.windows/0');
    assert.deepEqual(await service.call('list_windows', {}), { windows: [] });
    service.dispose();
    assert.equal(service.snapshot().state, 'disposed');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Windows supervisor rejects a manifest hash mismatch before spawning', async () => {
  const service = new WindowsCuService({
    binaryPath: process.execPath,
    expectedBinarySha256: '0'.repeat(64),
    maxRestartAttempts: 1,
  });
  await assert.rejects(
    () => service.ensureStarted(),
    (error: unknown) =>
      error instanceof WindowsCuLifecycleError && error.code === 'service_mismatch',
  );
});

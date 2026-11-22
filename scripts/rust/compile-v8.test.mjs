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
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { locateGnOut } from './compile-v8.mjs';

test('locateGnOut resolves both legacy release/gn_out and Cargo 1.100+ release/build/gn_out', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-compile-v8-'));
  try {
    const legacy = join(root, 'legacy');
    await mkdir(join(legacy, 'gn_out', 'obj'), { recursive: true });
    await writeFile(join(legacy, 'gn_out', 'obj', 'librusty_v8.a'), 'archive');
    assert.equal(await locateGnOut(legacy, 'librusty_v8.a'), join(legacy, 'gn_out'));

    const cargo1100 = join(root, 'cargo1100');
    await mkdir(join(cargo1100, 'build', 'gn_out', 'obj'), { recursive: true });
    await writeFile(join(cargo1100, 'build', 'gn_out', 'obj', 'rusty_v8.lib'), 'archive');
    assert.equal(await locateGnOut(cargo1100, 'rusty_v8.lib'), join(cargo1100, 'build', 'gn_out'));

    const missing = join(root, 'missing');
    await mkdir(missing, { recursive: true });
    await assert.rejects(
      () => locateGnOut(missing, 'librusty_v8.a'),
      /Built V8 archive \(librusty_v8\.a\) not found/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

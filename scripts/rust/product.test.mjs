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
import { productTests } from './product.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'maka-product-selection-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'products/maka/bundle/tests');
  await mkdir(directory, { recursive: true });
  return { root, directory };
}

test('an empty product selection fails instead of discovering the whole repository', async (t) => {
  const { root, directory } = await fixture(t);
  await writeFile(join(directory, 'README.md'), 'Not a test module.');
  await assert.rejects(
    productTests(root),
    /No product tests found in products\/maka\/bundle\/tests/,
  );
});

test('product tests are explicit sorted modules rather than ambient Node discovery', async (t) => {
  const { root, directory } = await fixture(t);
  for (const name of ['z.test.mjs', 'a.test.mjs', 'helper.mjs', 'unrelated.test.ts']) {
    await writeFile(join(directory, name), '');
  }
  assert.deepEqual(await productTests(root), [
    join('products/maka/bundle/tests', 'a.test.mjs'),
    join('products/maka/bundle/tests', 'z.test.mjs'),
  ]);
});

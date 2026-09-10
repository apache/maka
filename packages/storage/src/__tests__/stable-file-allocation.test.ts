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
import { appendFile, mkdtemp, open, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readStableBoundedFile } from '../stable-storage.js';

test('stable reads size their allocation to the admitted file and preserve race rejection', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-stable-allocation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'record');
  const invalid = new Error('invalid snapshot');
  const invalidFile = () => invalid;
  const allocations: Array<{ size: number; expected: number }> = [];
  let closes = 0;
  for (const size of [0, 1, 4095, 4096, 262144]) {
    const contents = Buffer.alloc(size, 0x61);
    await writeFile(path, contents);
    const result = await readStableBoundedFile(
      { path, maxBytes: 262144, invalidFile },
      {
        open: async (name, flags) => {
          const handle = await open(name, flags);
          let recorded = false;
          return {
            stat: (options) => handle.stat(options),
            read: async (buffer, offset, length, position) => {
              if (!recorded) {
                recorded = true;
                allocations.push({ size: buffer.byteLength, expected: size + 1 });
              }
              // Exercise partial reads without changing the real filesystem.
              return handle.read(buffer, offset, Math.min(length ?? 0, 997), position);
            },
            close: async () => {
              closes += 1;
              await handle.close();
            },
          };
        },
      },
    );
    assert.deepEqual(result, contents);
  }
  assert.equal(closes, 5);
  await writeFile(path, '');
  assert.equal((await readStableBoundedFile({ path, maxBytes: 0, invalidFile })).length, 0);

  for (const mutation of ['grow', 'shrink', 'grow-then-shrink', 'read-error'] as const) {
    await writeFile(path, 'data');
    let mutated = false;
    let closed = false;
    await assert.rejects(
      readStableBoundedFile(
        { path, maxBytes: 262144, invalidFile },
        {
          open: async (name, flags) => {
            const handle = await open(name, flags);
            return {
              stat: (options) => handle.stat(options),
              read: async (buffer, offset, length, position) => {
                if (!mutated) {
                  mutated = true;
                  if (mutation === 'read-error') throw invalid;
                  if (mutation === 'shrink') await truncate(path, 2);
                  else await appendFile(path, 'extra bytes within the admission limit');
                  const result = await handle.read(buffer, offset, length, position);
                  if (mutation === 'grow-then-shrink') await truncate(path, 4);
                  return result;
                }
                return handle.read(buffer, offset, length, position);
              },
              close: async () => {
                closed = true;
                await handle.close();
              },
            };
          },
        },
      ),
      (error: unknown) => error === invalid,
    );
    assert.equal(closed, true);
  }
  await writeFile(path, 'oversized');
  await assert.rejects(
    readStableBoundedFile({ path, maxBytes: 4, invalidFile }),
    (error: unknown) => error === invalid,
  );
  for (const maxBytes of [-1, 1.5, NaN, Infinity]) {
    await assert.rejects(readStableBoundedFile({ path, maxBytes, invalidFile }), RangeError);
  }
  // All byte-content, race, and close assertions run before the allocation oracle.
  assert.deepEqual(
    allocations.map(({ size }) => size),
    allocations.map(({ expected }) => expected),
  );
});

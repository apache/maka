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
import { mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { readStableTarget } from '../file-stable-read.js';

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('fd-pinned exact read primitive', () => {
  test('reads text windows through the descriptor validated at admission', async () => {
    const cwd = await temporaryDirectory();
    const target = join(cwd, 'file.txt');
    await writeFile(target, 'zero\none\ntwo\nthree', 'utf8');

    assert.deepEqual(
      await readStableTarget({
        path: target,
        expectedIdentity: await identity(target),
        offset: 1,
        limit: 2,
      }),
      { content: 'one\ntwo' },
    );
  });

  test('rejects a replacement inode and never returns its content', async () => {
    const cwd = await temporaryDirectory();
    const target = join(cwd, 'file.txt');
    const replacement = join(cwd, 'replacement.txt');
    await writeFile(target, 'original', 'utf8');
    await writeFile(replacement, 'replacement', 'utf8');
    const admitted = await identity(target);
    await rename(replacement, target);

    await assert.rejects(readStableTarget({ path: target, expectedIdentity: admitted }), {
      code: 'path_changed',
    });
    assert.equal(await readFile(target, 'utf8'), 'replacement');
  });

  test('rejects a target that appeared after a missing admission observation', async () => {
    const cwd = await temporaryDirectory();
    const target = join(cwd, 'file.txt');
    await writeFile(target, 'interloper', 'utf8');

    await assert.rejects(readStableTarget({ path: target, expectedIdentity: 'missing' }), {
      code: 'path_changed',
    });
  });
});

async function temporaryDirectory(): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'maka-stable-read-')));
  cleanup.push(path);
  return path;
}

async function identity(path: string): Promise<{ dev: string; ino: string }> {
  const metadata = await stat(path, { bigint: true });
  return { dev: String(metadata.dev), ino: String(metadata.ino) };
}

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
import { appendFile, lstat, mkdtemp, open, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readStableBoundedFile } from '../stable-storage.js';

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'maka-stable-file-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'record.json');
  await writeFile(path, 'data');
  return { directory, path };
}

function invalidFile(): Error {
  return new Error('invalid stable file');
}

test('reads one bounded regular-file snapshot and rejects in-place growth', async (t) => {
  const { path } = await fixture(t);
  assert.equal(
    (await readStableBoundedFile({ path, maxBytes: 4, invalidFile })).toString('utf8'),
    'data',
  );
  await assert.rejects(
    readStableBoundedFile(
      { path, maxBytes: 4, invalidFile },
      {
        open: async (openedPath, flags) => {
          const handle = await open(openedPath, flags);
          let firstRead = true;
          return {
            stat: (options) => handle.stat(options),
            read: async (buffer, offset, length, position) => {
              if (firstRead) {
                firstRead = false;
                await appendFile(path, '!');
              }
              return handle.read(buffer, offset, length, position);
            },
            close: () => handle.close(),
          };
        },
      },
    ),
    /invalid stable file/u,
  );
});

test('rejects a symlink instead of following it', {
  skip: process.platform === 'win32' ? 'POSIX no-follow semantics are required' : false,
}, async (t) => {
  const { directory, path } = await fixture(t);
  const link = join(directory, 'record-link.json');
  await symlink(path, link);
  await assert.rejects(
    readStableBoundedFile({ path: link, maxBytes: 4, invalidFile }),
    /invalid stable file/u,
  );
});

test('rejects a pathname replaced after opening the file', async (t) => {
  const { directory, path } = await fixture(t);
  const replacement = join(directory, 'replacement.json');
  await writeFile(replacement, 'next');
  let observations = 0;

  await assert.rejects(
    readStableBoundedFile(
      { path, maxBytes: 4, invalidFile },
      {
        lstat: async (observedPath, options) => {
          observations += 1;
          if (observations === 2) await rename(replacement, path);
          return lstat(observedPath, options);
        },
      },
    ),
    /invalid stable file/u,
  );
});

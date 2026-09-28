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
import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { execGitBytes, execGitText } from '../git-exec.js';

const execFileAsync = promisify(execFile);

test('Git execution ignores ambient repository variables for text and byte output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-git-exec-'));
  const repository = join(root, 'repository');
  await execFileAsync('git', ['init', '--quiet', repository]);

  const keys = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE'] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    process.env.GIT_DIR = join(root, 'wrong-git-dir');
    process.env.GIT_WORK_TREE = join(root, 'wrong-work-tree');
    process.env.GIT_COMMON_DIR = join(root, 'wrong-common-dir');
    process.env.GIT_INDEX_FILE = join(root, 'wrong-index');

    const expected = await realpath(repository);
    const text = await execGitText(repository, ['rev-parse', '--show-toplevel']);
    const bytes = await execGitBytes(repository, ['rev-parse', '--show-toplevel']);

    assert.equal(text.trim(), expected);
    assert.equal(new TextDecoder().decode(bytes).trim(), expected);
  } finally {
    for (const key of keys) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});

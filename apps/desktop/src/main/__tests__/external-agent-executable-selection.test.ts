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
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { OpenDialogOptions } from 'electron';
import { selectAntigravityExecutable } from '../external-agent-executable-selection.js';

async function programFixture() {
  const root = await mkdtemp(join(tmpdir(), 'maka-antigravity-selection-'));
  const executable = join(root, 'agy_acp_server.par');
  const helper = join(root, 'localharness_external');
  await writeFile(executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  await writeFile(helper, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  return { root, executable, helper };
}

for (const selection of ['directory', 'executable'] as const) {
  test(`macOS accepts the ${selection} and returns the verified executable`, async () => {
    const fixture = await programFixture();
    try {
      const resolved = await selectAntigravityExecutable(async (options) => {
        assert.deepEqual(options.properties, ['openFile', 'openDirectory']);
        return { canceled: false, filePaths: [selection === 'directory' ? fixture.root : fixture.executable] };
      }, 'darwin');
      assert.equal(resolved, await realpath(fixture.executable));
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
}

for (const invalid of ['missing selection', 'missing executable', 'missing helper', 'executable directory', 'helper directory', 'non-executable server', 'non-executable helper'] as const) {
  test(`macOS rejects ${invalid} before returning a path to save`, {
    // Windows ignores POSIX execute bits; missing-file and file-type cases still run there.
    skip: process.platform === 'win32' && invalid.startsWith('non-executable'),
  }, async () => {
    const fixture = await programFixture();
    try {
      let selected = fixture.root;
      let failure = 'executable_unavailable';
      if (invalid === 'missing selection') selected = join(fixture.root, 'missing');
      if (invalid === 'missing executable' || invalid === 'executable directory') {
        await rm(fixture.executable);
        if (invalid === 'executable directory') await mkdir(fixture.executable);
      }
      if (invalid === 'missing helper' || invalid === 'helper directory') {
        await rm(fixture.helper);
        if (invalid === 'helper directory') await mkdir(fixture.helper);
        failure = 'helper_unavailable';
      }
      if (invalid === 'non-executable server') await chmod(fixture.executable, 0o600);
      if (invalid === 'non-executable helper') {
        await chmod(fixture.helper, 0o600);
        failure = 'helper_unavailable';
      }
      await assert.rejects(selectAntigravityExecutable(async () => ({ canceled: false, filePaths: [selected] }), 'darwin'), { failure });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
}

test('cancelling the picker does not inspect or return a selected path', async () => {
  assert.equal(await selectAntigravityExecutable(async () => ({ canceled: true, filePaths: ['/missing'] }), 'darwin'), undefined);
  assert.equal(await selectAntigravityExecutable(async () => ({ canceled: false, filePaths: [] }), 'darwin'), undefined);
});

test('other platforms retain file-only selection', async () => {
  let options: OpenDialogOptions | undefined;
  const selected = await selectAntigravityExecutable(async (input) => {
    options = input;
    return { canceled: false, filePaths: ['/chosen/agent.exe'] };
  }, 'win32');
  assert.deepEqual(options?.properties, ['openFile']);
  assert.equal(selected, '/chosen/agent.exe');
});

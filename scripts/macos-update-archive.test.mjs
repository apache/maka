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
import { mkdir, mkdtemp, readlink, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { archive } from 'app-builder-lib/out/targets/archive.js';

// electron-builder 26.16 moved macOS ZIPs from the system zip to 7za, where
// the patch that keeps Windows ZIPs reproducible also drops every
// modification time. The patch keeps the macOS update archive on the system
// zip, as the releases already shipped were built.
test('the macOS update ZIP keeps bundle symlinks and modification times', {
  skip: process.platform !== 'darwin' && 'the macOS update ZIP is built on macOS',
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-macos-archive-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = join(root, 'Maka.app');
  const versions = join(app, 'Contents', 'Frameworks', 'Fixture.framework', 'Versions');
  await mkdir(join(versions, 'A'), { recursive: true });
  await symlink('A', join(versions, 'Current'));
  const binary = join(versions, 'A', 'Fixture');
  await writeFile(binary, '#!/bin/sh\n');
  const modified = new Date('2024-01-01T00:00:00Z');
  await utimes(binary, modified, modified);

  const zip = join(root, 'Maka.zip');
  // What ArchiveTarget passes for a macOS `zip` target.
  await archive('zip', zip, app, { withoutDir: false, preserveSymlinks: true });
  // Squirrel.Mac and verify-macos-autoupdate both unpack with ditto.
  const out = join(root, 'out');
  await promisify(execFile)('ditto', ['-x', '-k', zip, out]);

  const extracted = join(out, 'Maka.app', 'Contents', 'Frameworks', 'Fixture.framework');
  assert.equal(await readlink(join(extracted, 'Versions', 'Current')), 'A');
  const unpacked = await stat(join(extracted, 'Versions', 'A', 'Fixture'));
  assert.equal(unpacked.mtime.toISOString(), modified.toISOString());
});

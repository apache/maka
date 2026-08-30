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
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

test('direct script guards encode entrypoint paths with spaces', async () => {
  const entrypointPath = join(tmpdir(), 'Maka Project', 'script.mjs');
  assert.match(pathToFileURL(entrypointPath).href, /Maka%20Project/);
  assert.notEqual(pathToFileURL(entrypointPath).href, `file://${entrypointPath}`);

  for (const script of ['build-cursor-overlay.mjs', 'prepare-deepseek-harness-toolchain.mjs']) {
    const source = await readFile(new URL(script, import.meta.url), 'utf8');
    assert.match(
      source,
      /process\.argv\[1\] && import\.meta\.url === pathToFileURL\(process\.argv\[1\]\)\.href/,
      `${script} must compare encoded file URLs`,
    );
  }
});

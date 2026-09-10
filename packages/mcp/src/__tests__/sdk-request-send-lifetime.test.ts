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
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { probe } from './sdk-request-send-lifetime-probe.js';

for (const format of ['esm', 'cjs'] as const) {
  for (const mode of ['semantics', 'gc'] as const) {
    test(`MCP SDK ${format} pending send ${mode}`, () => {
      const child = spawnSync(
        process.execPath,
        [
          '--expose-gc',
          '--input-type=module',
          '--eval',
          `await (${probe.toString()})('${format}', '${mode}')`,
        ],
        {
          cwd: fileURLToPath(new URL('../../../../', import.meta.url)),
          env: {
            ...process.env,
            ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
          },
          encoding: 'utf8',
          timeout: 30_000,
        },
      );
      assert.ifError(child.error);
      assert.equal(child.status, 0, child.stderr || child.stdout);
      assert.match(child.stdout, /pending sends verified/);
    });
  }
}

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

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { readdirSync } from 'node:fs';
const root = fileURLToPath(new URL('../', import.meta.url));
const run = (args, cwd) => {
  const result = spawnSync(process.execPath, args, { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
};
for (const name of ['memory-network', 'index-initiative', 'proactive-matters']) {
  const cwd = join(root, 'test/assistant', name);
  run(['scripts/main-api.mjs'], cwd);
  if (name === 'proactive-matters') {
    run(['scripts/prepare-test-metadata.mjs'], cwd);
    run(['scripts/runtime-test-api.mjs'], cwd);
  }
  run(
    [
      '--import',
      join(root, 'scripts/assistant-test-loader.mjs'),
      '--test',
      '--test-concurrency=1',
      ...readdirSync(join(cwd, 'test'))
        .filter((x) => x.endsWith('.test.ts'))
        .map((x) => 'test/' + x),
    ],
    cwd,
  );
}

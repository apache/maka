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

import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildClient } from '../../packages/plugin-sdk/src/build.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const dependencies = process.env.MAKA_JS_DEPS || root;
const require = createRequire(resolve(dependencies, 'package.json'));
const lock = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8'));
if (require('esbuild/package.json').version !== lock.packages['node_modules/esbuild'].version)
  throw new Error('Client compiler does not match the repository lockfile');
for (const [name, entryPoint] of [
  ['agent-graph', 'crates/graph/src/client.tsx'],
  ['skills', 'crates/skills/src/client.tsx'],
  ['jev', 'crates/jev/src/client.tsx'],
  ['external-agent', 'crates/external-agent/src/client.tsx'],
  ['session-recap', 'crates/session-recap/src/client.tsx'],
  ['goal', 'crates/goal/src/client.tsx'],
  ['web', 'crates/web/src/client.tsx'],
  ['insights', 'crates/insights/src/client.tsx'],
  ['session-import', 'crates/session-import/src/client.tsx'],
  ['todo', 'crates/assistant/src/todo/client.tsx'],
  ['scheduler', 'crates/scheduler/src/client.tsx'],
  ['workhub', 'packages/workhub/src/client.tsx'],
]) {
  const source = await buildClient(
    {
      packageId: `maka.${name}`,
      entryPoint: resolve(root, entryPoint),
    },
    require('esbuild').build,
  );
  writeFileSync(resolve(process.argv[2], `${name}-client.js`), source);
}

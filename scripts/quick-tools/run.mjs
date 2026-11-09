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
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { stageDesktopBundle } from '../rust/build-cli.mjs';
const { values } = parseArgs({ options: { root: { type: 'string' } } });
const repo = resolve(import.meta.dirname, '../..');
const helper = resolve(repo, 'target/quick-tools/maka-quick-native');
const executable = resolve(repo, 'target/debug/maka');
const shell = resolve(repo, 'target/debug/maka-desktop-shell');
if (
  !existsSync(executable) ||
  !existsSync(shell) ||
  (process.platform === 'darwin' &&
    (!existsSync(helper) || !existsSync(resolve(repo, 'target/debug/maka-host-shell'))))
) {
  throw Error(
    'Build first: cargo build --locked -p maka-cli -p maka-desktop-shell -p maka-host-shell && node scripts/quick-tools/build-native.mjs',
  );
}
if (process.platform === 'darwin') {
  await stageDesktopBundle(repo, shell, resolve(repo, 'target/debug/Maka.app'));
}
const result = spawnSync(
  executable,
  ['desktop', '--root', resolve(values.root ?? resolve(homedir(), '.maka/quick-tools-rust'))],
  {
    cwd: repo,
    stdio: 'inherit',
    env: {
      ...process.env,
      MAKA_QUICK_NATIVE: helper,
      MAKA_QUICK_WEB_NODE: process.execPath,
      MAKA_QUICK_WEB_ENTRY: resolve(repo, 'node_modules/@jackwener/browsermcp/dist/src/main.js'),
    },
  },
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);

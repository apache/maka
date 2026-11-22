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
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { rustTarget } from './build-cli.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const target = rustTarget();
function dependencies(native) {
  const tree = execFileSync(
    'cargo',
    [
      'tree',
      '--locked',
      '-p',
      'maka-cli',
      '--target',
      target,
      '--edges',
      'normal,build',
      '--prefix',
      'none',
      '--format',
      '{p}',
      ...(native ? [] : ['--no-default-features']),
    ],
    { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
  );
  return new Set(tree.split('\n').map((line) => line.split(' ')[0]));
}

const bridge = dependencies(false);
assert(bridge.has('maka-computer-use'), 'bridge build must retain Computer Use');
for (const name of [
  'cua-driver-sdk',
  'platform-linux',
  'platform-macos',
  'platform-windows',
  'x11',
])
  assert(!bridge.has(name), `bridge build must not compile native desktop dependency: ${name}`);

const native = dependencies(true);
assert(native.has('cua-driver-sdk'), 'default CLI build must retain the native SDK');
const platform = { linux: 'platform-linux', darwin: 'platform-macos', win32: 'platform-windows' }[
  process.platform
];
assert(native.has(platform), `default CLI build must retain ${platform}`);
if (process.platform === 'linux') assert(native.has('x11'), 'native Linux must retain X11');
console.log(`Computer Use bridge and native dependency boundaries verified for ${target}`);

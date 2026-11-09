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

import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
const root = resolve(import.meta.dirname, '../..');
const out = resolve(root, 'target/quick-tools');
mkdirSync(out, { recursive: true });
if (process.platform === 'darwin') {
  execFileSync(
    'swiftc',
    [
      '-O',
      resolve(root, 'plugins/application/quick-tools/native/macos.swift'),
      '-o',
      resolve(out, 'maka-quick-native'),
    ],
    { stdio: 'inherit' },
  );
  execFileSync('codesign', ['--force', '--sign', '-', resolve(out, 'maka-quick-native')], {
    stdio: 'inherit',
  });
}

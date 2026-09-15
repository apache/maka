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
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function buildNotificationSettings() {
  if (process.platform !== 'darwin') return;
  const require = createRequire(import.meta.url);
  const desktop = fileURLToPath(new URL('..', import.meta.url));
  const include = join(dirname(require.resolve('node-api-headers/package.json')), 'include');
  const output = join(desktop, 'dist', 'native');
  mkdirSync(output, { recursive: true });
  const result = spawnSync('xcrun', [
    'clang++', '-std=c++17', '-fobjc-arc', '-fblocks',
    '-DNAPI_VERSION=8', '-mmacosx-version-min=12.0',
    '-arch', process.arch === 'arm64' ? 'arm64' : 'x86_64',
    '-bundle', '-undefined', 'dynamic_lookup',
    '-framework', 'Foundation', '-framework', 'UserNotifications',
    '-I', include,
    join(desktop, 'native', 'notification-settings.mm'),
    '-o', join(output, 'notification-settings.node'),
  ], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('Failed to build macOS notification settings bridge');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) buildNotificationSettings();

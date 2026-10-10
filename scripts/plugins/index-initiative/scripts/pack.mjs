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

import { mkdir, copyFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { exportExtensionBundle } from '../.artifacts/main-api.mjs';
const stage = resolve('release/package');
await rm(stage, { recursive: true, force: true });
await mkdir(stage + '/dist', { recursive: true });
for (const file of [
  'maka.extension.json',
  'maka.composition.json',
  'README.md',
  'TEST-REPORT.md',
  'PROVENANCE.md',
  'dist/host.mjs',
  'dist/client.js',
])
  await copyFile(file, stage + '/' + file);
for (const name of ['LICENSE', 'NOTICE'])
  await copyFile(resolve('../../..', name), stage + '/' + name);
await copyFile('node_modules/zod/LICENSE', stage + '/THIRD-PARTY-LICENSES.txt');
const target = resolve('release/index-initiative.maka-extension');
await rm(target, { force: true });
await exportExtensionBundle(stage, target);

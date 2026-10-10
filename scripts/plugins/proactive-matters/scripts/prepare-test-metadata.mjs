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
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const pluginDirectory = resolve(scriptDirectory, '..');
const repositoryDirectory = resolve(pluginDirectory, '../../..');
const artifactDirectory = join(pluginDirectory, '.artifacts');
await mkdir(artifactDirectory, { recursive: true });

const result = spawnSync(
  process.execPath,
  [
    join(repositoryDirectory, 'scripts/sync-model-metadata.mjs'),
    '--output',
    join(artifactDirectory, 'model-metadata.generated.ts'),
    '--pricing-output',
    join(artifactDirectory, 'model-pricing.generated.ts'),
  ],
  { cwd: repositoryDirectory, stdio: 'inherit' },
);
if (result.error) throw result.error;
if (result.status !== 0) process.exitCode = result.status ?? 1;

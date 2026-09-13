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

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '..');
const sourcePath = resolve(repoRoot, 'apps/desktop/src/renderer/public/THIRD_PARTY_LICENSES.txt');
const artifactPath = resolve(repoRoot, 'apps/desktop/dist-renderer/THIRD_PARTY_LICENSES.txt');

const [source, artifact] = await Promise.all([readFile(sourcePath), readFile(artifactPath)]);
if (!source.equals(artifact)) {
  throw new Error(
    'dist-renderer/THIRD_PARTY_LICENSES.txt does not match the governed public source',
  );
}

console.log(
  '[third-party-notices] OK — renderer artifact contains the byte-identical public notice.',
);

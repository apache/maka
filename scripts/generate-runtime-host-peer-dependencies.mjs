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

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const manifestPath = join(repoRoot, 'native/runtime-host-peer/Cargo.toml');
const cargo = process.env.CARGO ?? 'cargo';
const output = execFileSync(
  cargo,
  [
    'deny',
    '--manifest-path',
    manifestPath,
    '--locked',
    '--exclude-dev',
    'list',
    '-f',
    'tsv',
    '-t',
    '0.6',
  ],
  { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
);
const outputPath = join(repoRoot, 'packages/cli/RUNTIME_HOST_PEER_DEPENDENCIES.rust.tsv');

if (process.argv.includes('--check')) {
  if (readFileSync(outputPath, 'utf8') !== output) {
    throw new Error(
      'Runtime Host peer dependency inventory is stale. Run npm run generate:runtime-host-peer-dependencies.',
    );
  }
} else {
  writeFileSync(outputPath, output);
}

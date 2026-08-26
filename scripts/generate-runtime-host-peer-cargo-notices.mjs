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

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateCargoNotices } from './cargo-notices.mjs';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const nativeRoot = join(repoRoot, 'native/runtime-host-peer');
generateCargoNotices({
  repoRoot,
  generatorPath: fileURLToPath(import.meta.url),
  manifestPath: join(nativeRoot, 'Cargo.toml'),
  lockPath: join(nativeRoot, 'Cargo.lock'),
  outputPath: join(repoRoot, 'packages/cli/RUNTIME_HOST_PEER_THIRD_PARTY_NOTICES.txt'),
  title: 'Maka Runtime Host direct-peer Cargo dependency notices',
  excludedPackages: new Set(['maka-runtime-host-peer']),
  requireLicenseFiles: false,
  deduplicateLicenseTexts: true,
  check: process.argv.includes('--check'),
  staleMessage:
    'Runtime Host peer Cargo dependency notices are stale. Run npm run generate:runtime-host-peer-cargo-notices.',
});

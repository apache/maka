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

import { readFileSync } from 'node:fs';
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
  dependencyEdges: ['normal'],
  resolveMissingLicenseText: (pkg) => declaredLicenseFallback(pkg, repoRoot),
  deduplicateLicenseTexts: true,
  check: process.argv.includes('--check'),
  staleMessage:
    'Runtime Host peer Cargo dependency notices are stale. Run npm run generate:runtime-host-peer-cargo-notices.',
});

function declaredLicenseFallback(pkg, root) {
  const note =
    'Upstream does not package a separate license file in this crate archive; the text below is resolved from its declared SPDX choice.';
  if (
    [
      'Apache-2.0 OR MIT',
      'MIT OR Apache-2.0',
      'MIT OR Apache-2.0 OR LGPL-2.1-or-later',
      'MIT/Apache-2.0',
    ].includes(pkg.license)
  ) {
    return {
      name: 'DECLARED-APACHE-2.0',
      content: readFileSync(join(root, 'LICENSE'), 'utf8'),
      selectedLicense: 'Apache-2.0',
      note,
    };
  }
  if (pkg.license === 'MIT') {
    const holders =
      pkg.authors.length > 0
        ? pkg.authors.map((author) => author.replace(/\s*<[^>]+>\s*$/u, '')).join(', ')
        : `contributors to ${pkg.repository ?? pkg.homepage ?? pkg.name}`;
    return {
      name: 'DECLARED-MIT',
      content: `MIT License

Copyright (c) ${holders}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`,
      selectedLicense: 'MIT',
      note,
    };
  }
  throw new Error(`${pkg.name}@${pkg.version}: declared license requires manual review`);
}

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
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const manifestPath = join(repoRoot, 'native/runtime-host-peer/Cargo.toml');
const lockPath = join(repoRoot, 'native/runtime-host-peer/Cargo.lock');
const inventoryPath = join(repoRoot, 'packages/cli/RUNTIME_HOST_PEER_DEPENDENCIES.rust.tsv');
const outputPath = join(repoRoot, 'packages/cli/RUNTIME_HOST_PEER_THIRD_PARTY_NOTICES.txt');
const check = process.argv.includes('--check');

const metadata = JSON.parse(
  execFileSync(
    process.env.CARGO ?? 'cargo',
    ['metadata', '--manifest-path', manifestPath, '--locked', '--format-version', '1'],
    { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  ),
);
const inventory = readFileSync(inventoryPath, 'utf8')
  .trimEnd()
  .split('\n')
  .slice(1)
  .map((line) => line.split('\t', 1)[0]);
const packagesByKey = new Map(metadata.packages.map((pkg) => [`${pkg.name}@${pkg.version}`, pkg]));
const apache2LicenseText = findPackagedApache2License(metadata.packages);

const licenseTexts = new Map();
const packageSections = inventory
  .filter((key) => key !== 'maka-runtime-host-peer@0.0.0')
  .map((key) => {
    const pkg = packagesByKey.get(key);
    if (!pkg) throw new Error(`${key}: dependency inventory is absent from Cargo metadata`);
    if (!pkg.license) throw new Error(`${key}: missing SPDX license metadata`);
    const directory = dirname(pkg.manifest_path);
    const licenseFiles = readdirSync(directory, { withFileTypes: true })
      .filter(
        (entry) => entry.isFile() && /^(licen[cs]e|copying|notice)(?:[._-].*)?$/iu.test(entry.name),
      )
      .map((entry) => entry.name)
      .sort();
    const source = pkg.repository ?? pkg.homepage ?? pkg.source ?? 'unknown';
    const notices =
      licenseFiles.length > 0
        ? licenseFiles.map((name) => ({
            name,
            text: normalizeLicenseText(readFileSync(join(directory, name), 'utf8')),
          }))
        : [declaredLicenseFallback(pkg, source)];
    const references = notices.map(({ name, text }) => {
      const digest = createHash('sha256').update(text).digest('hex');
      const existing = licenseTexts.get(digest);
      if (existing && existing.text !== text) throw new Error(`SHA-256 collision for ${key}`);
      const usage = `${key} (${name})`;
      if (existing) existing.usages.push(usage);
      else licenseTexts.set(digest, { text, usages: [usage] });
      return `${digest} (${name})`;
    });
    return [
      key,
      '-'.repeat(key.length),
      `SPDX license: ${pkg.license}`,
      `Source: ${source}`,
      ...references.map((reference) => `License text: ${reference}`),
    ].join('\n');
  });
const licenseSections = [...licenseTexts.entries()]
  .sort(([left], [right]) => left.localeCompare(right, 'en'))
  .map(([digest, { text, usages }]) =>
    [
      digest,
      '-'.repeat(digest.length),
      'Used by:',
      ...usages.sort().map((usage) => `- ${usage}`),
      '',
      text,
    ].join('\n'),
  );

function declaredLicenseFallback(pkg, source) {
  if (/Apache-2\.0/u.test(pkg.license)) {
    return {
      name: 'Apache-2.0.txt',
      text: apache2LicenseText,
    };
  }
  if (
    pkg.license
      .split(/\s+OR\s+/u)
      .some((alternative) => alternative.replaceAll(/[()]/gu, '').trim() === 'MIT')
  ) {
    const authors = pkg.authors.length > 0 ? pkg.authors.join(', ') : 'not included';
    return {
      name: 'MIT.txt',
      text: `Copyright notice: not included in the published crate
Cargo authors: ${authors}
Source: ${source}

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
    };
  }
  throw new Error(`${pkg.name}@${pkg.version}: packaged crate has no license or notice text`);
}

function findPackagedApache2License(packages) {
  for (const pkg of [...packages].sort((left, right) =>
    `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`, 'en'),
  )) {
    const directory = dirname(pkg.manifest_path);
    for (const name of readdirSync(directory).sort()) {
      if (!/^licen[cs]e-apache(?:[._-].*)?$/iu.test(name)) continue;
      const text = normalizeLicenseText(readFileSync(join(directory, name), 'utf8'));
      if (/Apache License\s+Version 2\.0/iu.test(text)) return text;
    }
  }
  throw new Error('Cargo dependency graph carries no Apache-2.0 license text');
}

function normalizeLicenseText(text) {
  return text
    .replace(/\r\n?/gu, '\n')
    .replace(/[ \t]+$/gmu, '')
    .trimEnd();
}

const output = `Maka Runtime Host peer Cargo dependency notices
==================================================

Generated by scripts/generate-runtime-host-peer-notices.mjs from the exact
four-target production dependency inventory. Do not edit this file by hand.

Manifest: ${relative(repoRoot, manifestPath).replaceAll('\\', '/')}
Cargo.lock SHA-256: ${createHash('sha256').update(readFileSync(lockPath)).digest('hex')}
Inventory SHA-256: ${createHash('sha256').update(readFileSync(inventoryPath)).digest('hex')}

Packages
--------

${packageSections.join('\n\n')}

License texts
-------------

${licenseSections.join('\n\n')}
`;

if (check) {
  if (readFileSync(outputPath, 'utf8') !== output) {
    throw new Error(
      'Runtime Host peer Cargo notices are stale. Run npm run generate:runtime-host-peer-notices.',
    );
  }
  console.log('[runtime-host-peer-notices] OK — Cargo notices are current.');
} else {
  writeFileSync(outputPath, output);
  console.log(`[runtime-host-peer-notices] wrote ${outputPath}`);
}

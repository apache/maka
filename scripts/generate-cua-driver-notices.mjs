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

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const licenseRoot = join(root, 'apps/desktop/resources/licenses/cua-driver');
const outputPath = join(licenseRoot, 'THIRD_PARTY_NOTICES.txt');
const inventory = readFileSync(join(root, 'docs/computer-use-cua-driver-dependencies.tsv'), 'utf8')
  .trimEnd()
  .split('\n')
  .slice(1)
  .map((line) => {
    const [name, version, license, targets, source] = line.split('\t');
    return { name, version, license, targets, source };
  });

const registry = readdirSync(join(homedir(), '.cargo/registry/src'))[0];
if (!registry) throw new Error('Cargo registry source cache is empty');
const registryRoot = join(homedir(), '.cargo/registry/src', registry);
const upstream = {
  'madsmtm/objc2': {
    '4fc083f1c6d6784577e38b0ee8dbd344481e2fd2': 'upstream/objc2-legacy-LICENSE.txt',
    e282618be4c3a3b9542957e0c8540e9588472ce8: 'upstream/objc2-legacy-LICENSE.txt',
    b4167b582b2f75f9a1be75495c41b765344fd03c: 'upstream/objc2-current-LICENSE.md',
    '8852b424193ca41602281b3d7540d7c8ed51e49a': 'upstream/objc2-current-LICENSE.md',
    '7b1abfd750a2cacaea71d6a56ecfb83cb7de560b': 'upstream/objc2-current-LICENSE.md',
    '8d214f5477365ffcbcbb7de058c86ed9a518efb7': 'upstream/objc2-current-LICENSE.md',
  },
  'mozilla/uniffi-rs': {
    '309762f55db3f0548194a9ceba3027fa64b18a93': 'MPL-2.0.txt',
  },
  'Nugine/simd': {
    d74c030d9dc4f3cae02146d1f497ff62726ef09a: 'upstream/simd-LICENSE',
  },
  'Stranger6667/jsonschema': {
    ecaeceac2340908a8fbf71404442296bd1536520: 'upstream/jsonschema-LICENSE',
  },
};

const hash = (value) => createHash('sha256').update(value).digest('hex');
const texts = new Map();
const entries = [];
for (const item of inventory) {
  if (item.source.includes('trycua/cua')) continue;
  const directory = join(registryRoot, `${item.name}-${item.version}`);
  if (!existsSync(directory)) throw new Error(`Cargo source missing: ${item.name}@${item.version}`);
  let licenses = readdirSync(directory)
    .filter((name) => /^(licen[cs]e|copying|notice)(?:[._-].*)?$/iu.test(name))
    .sort()
    .map((name) => ({ label: name, path: join(directory, name) }));
  if (licenses.length === 0) {
    const vcs = JSON.parse(readFileSync(join(directory, '.cargo_vcs_info.json'), 'utf8'));
    const repository = Object.keys(upstream).find((name) => item.source.includes(name));
    const source = upstream[repository]?.[vcs.git.sha1];
    if (!source) throw new Error(`Unreviewed license source: ${item.name}@${item.version}`);
    licenses = [
      {
        label: `${repository}@${vcs.git.sha1}/${source.split('/').at(-1)}`,
        path: join(licenseRoot, source),
      },
    ];
  }
  const references = licenses.map(({ label, path }) => {
    const body = readFileSync(path, 'utf8')
      .replace(/\r\n?/gu, '\n')
      .replace(/[\t ]+$/gmu, '')
      .trimEnd();
    const digest = hash(body);
    texts.set(digest, body);
    return `${label}: sha256:${digest}`;
  });
  entries.push(
    `${item.name} ${item.version}\n  License: ${item.license}\n  Source: ${item.source}\n  Text: ${references.join('; ')}`,
  );
}

const output = `Cua Driver 0.28.2 third-party dependency notices
================================================

This conservative inventory includes normal and build dependencies for both
macOS architectures. It can include crates absent from the published executable.
The Cua Driver's own MIT license and the embedded Inter font's OFL license are
separate files beside this notice. Source: docs/computer-use-cua-driver-dependencies.tsv.

Packages
--------
${entries.join('\n\n')}

License texts
-------------
${[...texts]
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([digest, body]) => `sha256:${digest}\n${body}`)
  .join('\n\n')}
`;
if (process.argv.includes('--check')) {
  if (readFileSync(outputPath, 'utf8') !== output) throw new Error('Cua Driver notices are stale');
} else {
  writeFileSync(outputPath, output);
  console.log(`Wrote ${outputPath}`);
}

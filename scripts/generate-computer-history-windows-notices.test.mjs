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

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { renderComputerHistoryWindowsNotices } from './generate-computer-history-windows-notices.mjs';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'maka-history-notices-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const metadata = {
    packages: [{ id: 'root', name: 'maka-computer-history-windows', version: '0.1.0' }],
    resolve: { root: 'root', nodes: [{ id: 'root', deps: [] }] },
  };
  function add(name, deps = []) {
    const path = join(directory, name);
    mkdirSync(path);
    writeFileSync(join(path, 'LICENSE-MIT'), `${name} license\r\nCopyright fixture\r\n`);
    writeFileSync(join(path, 'NOTICE'), `${name} attribution\n`);
    writeFileSync(join(path, 'README.md'), 'not a license');
    const pkg = {
      id: name,
      name,
      version: '1.0.0',
      license: 'MIT',
      repository: `https://example.test/${name}`,
      manifest_path: join(path, 'Cargo.toml'),
    };
    metadata.packages.push(pkg);
    metadata.resolve.nodes.push({ id: name, deps });
    return pkg;
  }
  return { metadata, add };
}

const dependency = (pkg, ...kinds) => ({
  pkg,
  dep_kinds: kinds.map((kind) => ({ kind })),
});

test('notices follow normal and build edges, excluding dev-only and unrelated target packages', (t) => {
  const { metadata, add } = fixture(t);
  metadata.resolve.nodes[0].deps = [
    dependency('runtime', null),
    dependency('build', 'build'),
    dependency('shared', 'dev', null),
    dependency('test-only', 'dev'),
  ];
  add('runtime', [dependency('derive', null), dependency('nested-test-only', 'dev')]);
  add('build', [dependency('build-support', null)]);
  add('build-support');
  add('derive');
  add('shared');
  // Excluded packages have no license text, so accidental inclusion must fail.
  metadata.packages.push(
    ...['test-only', 'nested-test-only', 'unrelated-target'].map((id) => ({ id, name: id })),
  );
  const output = renderComputerHistoryWindowsNotices(metadata);
  assert.deepEqual(
    [...output.matchAll(/^(\S+) 1\.0\.0$/gmu)].map((match) => match[1]),
    ['build-support', 'build', 'derive', 'runtime', 'shared'],
  );
  assert.match(output, /SPDX license: MIT\nSource: https:\/\/example\.test\/runtime/u);
  assert.match(output, /--- LICENSE-MIT ---\nruntime license\nCopyright fixture/u);
  assert.match(output, /--- NOTICE ---\nruntime attribution/u);
  assert.doesNotMatch(
    output,
    /not a license|\r|SHA-?256|Cargo\.lock SHA|maka-computer-history-windows 0\.1\.0/iu,
  );
  metadata.packages.reverse();
  metadata.resolve.nodes.reverse();
  assert.equal(renderComputerHistoryWindowsNotices(metadata), output);
});

test('a compile dependency without SPDX metadata fails generation', (t) => {
  const { metadata, add } = fixture(t);
  metadata.resolve.nodes[0].deps = [dependency('runtime', null)];
  add('runtime').license = null;
  assert.throws(
    () => renderComputerHistoryWindowsNotices(metadata),
    /runtime@1\.0\.0: missing SPDX license metadata/u,
  );
});

test('a compile dependency without original license text fails generation', (t) => {
  const { metadata, add } = fixture(t);
  metadata.resolve.nodes[0].deps = [dependency('runtime', null)];
  const pkg = add('runtime');
  rmSync(join(pkg.manifest_path, '..', 'LICENSE-MIT'));
  rmSync(join(pkg.manifest_path, '..', 'NOTICE'));
  assert.throws(
    () => renderComputerHistoryWindowsNotices(metadata),
    /runtime@1\.0\.0: packaged crate has no license or notice text/u,
  );
});

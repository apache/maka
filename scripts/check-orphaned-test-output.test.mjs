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
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scripts = dirname(fileURLToPath(import.meta.url));
const rootPackage = JSON.parse(readFileSync(join(scripts, '..', 'package.json'), 'utf8'));

function fixture(t, files) {
  const root = mkdtempSync(join(tmpdir(), 'maka-orphaned-tests-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'scripts'));
  for (const name of ['check-orphaned-test-output.mjs', 'clean-build.mjs']) {
    copyFileSync(join(scripts, name), join(root, 'scripts', name));
  }
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      workspaces: ['packages/example', 'apps/desktop', 'packages/unbuilt'],
      scripts: {
        prebuild: rootPackage.scripts.prebuild,
        build: "node -e \"require('node:fs').writeFileSync('build-ran', 'yes')\"",
        clean: rootPackage.scripts.clean,
        rebuild: rootPackage.scripts.rebuild,
      },
    }),
  );
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  }
  return root;
}

function check(root) {
  return spawnSync(process.execPath, [join(root, 'scripts/check-orphaned-test-output.mjs')], {
    cwd: tmpdir(),
    encoding: 'utf8',
  });
}

test('deleted and renamed test sources are reported even when output is newer', (t) => {
  const root = fixture(t, {
    'packages/example/src/renamed.test.ts': '',
    'packages/example/dist/old.test.js': 'old test',
    'apps/desktop/dist/main/__tests__/deleted.test.js': 'deleted test',
  });
  const result = check(root);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /packages[/\\]example[/\\]dist[/\\]old\.test\.js/u);
  assert.match(
    result.stderr,
    /apps[/\\]desktop[/\\]dist[/\\]main[/\\]__tests__[/\\]deleted\.test\.js/u,
  );
  assert.match(result.stderr, /npm run rebuild/u);
  assert.equal(readFileSync(join(root, 'packages/example/dist/old.test.js'), 'utf8'), 'old test');
});

test('existing TS, TSX and module-specific sources do not block incremental builds', (t) => {
  const files = {};
  for (const [stem, source, output] of [
    ['plain', 'ts', 'js'],
    ['react', 'tsx', 'js'],
    ['preserved', 'tsx', 'jsx'],
    ['esm', 'mts', 'mjs'],
    ['common', 'cts', 'cjs'],
    ['copied', 'js', 'js'],
  ]) {
    files[`packages/example/src/__tests__/${stem}.test.${source}`] = '';
    files[`packages/example/dist/__tests__/${stem}.test.${output}`] = '';
  }
  files['apps/desktop/src/main/__tests__/current.test.ts'] = '';
  files['apps/desktop/dist/main/__tests__/current.test.js'] = '';
  files['packages/example/dist/__tests__/helper.js'] = '';
  files['packages/example/dist/removed.test.d.ts'] = '';
  files['packages/example/dist/removed.test.js.map'] = '';
  const result = check(fixture(t, files));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
});

test('an unbuilt checkout passes', (t) => {
  const result = check(fixture(t, {}));
  assert.equal(result.status, 0, result.stderr);
});

test('root build stops before compiling and rebuild clears the stale state', (t) => {
  const root = fixture(t, {
    'packages/example/dist/deleted.test.js': 'stale test',
    'packages/example/tsconfig.tsbuildinfo': 'stale compiler state',
  });
  const npm = (command) =>
    spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', command], {
      cwd: root,
      encoding: 'utf8',
      shell: process.platform === 'win32',
    });
  const blocked = npm('build');
  assert.notEqual(blocked.status, 0, blocked.stdout);
  assert.match(blocked.stderr, /Compiled tests have no matching source/u);
  assert.equal(existsSync(join(root, 'build-ran')), false);
  const rebuilt = npm('rebuild');
  assert.equal(rebuilt.status, 0, rebuilt.stderr);
  assert.equal(existsSync(join(root, 'packages/example/dist/deleted.test.js')), false);
  assert.equal(existsSync(join(root, 'packages/example/tsconfig.tsbuildinfo')), false);
  assert.equal(existsSync(join(root, 'build-ran')), true);
});

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

import { equal, deepEqual, match } from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  collectClosure,
  compare,
  formatFailure,
  resolvePackageDirectory,
} from './check-artifact-budget.mjs';

function makeTree() {
  const root = mkdtempSync(join(tmpdir(), 'artifact-budget-'));
  const writePackage = (directory, manifest) => {
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'package.json'), JSON.stringify(manifest));
  };
  return { root, writePackage };
}

test('walks the production dependency graph', (t) => {
  const { root, writePackage } = makeTree();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  writePackage(root, { name: 'app', dependencies: { alpha: '1.0.0' } });
  writePackage(join(root, 'node_modules/alpha'), {
    name: 'alpha',
    dependencies: { beta: '1.0.0' },
  });
  writePackage(join(root, 'node_modules/beta'), { name: 'beta' });

  deepEqual(collectClosure(root), ['alpha', 'beta']);
});

test('devDependencies never ship', (t) => {
  const { root, writePackage } = makeTree();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  writePackage(root, {
    name: 'app',
    dependencies: { alpha: '1.0.0' },
    devDependencies: { renderer_only: '1.0.0' },
  });
  writePackage(join(root, 'node_modules/alpha'), { name: 'alpha' });
  writePackage(join(root, 'node_modules/renderer_only'), { name: 'renderer_only' });

  deepEqual(collectClosure(root), ['alpha']);
});

test('optional dependencies ship when they install', (t) => {
  const { root, writePackage } = makeTree();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  writePackage(root, { name: 'app', dependencies: { alpha: '1.0.0' } });
  writePackage(join(root, 'node_modules/alpha'), {
    name: 'alpha',
    optionalDependencies: { gamma: '1.0.0' },
  });
  writePackage(join(root, 'node_modules/gamma'), { name: 'gamma' });

  deepEqual(collectClosure(root), ['alpha', 'gamma']);
});

test('follows a nested node_modules copy with different dependencies', (t) => {
  // Regression: keying visited packages by name lets the hoisted copy win, so
  // the nested copy's subtree is never walked. That is how
  // `proxy-agent-negotiate` -- reachable only through
  // `packages/runtime/node_modules/https-proxy-agent` -- went missing while
  // electron-builder shipped it.
  const { root, writePackage } = makeTree();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  writePackage(root, { name: 'app', dependencies: { alpha: '1.0.0', shared: '1.0.0' } });
  writePackage(join(root, 'node_modules/shared'), { name: 'shared' });
  writePackage(join(root, 'node_modules/alpha'), {
    name: 'alpha',
    dependencies: { shared: '2.0.0' },
  });
  writePackage(join(root, 'node_modules/alpha/node_modules/shared'), {
    name: 'shared',
    dependencies: { only_via_nested: '1.0.0' },
  });
  writePackage(join(root, 'node_modules/only_via_nested'), { name: 'only_via_nested' });

  deepEqual(collectClosure(root), ['alpha', 'only_via_nested', 'shared']);
});

test('a missing package is skipped rather than throwing', (t) => {
  const { root, writePackage } = makeTree();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  writePackage(root, { name: 'app', dependencies: { absent: '1.0.0' } });
  deepEqual(collectClosure(root), []);
});

test('resolution walks up to a parent node_modules', (t) => {
  const { root, writePackage } = makeTree();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  writePackage(join(root, 'node_modules/hoisted'), { name: 'hoisted' });
  const nested = join(root, 'node_modules/alpha');
  writePackage(nested, { name: 'alpha' });

  equal(resolvePackageDirectory('hoisted', nested), join(root, 'node_modules/hoisted'));
  equal(resolvePackageDirectory('absent', nested), null);
});

test('compare reports both directions', () => {
  deepEqual(compare(['a', 'b'], ['b', 'c']), { added: ['c'], removed: ['a'] });
});

test('compare is clean when the sets match', () => {
  deepEqual(compare(['a', 'b'], ['a', 'b']), { added: [], removed: [] });
});

test('the failure names the packages and how to resolve it', () => {
  const message = formatFailure({ added: ['mermaid'], removed: [] });
  match(message, /\+ mermaid/u);
  match(message, /--write/u);
  match(message, /devDependencies/u);
});

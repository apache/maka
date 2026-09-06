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
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  orderByDescendingWeight,
  runWorkspaceTests,
  testSourceWeight,
} from './run-workspace-tests-parallel.mjs';

function immediateSuccessSpawn(started) {
  return (_command, options) => {
    started.push(options.cwd);
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('close', 0));
    return child;
  };
}

function withWorkspaceTree(files, body) {
  const root = mkdtempSync(join(tmpdir(), 'maka-workspace-order-'));
  try {
    for (const [path, contents] of Object.entries(files)) {
      const absolute = join(root, path);
      mkdirSync(join(absolute, '..'), { recursive: true });
      writeFileSync(absolute, contents);
    }
    return body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('the heaviest workspace is scheduled first', () => {
  const weights = { light: 1, heavy: 100, middle: 50 };
  assert.deepEqual(
    orderByDescendingWeight(['light', 'heavy', 'middle'], (dir) => weights[dir]),
    ['heavy', 'middle', 'light'],
  );
});

test('a single workspace is never weighed', () => {
  let weighed = 0;
  assert.deepEqual(
    orderByDescendingWeight(['only'], () => {
      weighed += 1;
      return 1;
    }),
    ['only'],
  );
  assert.equal(weighed, 0);
});

test('equally weighted workspaces keep their declared order', () => {
  assert.deepEqual(
    orderByDescendingWeight(['b', 'a', 'c'], () => 7),
    ['b', 'a', 'c'],
  );
});

test('build output and dependencies do not count toward a workspace weight', () => {
  withWorkspaceTree(
    {
      'ws-one/src/a.test.ts': 'x'.repeat(40),
      'ws-one/dist/a.test.js': 'x'.repeat(9000),
      'ws-one/node_modules/dep/dep.test.js': 'x'.repeat(9000),
      'ws-one/src/a.ts': 'x'.repeat(9000),
    },
    (root) => {
      assert.equal(testSourceWeight(root, 'ws-one'), 40);
    },
  );
});

test('an unreadable workspace weighs nothing instead of failing the run', () => {
  assert.equal(testSourceWeight(tmpdir(), 'no/such/workspace'), 0);
});

test('the run queues the heaviest workspace ahead of the lighter one', async () => {
  await withWorkspaceTree(
    {
      'ws-light/src/a.test.ts': 'x'.repeat(10),
      'ws-heavy/src/a.test.ts': 'x'.repeat(5000),
    },
    async (root) => {
      const started = [];
      await runWorkspaceTests({
        repoRoot: root,
        workspaceDirs: ['ws-light', 'ws-heavy'],
        concurrency: 1,
        spawn: immediateSuccessSpawn(started),
      });
      assert.deepEqual(
        started.map((cwd) => cwd.slice(root.length + 1)),
        ['ws-heavy', 'ws-light'],
      );
    },
  );
});

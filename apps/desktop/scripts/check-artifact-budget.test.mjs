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

import { deepEqual, equal, match } from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { compare, formatFailure, main } from './check-artifact-budget.mjs';

// Which instances the closure holds is tested with the closure itself, in
// scripts/third-party-closure.test.mjs. These tests cover the gate around it.

function ledgerFile(t, packages) {
  const directory = mkdtempSync(join(tmpdir(), 'artifact-budget-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'artifact-budget.json');
  writeFileSync(path, `${JSON.stringify({ packages }, null, 2)}\n`);
  return path;
}

function captureExitCode(t) {
  const previous = process.exitCode;
  t.after(() => {
    process.exitCode = previous;
  });
  process.exitCode = undefined;
}

test('main fails the run when the closure no longer matches the ledger', (t) => {
  captureExitCode(t);
  const errors = t.mock.method(console, 'error', () => {});
  const ledgerPath = ledgerFile(t, ['node_modules/alpha@1.0.0']);

  main({
    argv: [],
    ledgerPath,
    collect: () => ['node_modules/alpha@1.0.0', 'node_modules/mermaid@11.0.0'],
  });

  equal(process.exitCode, 1);
  equal(errors.mock.callCount(), 1);
  match(errors.mock.calls[0].arguments[0], /\+ node_modules\/mermaid@11\.0\.0/u);
});

test('main fails the run when a shipped instance changes version', (t) => {
  captureExitCode(t);
  t.mock.method(console, 'error', () => {});
  const ledgerPath = ledgerFile(t, ['node_modules/alpha@1.0.0']);

  main({ argv: [], ledgerPath, collect: () => ['node_modules/alpha@2.0.0'] });

  equal(process.exitCode, 1);
});

test('main passes when the closure matches the ledger', (t) => {
  captureExitCode(t);
  const logs = t.mock.method(console, 'log', () => {});
  const ledgerPath = ledgerFile(t, ['node_modules/alpha@1.0.0', 'node_modules/beta@1.0.0']);

  main({
    argv: [],
    ledgerPath,
    collect: () => ['node_modules/alpha@1.0.0', 'node_modules/beta@1.0.0'],
  });

  equal(process.exitCode, undefined);
  match(logs.mock.calls[0].arguments[0], /2 package instances/u);
});

test('main --write records the current closure as the ledger', (t) => {
  captureExitCode(t);
  t.mock.method(console, 'log', () => {});
  const ledgerPath = ledgerFile(t, ['node_modules/alpha@1.0.0']);

  main({ argv: ['--write'], ledgerPath, collect: () => ['node_modules/alpha@2.0.0'] });

  equal(process.exitCode, undefined);
  deepEqual(JSON.parse(readFileSync(ledgerPath, 'utf8')), {
    packages: ['node_modules/alpha@2.0.0'],
  });
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
  match(message, /Linux/u);
  match(message, /devDependencies/u);
});

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

import { deepEqual, equal, throws } from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectSpecs, compare, countSpecTests } from './check-e2e-budget.mjs';

test('counts the top-level tests and nothing configuring them', () => {
  const source = [
    "import { test } from './fixtures';",
    "test('one', async () => {});",
    '  test.setTimeout(120_000);',
    "test('two', async () => {});",
  ].join('\n');
  equal(countSpecTests(source, 'sample.spec.ts'), 2);
});

test('refuses a top-level form whose test count it cannot read', () => {
  throws(
    () => countSpecTests("test.describe('group', () => {});", 'sample.spec.ts'),
    /unrecognised top-level `test\.describe\(`/u,
  );
});

// A loop or a helper creates tests Playwright runs and this scanner cannot
// attribute. Counting them as zero is how the tier grows back in silence.
test('refuses a `test(` it cannot attribute to a line of its own', () => {
  throws(
    () => countSpecTests('for (const n of [1, 2]) {\n  test(`generated ${n}`, fn);\n}', 'a.spec.ts'),
    /`test\(` away from column 0/u,
  );
});

// playwright.config.ts sets `testDir: '.'` and no `testMatch`, so the tier is
// everything Playwright's default pattern reaches -- subdirectories and the
// `.test.ts` suffix included.
test('finds every file Playwright would run, not just top-level .spec.ts', () => {
  const root = mkdtempSync(join(tmpdir(), 'maka-e2e-budget-'));
  try {
    mkdirSync(join(root, 'nested'));
    writeFileSync(join(root, 'plain.spec.ts'), "test('a', fn);\n");
    writeFileSync(join(root, 'suffix.test.ts'), "test('b', fn);\n");
    writeFileSync(join(root, 'nested', 'deep.spec.ts'), "test('c', fn);\ntest('d', fn);\n");
    writeFileSync(join(root, 'fixtures.ts'), "test('not a spec file', fn);\n");
    deepEqual(collectSpecs(root), {
      'nested/deep.spec.ts': 2,
      'plain.spec.ts': 1,
      'suffix.test.ts': 1,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('reports every way the tier and the budget can disagree', () => {
  deepEqual(
    compare(
      {
        specs: {
          'drifted.spec.ts': { tests: 1, electron: 'needs a window' },
          'blank.spec.ts': { tests: 1, electron: '  ' },
          'gone.spec.ts': { tests: 1, electron: 'needs a window' },
        },
      },
      { 'drifted.spec.ts': 2, 'blank.spec.ts': 1, 'new.spec.ts': 1 },
    ),
    [
      'drifted.spec.ts: budget records 1 test(s), the file has 2',
      'blank.spec.ts: no reason recorded for needing a real Electron window',
      'new.spec.ts: not in the budget (1 test(s)) -- add it with a reason it needs a real window',
      'gone.spec.ts: in the budget but no longer on disk',
    ],
  );
});

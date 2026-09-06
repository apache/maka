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
import { compare, countSpecTests } from './check-e2e-budget.mjs';

test('counts the test-creating forms and ignores the configuring ones', () => {
  const source = [
    "import { test } from './fixtures';",
    'test.setTimeout(120_000);',
    "test('one', async () => {});",
    "test.skip('two', async () => {});",
    '  test("nested call inside a body", 1);',
    "test.only('three', async () => {});",
  ].join('\n');
  equal(countSpecTests(source, 'sample.spec.ts'), 3);
});

test('refuses a form whose test count cannot be read off the top level', () => {
  throws(
    () => countSpecTests("test.describe('group', () => {});", 'sample.spec.ts'),
    /unrecognised top-level `test\.describe\(`/u,
  );
});

test('reports a spec that is missing from the budget', () => {
  deepEqual(
    compare({ specs: {} }, { 'new.spec.ts': 1 }),
    ['new.spec.ts: not in the budget -- add it with a reason it needs a real window'],
  );
});

test('reports a drifted count, an empty reason, and a deleted spec', () => {
  deepEqual(
    compare(
      {
        specs: {
          'drifted.spec.ts': { tests: 1, electron: 'needs a window' },
          'blank.spec.ts': { tests: 1, electron: '  ' },
          'gone.spec.ts': { tests: 1, electron: 'needs a window' },
        },
      },
      { 'drifted.spec.ts': 2, 'blank.spec.ts': 1 },
    ),
    [
      'drifted.spec.ts: budget records 1 test(s), the file has 2',
      'blank.spec.ts: no reason recorded for needing a real Electron window',
      'gone.spec.ts: in the budget but no longer on disk',
    ],
  );
});

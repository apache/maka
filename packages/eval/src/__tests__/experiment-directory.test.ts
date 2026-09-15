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
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openExperimentDirectory } from '../experiment-directory.js';
import type { ExperimentSpec } from '../experiment.js';

test('writes canonical nested spec bytes and accepts equivalent key order', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-eval-experiment-directory-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = experiment({
    z: [{ b: 2, a: 1 }],
    a: true,
  });

  const opened = await openExperimentDirectory(root, first);
  const text = await readFile(opened.specPath, 'utf8');
  assert.equal(text.endsWith('\n'), true);
  assert.match(text, /"config":\{"a":true,"z":\[\{"a":1,"b":2\}\]\}/);

  await openExperimentDirectory(
    root,
    experiment({
      a: true,
      z: [{ a: 1, b: 2 }],
    }),
  );
});

test('rejects non-finite spec values instead of silently writing null', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-eval-experiment-directory-invalid-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(
    openExperimentDirectory(
      root,
      experiment({ invalid: Number.NaN } as unknown as ExperimentSpec['benchmark']['config']),
    ),
    /strict JSON/,
  );
});

function experiment(config: ExperimentSpec['benchmark']['config']): ExperimentSpec {
  return {
    schemaVersion: 'maka.eval.v1',
    id: 'canonical-experiment',
    benchmark: { id: 'benchmark', version: '1', config },
    executor: { kind: 'test', config: {} },
    execution: { maxConcurrentTaskGroups: 1 },
    subjects: [{ id: 'subject', kind: 'external', credentials: [], config: {} }],
    tasks: [{ id: 'task', input: 'solve', config: {} }],
    repetitions: 1,
    budget: {},
    verifier: {},
  };
}

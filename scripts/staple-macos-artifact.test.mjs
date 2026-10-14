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
import test from 'node:test';
import { stapleMacosArtifact } from './staple-macos-artifact.mjs';

const networkFailure = () =>
  Object.assign(new Error('stapler failed'), {
    code: 68,
    stdout:
      'Error Domain=NSURLErrorDomain Code=-1005 "The network connection was lost."\nThe staple and validate action failed! Error 68.\n',
    stderr: '',
  });

test('recovers a lost ticket connection and validates the same artifact', async () => {
  const calls = [];
  const delays = [];
  const output = [];
  const path = '/release/Maka snapshot.dmg';
  await stapleMacosArtifact(path, {
    run: async (command, args) => {
      calls.push([command, ...args]);
      if (calls.length === 1) throw networkFailure();
      return { stdout: 'The action worked!\n', stderr: '' };
    },
    wait: async (delay) => delays.push(delay),
    report: (text) => output.push(text),
  });
  assert.deepEqual(calls, [
    ['xcrun', 'stapler', 'staple', path],
    ['xcrun', 'stapler', 'staple', path],
    ['xcrun', 'stapler', 'validate', path],
  ]);
  assert.deepEqual(delays, [10_000]);
  assert.match(output.join(''), /The network connection was lost/u);
});

test('fails after three lost connections without validating an unstapled artifact', async () => {
  let attempts = 0;
  const delays = [];
  const failure = networkFailure();
  await assert.rejects(
    stapleMacosArtifact('/release/Maka.dmg', {
      run: async (_command, args) => {
        assert.equal(args[1], 'staple');
        attempts += 1;
        throw failure;
      },
      wait: async (delay) => delays.push(delay),
      report: () => {},
    }),
    (error) => error === failure,
  );
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [10_000, 20_000]);
});

test('does not retry other stapling failures or a rejected validation', async () => {
  for (const failure of [
    Object.assign(new Error('ticket missing'), { code: 68, stdout: 'Record not found' }),
    Object.assign(networkFailure(), { code: 65 }),
  ]) {
    let attempts = 0;
    await assert.rejects(
      stapleMacosArtifact('/release/Maka.dmg', {
        run: async () => {
          attempts += 1;
          throw failure;
        },
        wait: async () => assert.fail('permanent failures must not be retried'),
        report: () => {},
      }),
      (error) => error === failure,
    );
    assert.equal(attempts, 1);
  }

  const calls = [];
  const failure = networkFailure();
  await assert.rejects(
    stapleMacosArtifact('/release/Maka.dmg', {
      run: async (_command, args) => {
        calls.push(args[1]);
        if (args[1] === 'validate') throw failure;
        return { stdout: '', stderr: '' };
      },
      wait: async () => assert.fail('a failed validation must not be retried'),
      report: () => {},
    }),
    (error) => error === failure,
  );
  assert.deepEqual(calls, ['staple', 'validate']);
});

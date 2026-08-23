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
import {
  assertDraftProductRelease,
  verifyDraftProductRelease,
} from './product-release-authority.mjs';

test('Draft state and prerelease classification are one product Release contract', () => {
  for (const [tag, isPrerelease] of [
    ['v1.2.3', false],
    ['v1.2.3-beta.1', true],
  ]) {
    assert.equal(
      assertDraftProductRelease({ tagName: tag, isDraft: true, isPrerelease }, tag).tagName,
      tag,
    );
  }
  assert.throws(
    () =>
      assertDraftProductRelease(
        { tagName: 'v1.2.3', isDraft: false, isPrerelease: false },
        'v1.2.3',
      ),
    /must remain a Draft/u,
  );
  assert.throws(
    () =>
      assertDraftProductRelease(
        { tagName: 'v1.2.3-beta.1', isDraft: true, isPrerelease: false },
        'v1.2.3-beta.1',
      ),
    /prerelease state must be true/u,
  );
});

test('the live authority verifier binds the tag, main ancestry, and Draft Release', async () => {
  const sourceCommit = 'a'.repeat(40);
  const calls = [];
  const run = async (command, args) => {
    calls.push([command, args]);
    if (args[0] === 'ls-remote') {
      return { stdout: `${sourceCommit}\trefs/tags/v1.2.3\n` };
    }
    if (command === 'gh') {
      return {
        stdout: JSON.stringify({
          tagName: 'v1.2.3',
          isDraft: true,
          isPrerelease: false,
        }),
      };
    }
    return { stdout: '' };
  };

  await verifyDraftProductRelease({
    tag: 'v1.2.3',
    sourceCommit,
    repository: 'apache/maka',
    run,
  });

  assert.deepEqual(
    calls.map(([command, args]) => [command, args[0]]),
    [
      ['git', 'ls-remote'],
      ['git', 'fetch'],
      ['git', 'merge-base'],
      ['gh', 'release'],
    ],
  );
  assert.deepEqual(calls.at(-1)[1].slice(-2), ['--json', 'tagName,isDraft,isPrerelease']);
});

test('the live authority verifier rejects product tag drift before later checks', async () => {
  const calls = [];
  await assert.rejects(
    verifyDraftProductRelease({
      tag: 'v1.2.3',
      sourceCommit: 'a'.repeat(40),
      repository: 'apache/maka',
      run: async (command, args) => {
        calls.push([command, args]);
        return { stdout: `${'b'.repeat(40)}\trefs/tags/v1.2.3\n` };
      },
    }),
    /points to .* instead of/u,
  );
  assert.equal(calls.length, 1);
});

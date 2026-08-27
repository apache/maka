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
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  assertDraftProductRelease,
  assertImmutableReleasePolicy,
  assertProductReleaseWorkflowRun,
  assertPublishedProductRelease,
  publishDraftProductRelease,
  verifyDraftProductRelease,
} from './product-release-authority.mjs';

test('Draft state and prerelease classification are one product Release contract', () => {
  for (const [tag, isPrerelease] of [
    ['v1.2.3', false],
    ['v1.2.3-beta.1', true],
  ]) {
    assert.equal(
      assertDraftProductRelease({ id: 42, tag, draft: true, prerelease: isPrerelease }, tag).tag,
      tag,
    );
  }
  assert.throws(
    () =>
      assertDraftProductRelease(
        { id: 42, tag: 'v1.2.3', draft: false, prerelease: false },
        'v1.2.3',
      ),
    /must remain a Draft/u,
  );
  assert.throws(
    () =>
      assertDraftProductRelease(
        { id: 42, tag: 'v1.2.3-beta.1', draft: true, prerelease: false },
        'v1.2.3-beta.1',
      ),
    /prerelease state must be true/u,
  );
});

test('published state keeps stable and prerelease classification exact', () => {
  assert.equal(
    assertPublishedProductRelease(
      { id: 42, tag: 'v1.2.3', draft: false, prerelease: false, immutable: true, assets: [] },
      'v1.2.3',
      42,
      [],
    ).tag,
    'v1.2.3',
  );
  assert.throws(
    () =>
      assertPublishedProductRelease(
        {
          id: 42,
          tag: 'v1.2.3-beta.1',
          draft: false,
          prerelease: false,
          immutable: true,
          assets: [],
        },
        'v1.2.3-beta.1',
        42,
        [],
      ),
    /prerelease state/u,
  );
  assert.throws(
    () =>
      assertPublishedProductRelease(
        {
          id: 42,
          tag: 'v1.2.3',
          draft: false,
          prerelease: false,
          immutable: false,
          assets: [],
        },
        'v1.2.3',
        42,
        [],
      ),
    /without immutable release protection/u,
  );
  assert.equal(
    assertImmutableReleasePolicy({ enabled: true, enforced_by_owner: false }).enabled,
    true,
  );
  assert.throws(
    () => assertImmutableReleasePolicy({ enabled: false, enforced_by_owner: false }),
    /must be enabled/u,
  );
});

test('Release workflow evidence binds an exact successful attempt to approved source', () => {
  const sourceCommit = 'a'.repeat(40);
  const run = {
    id: 123,
    run_attempt: 2,
    path: '.github/workflows/release.yml',
    event: 'workflow_dispatch',
    status: 'completed',
    conclusion: 'success',
    head_sha: sourceCommit,
    head_branch: 'v1.2.3-incubating-rc1',
    head_repository: { full_name: 'apache/maka' },
  };
  assert.equal(
    assertProductReleaseWorkflowRun({
      run,
      tag: 'v1.2.3',
      sourceCommit,
      repository: 'apache/maka',
      runId: '123',
      runAttempt: '2',
    }),
    run,
  );
  assert.throws(
    () =>
      assertProductReleaseWorkflowRun({
        run: { ...run, head_sha: 'b'.repeat(40) },
        tag: 'v1.2.3',
        sourceCommit,
        repository: 'apache/maka',
        runId: '123',
        runAttempt: '2',
      }),
    /does not match the approved product source/u,
  );
  assert.throws(
    () =>
      assertProductReleaseWorkflowRun({
        run,
        tag: 'v1.2.3',
        sourceCommit,
        repository: 'apache/maka',
        runId: '0',
        runAttempt: '2',
      }),
    /must be positive integers/u,
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
          databaseId: 42,
          tagName: 'v1.2.3',
          isDraft: true,
          isPrerelease: false,
          assets: [],
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
  assert.deepEqual(calls.at(-1)[1].slice(-2), [
    '--json',
    'databaseId,tagName,isDraft,isPrerelease,assets',
  ]);
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

test('publication verifies live asset digests before one Stable/Latest mutation', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-publish-authority-'));
  const recordDirectory = await mkdtemp(join(tmpdir(), 'maka-publish-record-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  t.after(() => rm(recordDirectory, { recursive: true, force: true }));
  const contents = Buffer.from('verified artifact');
  await writeFile(join(directory, 'artifact.zip'), contents);
  const digest = `sha256:${createHash('sha256').update(contents).digest('hex')}`;
  const publicationRecordPath = join(recordDirectory, 'product-release.json');
  const sourceCommit = 'a'.repeat(40);
  await writeFile(
    publicationRecordPath,
    `${JSON.stringify({
      schemaVersion: 1,
      repository: 'apache/maka',
      workflow: '.github/workflows/release.yml',
      runId: '123',
      runAttempt: '2',
      sourceReferenceTag: 'v1.2.3-incubating-rc1',
      sourceCommit,
      tag: 'v1.2.3',
      version: '1.2.3',
      prerelease: false,
      assets: [{ name: 'artifact.zip', size: contents.length, digest }],
    })}\n`,
  );
  const calls = [];
  let latestReads = 0;
  const run = async (command, args) => {
    calls.push([command, args]);
    if (command === 'git' && args[0] === 'ls-remote') {
      return { stdout: `${sourceCommit}\trefs/tags/v1.2.3\n` };
    }
    if (command === 'gh' && args[0] === 'release') {
      return {
        stdout: JSON.stringify({
          databaseId: 42,
          tagName: 'v1.2.3',
          isDraft: true,
          isPrerelease: false,
          assets: [{ name: 'artifact.zip', size: contents.length, digest }],
        }),
      };
    }
    if (command === 'gh' && args.includes('repos/apache/maka/immutable-releases')) {
      return { stdout: JSON.stringify({ enabled: true, enforced_by_owner: false }) };
    }
    if (command === 'gh' && args.includes('PATCH')) {
      return {
        stdout: JSON.stringify({
          id: 42,
          tag_name: 'v1.2.3',
          draft: false,
          prerelease: false,
          immutable: true,
          assets: [{ name: 'artifact.zip', size: contents.length, digest }],
        }),
      };
    }
    if (command === 'gh' && args.includes('repos/apache/maka/releases/latest')) {
      latestReads += 1;
      return { stdout: JSON.stringify({ tag_name: latestReads === 1 ? 'v1.2.2' : 'v1.2.3' }) };
    }
    return { stdout: '' };
  };

  await publishDraftProductRelease({
    tag: 'v1.2.3',
    sourceCommit,
    repository: 'apache/maka',
    artifactDirectory: directory,
    publicationRecordPath,
    sourceReferenceTag: 'v1.2.3-incubating-rc1',
    releaseRunId: '123',
    releaseRunAttempt: '2',
    policyToken: 'policy-token',
    run,
    pause: async () => {},
  });

  const patchCall = calls.find(([, args]) => args.includes('PATCH'));
  assert.ok(patchCall);
  assert.ok(patchCall[1].includes('draft=false'));
  assert.ok(patchCall[1].includes('prerelease=false'));
  assert.ok(patchCall[1].includes('make_latest=true'));
  assert.ok(calls.every(([, args]) => !args.includes('repos/apache/maka/releases/tags/v1.2.3')));
  const policyCall = calls.find(([, args]) =>
    args.includes('repos/apache/maka/immutable-releases'),
  );
  assert.ok(policyCall);
  assert.ok(calls.indexOf(policyCall) < calls.indexOf(patchCall));
  assert.equal(latestReads, 2);
});

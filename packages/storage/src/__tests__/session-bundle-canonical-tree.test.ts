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
import { test } from 'node:test';
import {
  compareSessionBundleCanonicalPaths,
  computeSessionBundleCanonicalTreeDigest,
  encodeSessionBundleCanonicalTree,
  SessionBundleCanonicalTreeDigestBuilder,
  SessionBundleFileError,
  type SessionBundleCanonicalTreeEntry,
  type Sha256Digest,
} from '../index.js';

const identityDigest: Sha256Digest =
  'sha256:0e9561cfb83d50990a103b3896fe249a11fe27fa28985448187f93ec12116d72';
const executableDigest: Sha256Digest =
  'sha256:b4d644d4279594903f1a9911956432d9473041f2984fc6014c14d7402c7d126c';
const emptyDigest = `sha256:${createHash('sha256').update('').digest('hex')}` as Sha256Digest;

const canonicalEntries: readonly SessionBundleCanonicalTreeEntry[] = [
  {
    kind: 'file',
    path: 'state-identity.json',
    mode: 0o644,
    size: 19,
    contentDigest: identityDigest,
  },
  { kind: 'directory', path: 'state/' },
  { kind: 'directory', path: 'state/empty/' },
  { kind: 'directory', path: 'workspace/' },
  {
    kind: 'file',
    path: 'workspace/run.sh',
    mode: 0o755,
    size: 18,
    contentDigest: executableDigest,
  },
];

const unsortedEntries: readonly SessionBundleCanonicalTreeEntry[] = [
  canonicalEntries[3],
  canonicalEntries[0],
  canonicalEntries[2],
  canonicalEntries[4],
  canonicalEntries[1],
];

const expectedTreeHex = [
  '4d414b415f53455353494f4e5f42554e444c455f5452454500',
  '00000001',
  '0000000000000005',
  '02',
  '00000013',
  '73746174652d6964656e746974792e6a736f6e',
  '01a4',
  '0000000000000013',
  '0e9561cfb83d50990a103b3896fe249a11fe27fa28985448187f93ec12116d72',
  '01',
  '00000006',
  '73746174652f',
  '01ed',
  '0000000000000000',
  '0000000000000000000000000000000000000000000000000000000000000000',
  '01',
  '0000000c',
  '73746174652f656d7074792f',
  '01ed',
  '0000000000000000',
  '0000000000000000000000000000000000000000000000000000000000000000',
  '01',
  '0000000a',
  '776f726b73706163652f',
  '01ed',
  '0000000000000000',
  '0000000000000000000000000000000000000000000000000000000000000000',
  '02',
  '00000010',
  '776f726b73706163652f72756e2e7368',
  '01ed',
  '0000000000000012',
  'b4d644d4279594903f1a9911956432d9473041f2984fc6014c14d7402c7d126c',
].join('');

const expectedTreeDigest =
  'sha256:429f57cded2f9a22620adc7da0ad9d33eb1c690f8ded102042e7c6904c70d0df';

test('pins exact canonical tree-record bytes and SHA-256 digest', () => {
  const encoded = encodeSessionBundleCanonicalTree(unsortedEntries);
  assert.equal(Buffer.from(encoded).toString('hex'), expectedTreeHex);
  assert.equal(encoded.byteLength, 335);
  assert.equal(`sha256:${createHash('sha256').update(encoded).digest('hex')}`, expectedTreeDigest);
  assert.deepEqual(computeSessionBundleCanonicalTreeDigest(unsortedEntries), {
    treeDigest: expectedTreeDigest,
    payloadBytes: 37,
    entryCount: 5,
  });
});

test('incrementally hashes the same stream without retaining file bytes', () => {
  const builder = new SessionBundleCanonicalTreeDigestBuilder(canonicalEntries.length);
  for (const entry of canonicalEntries) builder.add(entry);
  assert.deepEqual(builder.finish(), {
    treeDigest: expectedTreeDigest,
    payloadBytes: 37,
    entryCount: 5,
  });
  assert.deepEqual(builder.finish(), {
    treeDigest: expectedTreeDigest,
    payloadBytes: 37,
    entryCount: 5,
  });
  assertBundleError(() => builder.add(canonicalEntries[0]), 'integrity_mismatch');

  const incomplete = new SessionBundleCanonicalTreeDigestBuilder(canonicalEntries.length + 1);
  for (const entry of canonicalEntries) incomplete.add(entry);
  assertBundleError(() => incomplete.finish(), 'integrity_mismatch');
});

test('preserves raw UTF-8 path bytes without Unicode normalization', () => {
  const decomposed = 'state/e\u0301.txt';
  const composed = 'state/é.txt';
  assert.ok(compareSessionBundleCanonicalPaths(decomposed, composed) < 0);

  const result = computeSessionBundleCanonicalTreeDigest([
    ...canonicalEntries.filter((entry) => entry.path !== 'state/empty/'),
    {
      kind: 'file',
      path: composed,
      mode: 0o644,
      size: 0,
      contentDigest: emptyDigest,
    },
    {
      kind: 'file',
      path: decomposed,
      mode: 0o644,
      size: 0,
      contentDigest: emptyDigest,
    },
  ]);
  assert.equal(result.entryCount, 6);
  assert.notEqual(result.treeDigest, expectedTreeDigest);
});

test('makes empty directories and executable semantics digest-significant', () => {
  const withoutEmptyDirectory = canonicalEntries.filter((entry) => entry.path !== 'state/empty/');
  const nonExecutable = canonicalEntries.map((entry) =>
    entry.kind === 'file' && entry.path === 'workspace/run.sh'
      ? { ...entry, mode: 0o644 as const }
      : entry,
  );
  assert.notEqual(
    computeSessionBundleCanonicalTreeDigest(withoutEmptyDirectory).treeDigest,
    expectedTreeDigest,
  );
  assert.notEqual(
    computeSessionBundleCanonicalTreeDigest(nonExecutable).treeDigest,
    expectedTreeDigest,
  );
});

test('rejects traversal, host path syntax, invalid Unicode, and paths outside V1 roots', () => {
  for (const path of [
    '/state/file',
    'C:/state/file',
    'state\\file',
    'state/../secret',
    'state/./file',
    'state//file',
    'state/\ud800',
    'other/file',
  ]) {
    assertBundleError(
      () =>
        computeSessionBundleCanonicalTreeDigest([
          ...canonicalEntries,
          {
            kind: 'file',
            path,
            mode: 0o644,
            size: 0,
            contentDigest: emptyDigest,
          },
        ]),
      'unsafe_path',
    );
  }
});

test('rejects duplicate, conflicting, orphaned, and incomplete payload trees', () => {
  assertBundleError(
    () => computeSessionBundleCanonicalTreeDigest([...canonicalEntries, canonicalEntries[1]]),
    'unsafe_path',
  );
  assertBundleError(
    () =>
      computeSessionBundleCanonicalTreeDigest([
        ...canonicalEntries,
        {
          kind: 'file',
          path: 'state/empty',
          mode: 0o644,
          size: 0,
          contentDigest: emptyDigest,
        },
      ]),
    'unsafe_path',
  );
  assertBundleError(
    () =>
      computeSessionBundleCanonicalTreeDigest([
        ...canonicalEntries,
        {
          kind: 'file',
          path: 'state/missing/file',
          mode: 0o644,
          size: 0,
          contentDigest: emptyDigest,
        },
      ]),
    'unsafe_path',
  );
  assertBundleError(
    () =>
      computeSessionBundleCanonicalTreeDigest(
        canonicalEntries.filter((entry) => entry.path !== 'workspace/'),
      ),
    'unsafe_path',
  );
});

test('rejects non-normalized file metadata and an out-of-order streaming source', () => {
  for (const entry of [
    {
      kind: 'file',
      path: 'state/private',
      mode: 0o600,
      size: 0,
      contentDigest: emptyDigest,
    },
    {
      kind: 'file',
      path: 'state/bad-digest',
      mode: 0o644,
      size: 0,
      contentDigest: `sha256:${'AB'.repeat(32)}`,
    },
    {
      kind: 'file',
      path: 'state-identity.json',
      mode: 0o755,
      size: 19,
      contentDigest: identityDigest,
    },
  ]) {
    assertBundleError(
      () =>
        computeSessionBundleCanonicalTreeDigest([
          ...canonicalEntries.filter(
            (candidate) =>
              candidate.path !== (entry.path === 'state-identity.json' ? entry.path : ''),
          ),
          entry as unknown as SessionBundleCanonicalTreeEntry,
        ]),
      'unsupported_entry',
    );
  }

  const builder = new SessionBundleCanonicalTreeDigestBuilder(canonicalEntries.length);
  builder.add(canonicalEntries[1]);
  assertBundleError(() => builder.add(canonicalEntries[0]), 'unsafe_path');
  assertBundleError(() => builder.finish(), 'integrity_mismatch');
});

test('fails closed after aggregate payload size overflows', () => {
  const builder = new SessionBundleCanonicalTreeDigestBuilder(4);
  builder.add({
    kind: 'file',
    path: 'state-identity.json',
    mode: 0o644,
    size: Number.MAX_SAFE_INTEGER,
    contentDigest: identityDigest,
  });
  builder.add({ kind: 'directory', path: 'state/' });

  assertBundleError(
    () =>
      builder.add({
        kind: 'file',
        path: 'state/file',
        mode: 0o644,
        size: 1,
        contentDigest: emptyDigest,
      }),
    'unsupported_entry',
  );

  assertBundleError(
    () => builder.add({ kind: 'directory', path: 'workspace/' }),
    'integrity_mismatch',
  );
  assertBundleError(() => builder.finish(), 'integrity_mismatch');
});

function assertBundleError(action: () => unknown, code: SessionBundleFileError['code']): void {
  assert.throws(action, (error) => {
    assert.ok(error instanceof SessionBundleFileError);
    assert.equal(error.code, code);
    return true;
  });
}

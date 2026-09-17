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
import { transformManagedMutation } from '../managed-mutation-transform.js';

test('marks deterministic Edit rejection without classifying unexpected exceptions as no-effect', () => {
  assert.throws(
    () =>
      transformManagedMutation({
        toolName: 'Edit',
        canonicalPath: 'notes.txt',
        baseContent: 'before\nbefore\n',
        args: { path: 'notes.txt', old_string: 'before', new_string: 'after' },
      }),
    (error: unknown) => error instanceof Error && error.name === 'ManagedMutationRejectedError',
  );
  const failure = new Error('unexpected argument access failure');
  assert.throws(
    () =>
      transformManagedMutation({
        toolName: 'Write',
        canonicalPath: 'notes.txt',
        baseContent: null,
        args: {
          path: 'notes.txt',
          get content() {
            throw failure;
          },
        },
      }),
    (error: unknown) => error === failure,
  );
});

test('derives Write from the immutable Git base without touching a checkout', () => {
  const result = transformManagedMutation({
    toolName: 'Write',
    canonicalPath: 'docs/hello.txt',
    baseContent: 'before\n',
    args: { path: 'docs/hello.txt', content: 'after\n' },
  });
  assert.equal(result.content, 'after\n');
  assert.equal(result.changed, true);
  assert.equal((result.providerResult as { kind: string }).kind, 'file_diff');
});

test('uses the production Edit matcher and rejects an absent target', () => {
  const result = transformManagedMutation({
    toolName: 'Edit',
    canonicalPath: 'src/value.ts',
    baseContent: 'const value = 1;\n',
    args: {
      path: 'src/value.ts',
      old_string: 'const value = 1;',
      new_string: 'const value = 2;',
    },
  });
  assert.equal(result.content, 'const value = 2;\n');
  assert.equal(result.changed, true);
  assert.throws(
    () =>
      transformManagedMutation({
        toolName: 'Edit',
        canonicalPath: 'src/missing.ts',
        baseContent: null,
        args: { path: 'src/missing.ts', old_string: 'a', new_string: 'b' },
      }),
    /does not exist/u,
  );
});

test('keeps the durable provider result bounded independently of file size', () => {
  const content = `${'x'.repeat(2 * 1024 * 1024)}\n`;
  const result = transformManagedMutation({
    toolName: 'Write',
    canonicalPath: 'artifacts/large.txt',
    baseContent: 'before\n',
    args: { path: 'artifacts/large.txt', content },
  });

  assert.equal(result.content, content);
  assert.ok(Buffer.byteLength(JSON.stringify(result.providerResult), 'utf8') <= 512);
});

test('keeps the current Edit localized diff for a small replacement in a large accepted file', () => {
  const baseContent = `${'unchanged\n'.repeat(5000)}before\n${'unchanged\n'.repeat(5000)}`;
  const result = transformManagedMutation({
    toolName: 'Edit',
    canonicalPath: 'src/large.txt',
    baseContent,
    args: { path: 'src/large.txt', old_string: 'before', new_string: 'after' },
  });
  assert.equal(result.content, baseContent.replace('before', 'after'));
  const provider = result.providerResult as { kind: string; diff: string };
  assert.equal(provider.kind, 'file_diff');
  assert.match(provider.diff, /-before\n\+after/u);
  assert.ok(Buffer.byteLength(provider.diff, 'utf8') < 1024);
});

test('distinguishes an existing empty file from creating an empty file', () => {
  const input = {
    toolName: 'Write' as const,
    canonicalPath: 'empty.txt',
    args: { path: 'empty.txt', content: '' },
  };
  assert.equal(transformManagedMutation({ ...input, baseContent: null }).changed, true);
  assert.equal(transformManagedMutation({ ...input, baseContent: '' }).changed, false);
});

test('preserves exact Write bytes and distinguishes newline-only changes from no-op', () => {
  const input = {
    toolName: 'Write' as const,
    canonicalPath: 'notes.txt',
    baseContent: 'hello',
  };
  const same = transformManagedMutation({
    ...input,
    args: { path: 'notes.txt', content: 'hello' },
  });
  assert.equal(same.changed, false);
  const changed = transformManagedMutation({
    ...input,
    args: { path: 'notes.txt', content: 'hello\n' },
  });
  assert.equal(changed.content, 'hello\n');
  assert.equal(changed.changed, true);
});

test('rejects mismatched paths instead of changing the caller arguments', () => {
  assert.throws(
    () =>
      transformManagedMutation({
        toolName: 'Write',
        canonicalPath: 'allowed.txt',
        baseContent: null,
        args: { path: 'other.txt', content: 'payload' },
      }),
    /does not match its canonical path/u,
  );
});

test('does not retain mutable Write arguments in the result', () => {
  const args = { path: 'notes.txt', content: 'after\n' };
  const result = transformManagedMutation({
    toolName: 'Write',
    canonicalPath: 'notes.txt',
    baseContent: 'before\n',
    args,
  });
  args.content = 'later external value';
  assert.equal(result.content, 'after\n');
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.providerResult));
  assert.ok(Object.isFrozen((result.providerResult as { paths: unknown }).paths));
  assert.match((result.providerResult as { diff: string }).diff, /\+after/u);
});

test('rejects ambiguous Edit and preserves current matcher failure semantics', () => {
  assert.throws(
    () =>
      transformManagedMutation({
        toolName: 'Edit',
        canonicalPath: 'notes.txt',
        baseContent: 'before\nbefore\n',
        args: { path: 'notes.txt', old_string: 'before', new_string: 'after' },
      }),
    /not unique/u,
  );
  assert.throws(
    () =>
      transformManagedMutation({
        toolName: 'Edit',
        canonicalPath: 'notes.txt',
        baseContent: 'before\n',
        args: { path: 'notes.txt', old_string: 'before', new_string: 'before' },
      }),
    /identical/u,
  );
});

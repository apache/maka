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

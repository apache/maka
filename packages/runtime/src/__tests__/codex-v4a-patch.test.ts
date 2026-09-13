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
import { describe, test } from 'node:test';
import { CodexV4aPatchError, parseCodexV4aPatch } from '../codex-v4a-patch.js';

function envelope(body: string): string {
  return `*** Begin Patch\n${body}\n*** End Patch`;
}

describe('parseCodexV4aPatch', () => {
  test('parses an update operation from its hunk', () => {
    assert.deepEqual(
      parseCodexV4aPatch(envelope('*** Update File: src/app.ts\n@@\n-before\n+after')),
      [{ type: 'update_file', path: 'src/app.ts', diff: '@@\n-before\n+after' }],
    );
  });

  test('parses an add operation and terminates its diff with a final + line', () => {
    assert.deepEqual(parseCodexV4aPatch(envelope('*** Add File: new.txt\n+hello')), [
      { type: 'create_file', path: 'new.txt', diff: '+hello\n+' },
    ]);
  });

  test('parses a delete operation without requiring a diff', () => {
    assert.deepEqual(parseCodexV4aPatch(envelope('*** Delete File: old.txt')), [
      { type: 'delete_file', path: 'old.txt' },
    ]);
  });

  test('parses several operations in one patch', () => {
    const operations = parseCodexV4aPatch(
      envelope(
        [
          '*** Delete File: gone.txt',
          '*** Add File: fresh.txt',
          '+content',
          '*** Update File: kept.txt',
          '@@',
          '-old',
          '+new',
        ].join('\n'),
      ),
    );
    assert.deepEqual(operations, [
      { type: 'delete_file', path: 'gone.txt' },
      { type: 'create_file', path: 'fresh.txt', diff: '+content\n+' },
      { type: 'update_file', path: 'kept.txt', diff: '@@\n-old\n+new' },
    ]);
  });

  test('normalizes CRLF line endings before parsing', () => {
    assert.deepEqual(
      parseCodexV4aPatch('*** Begin Patch\r\n*** Delete File: old.txt\r\n*** End Patch'),
      [{ type: 'delete_file', path: 'old.txt' }],
    );
  });

  test('rejects input without the envelope', () => {
    assert.throws(() => parseCodexV4aPatch('*** Delete File: old.txt'), CodexV4aPatchError);
    assert.throws(
      () => parseCodexV4aPatch('*** Begin Patch\n*** Delete File: old.txt'),
      CodexV4aPatchError,
    );
  });

  test('rejects an empty patch', () => {
    assert.throws(() => parseCodexV4aPatch(envelope('')), CodexV4aPatchError);
  });

  test('rejects an invalid file header and reports its source line', () => {
    // Line 1 is *** Begin Patch, so the first body line is source line 2.
    assert.throws(
      () => parseCodexV4aPatch(envelope('not-a-header')),
      (error: unknown) =>
        error instanceof CodexV4aPatchError &&
        error.message === 'Invalid ApplyPatch file header at line 2.',
    );
  });

  test('rejects an empty file path', () => {
    assert.throws(
      () => parseCodexV4aPatch(envelope('*** Add File:   ')),
      (error: unknown) =>
        error instanceof CodexV4aPatchError &&
        error.message === 'ApplyPatch file paths cannot be empty.',
    );
  });

  test('rejects an add whose diff has a line not prefixed with +', () => {
    assert.throws(
      () => parseCodexV4aPatch(envelope('*** Add File: new.txt\n+kept\nleaked')),
      (error: unknown) =>
        error instanceof CodexV4aPatchError &&
        error.message === 'ApplyPatch Add for new.txt must prefix every line with +.',
    );
  });

  test('rejects an update with an invalid diff line', () => {
    assert.throws(
      () => parseCodexV4aPatch(envelope('*** Update File: app.ts\n@@\n*stray')),
      (error: unknown) =>
        error instanceof CodexV4aPatchError &&
        error.message === 'ApplyPatch Update for app.ts contains an invalid diff line.',
    );
  });

  test('rejects an update with no diff body', () => {
    assert.throws(
      () => parseCodexV4aPatch(envelope('*** Update File: app.ts\n*** Update File: other.ts\n@@')),
      (error: unknown) =>
        error instanceof CodexV4aPatchError &&
        error.message === 'ApplyPatch Update for app.ts has no diff.',
    );
  });

  test('rejects move operations', () => {
    assert.throws(
      () => parseCodexV4aPatch(envelope('*** Update File: app.ts\n*** Move to: renamed.ts')),
      (error: unknown) =>
        error instanceof CodexV4aPatchError && error.message.includes('Move is not supported'),
    );
  });
});

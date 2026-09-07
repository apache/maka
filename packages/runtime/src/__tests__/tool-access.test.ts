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
import {
  normalizeToolAccesses,
  normalizeToolFilePath,
  ToolAccesses,
  toolAccessesConflict,
} from '../tool-access.js';

const POSIX = { cwd: '/repo', platform: 'linux' as const };

describe('ToolAccesses conflict model', () => {
  test('allows overlapping readers and conflicts every overlapping writer', () => {
    const read = ToolAccesses.readFile('/repo/a.ts', POSIX);
    const search = ToolAccesses.searchTree('/repo', POSIX);
    const write = ToolAccesses.writeFile('/repo/a.ts', POSIX);
    const readWrite = ToolAccesses.readWriteFile('/repo/a.ts', POSIX);

    assert.equal(toolAccessesConflict(read, read), false);
    assert.equal(toolAccessesConflict(read, search), false);
    assert.equal(toolAccessesConflict(read, write), true);
    assert.equal(toolAccessesConflict(write, read), true);
    assert.equal(toolAccessesConflict(write, write), true);
    assert.equal(toolAccessesConflict(readWrite, read), true);
  });

  test('allows writes to different files', () => {
    assert.equal(
      toolAccessesConflict(
        ToolAccesses.writeFile('/repo/a.ts', POSIX),
        ToolAccesses.writeFile('/repo/b.ts', POSIX),
      ),
      false,
    );
  });

  test('compares recursive ranges by path segment instead of string prefix', () => {
    const tree = ToolAccesses.writeTree('/repo/src', POSIX);
    assert.equal(
      toolAccessesConflict(tree, ToolAccesses.readFile('/repo/src/nested/a.ts', POSIX)),
      true,
    );
    assert.equal(
      toolAccessesConflict(tree, ToolAccesses.readFile('/repo/src2/a.ts', POSIX)),
      false,
    );
  });

  test('blocks a multi-access task when any resource conflicts', () => {
    const copy = [
      ...ToolAccesses.readFile('/repo/source.ts', POSIX),
      ...ToolAccesses.writeFile('/repo/target.ts', POSIX),
    ];
    assert.equal(toolAccessesConflict(copy, ToolAccesses.readFile('/repo/target.ts', POSIX)), true);
    assert.equal(toolAccessesConflict(copy, ToolAccesses.readFile('/repo/other.ts', POSIX)), false);
  });

  test('treats all as conflicting with non-empty accesses but not none', () => {
    assert.equal(
      toolAccessesConflict(ToolAccesses.all(), ToolAccesses.readFile('/repo/a', POSIX)),
      true,
    );
    assert.equal(toolAccessesConflict(ToolAccesses.all(), ToolAccesses.all()), true);
    assert.equal(toolAccessesConflict(ToolAccesses.all(), ToolAccesses.none()), false);
    assert.equal(
      toolAccessesConflict(ToolAccesses.none(), ToolAccesses.writeFile('/repo/a', POSIX)),
      false,
    );
  });

  test('uses namespaced logical keys with read/write semantics', () => {
    const read = ToolAccesses.readKey('session:s1:todo');
    const write = ToolAccesses.writeKey('session:s1:todo');
    assert.equal(toolAccessesConflict(read, read), false);
    assert.equal(toolAccessesConflict(read, write), true);
    assert.equal(toolAccessesConflict(write, ToolAccesses.writeKey('session:s2:todo')), false);
  });
});

describe('ToolAccesses normalization', () => {
  test('resolves dot segments and normalizes Windows separators and case', () => {
    assert.equal(
      normalizeToolFilePath('src\\..\\SRC\\A.ts', {
        cwd: 'C:\\Repo',
        platform: 'win32',
      }),
      'c:/repo/src/a.ts',
    );
  });

  test('normalizes raw declarations at the batch boundary', () => {
    assert.deepEqual(
      normalizeToolAccesses([{ kind: 'file', operation: 'write', path: './src/../a.ts' }], POSIX),
      [{ kind: 'file', operation: 'write', path: '/repo/a.ts' }],
    );
  });
});

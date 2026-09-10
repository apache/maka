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
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { LocalWorkspaceExecutor } from '../workspace-executor.js';
import { readTextLineWindow } from '../text-line-window.js';
import { executeFilesystemWorkerRequest } from '../filesystem-worker/operations.js';
import { FILESYSTEM_WORKER_PROTOCOL_VERSION } from '../filesystem-worker/protocol.js';

test('partial file reads allocate line entries only for the selected window', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'maka-read-line-window-')));
  const originalSplit = String.prototype.split;
  const originalJoin = Array.prototype.join;
  let expandedSlots = 0;
  let maxSelectedSlots = 0;
  String.prototype.split = function (this: string, ...args: Parameters<typeof originalSplit>) {
    const result = Reflect.apply(originalSplit, this, args);
    const caller = Reflect.apply(originalSplit, new Error().stack ?? '', ['\n'])[2] ?? '';
    if (
      ['workspace-executor.js:', 'filesystem-worker/operations.js:', 'text-line-window.js:'].some(
        (source) => caller.includes(source),
      )
    )
      expandedSlots += result.length;
    return result;
  } as typeof originalSplit;
  Array.prototype.join = function (...args: Parameters<typeof originalJoin>) {
    const caller = Reflect.apply(originalSplit, new Error().stack ?? '', ['\n'])[2] ?? '';
    if (caller.includes('text-line-window.js:'))
      maxSelectedSlots = Math.max(maxSelectedSlots, this.length);
    return Reflect.apply(originalJoin, this, args);
  };
  try {
    const values = [undefined, -Infinity, -9, -2.8, -1, -0, 0.5, 1, 2.8, 9, Infinity, NaN];
    const samples = [
      '',
      '\n',
      '\n\n',
      'a',
      'a\nb',
      'a\nb\n',
      'a\r\nb\rc\n',
      '中🦊\n\ud800\n\udc00\n',
    ];
    for (const content of samples) {
      for (const offset of values) {
        for (const limit of values) {
          const lines = Reflect.apply(originalSplit, content, ['\n']);
          const start = offset ?? 0;
          const expected =
            offset === undefined && limit === undefined
              ? content
              : lines.slice(start, limit ? start + limit : lines.length).join('\n');
          assert.equal(readTextLineWindow(content, offset, limit), expected);
        }
      }
    }
    const workspace = new LocalWorkspaceExecutor();
    const path = join(root, 'actual.txt');
    for (const content of [
      ...samples.slice(0, -1),
      '中🦊\r\n尾\n',
      'a\n'.repeat(250_000) + '中🦊\r\n尾\n',
    ]) {
      await writeFile(path, content);
      const metadata = await stat(path, { bigint: true });
      const lines = Reflect.apply(originalSplit, content, ['\n']);
      for (const range of [
        {},
        { offset: 0, limit: 1 },
        { offset: 1, limit: 3 },
        { offset: 249_999, limit: 3 },
        { offset: 250_002, limit: 1 },
        { offset: 999_999, limit: 3 },
      ]) {
        const start = range.offset ?? 0;
        const expected =
          range.offset === undefined
            ? content
            : lines.slice(start, range.limit ? start + range.limit : lines.length).join('\n');
        assert.deepEqual(await workspace.readFile({ cwd: root, path, ...range }), {
          content: expected,
        });
        const response = await executeFilesystemWorkerRequest({
          version: FILESYSTEM_WORKER_PROTOCOL_VERSION,
          requestId: 'read-window',
          operation: { kind: 'read', cwd: root, path, ...range },
          operationBoundary: {
            filesystem: { entries: [{ path, access: 'read', scope: 'exact' }] },
          },
          expectedTarget: {
            enforcementPath: path,
            access: 'read',
            scope: 'exact',
            targetType: 'file',
            identity: { dev: String(metadata.dev), ino: String(metadata.ino) },
          },
        });
        assert.ok(response.ok);
        assert.deepEqual(response.result, { kind: 'read', content: expected });
      }
    }
    const otherScope = join(root, 'other-scope');
    await mkdir(otherScope);
    const denied = await executeFilesystemWorkerRequest({
      version: FILESYSTEM_WORKER_PROTOCOL_VERSION,
      requestId: 'denied',
      operation: { kind: 'read', cwd: otherScope, path, offset: 0, limit: 1 },
      operationBoundary: { filesystem: { entries: [] } },
      expectedTarget: {
        enforcementPath: path,
        access: 'read',
        scope: 'exact',
        targetType: 'file',
        identity: 'unchecked',
      },
    });
    assert.equal(denied.ok, false);
    if (!denied.ok) assert.equal(denied.error.code, 'path_denied');
    assert.ok(maxSelectedSlots <= 5, 'selected entries must follow the requested window');
    // The old code reaches this assertion with identical output and authorization results.
    assert.equal(expandedSlots, 0, 'partial reads must not split the complete file');
  } finally {
    String.prototype.split = originalSplit;
    Array.prototype.join = originalJoin;
    await rm(root, { recursive: true, force: true });
  }
});

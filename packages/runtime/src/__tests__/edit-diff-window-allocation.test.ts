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
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { computeEditedSource } from '../edit-replace.js';
import { createEditUnifiedDiff, createUnifiedDiff } from '../unified-diff.js';
import { executeFilesystemWorkerRequest } from '../filesystem-worker/operations.js';
import { FILESYSTEM_WORKER_PROTOCOL_VERSION } from '../filesystem-worker/protocol.js';

test('localized Edit diffs preserve hunks and bounds without full-file line arrays', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'maka-edit-diff-window-')));
  const originalSplit = String.prototype.split;
  let expandedSlots = 0;
  String.prototype.split = function (this: string, ...args: Parameters<typeof originalSplit>) {
    const result = Reflect.apply(originalSplit, this, args);
    const frames = Reflect.apply(originalSplit, new Error().stack ?? '', ['\n']);
    if (frames[2]?.includes('at splitLines ') && frames[3]?.includes('at createEditUnifiedDiff ')) {
      expandedSlots += result.length;
    }
    return result;
  } as typeof originalSplit;
  try {
    // For these short inputs the three context lines cover the entire file,
    // so the independent generic diff is the exact expected localized output.
    for (const prefix of ['', 'P\n', '中🦊\r\n\n']) {
      for (const oldSpan of ['OLD', 'OLD\nNEXT', 'OLD\n']) {
        for (const replacement of ['', 'NEW', 'NEW\n', 'N1\nN2\n']) {
          for (const suffix of ['', '\nTAIL', '\nTAIL\n', '\n\n']) {
            const before = prefix + oldSpan + suffix;
            const edit = computeEditedSource(before, oldSpan, replacement, 'small.txt');
            assert.equal(
              createEditUnifiedDiff('small.txt', before, edit.content, edit),
              createUnifiedDiff('small.txt', before, edit.content),
            );
          }
        }
      }
    }
    const tenLines = Array.from({ length: 10 }, (_, index) => `L${index}\n`).join('');
    const middle = computeEditedSource(tenLines, 'L5', 'NEW', 'middle.txt');
    assert.equal(
      createEditUnifiedDiff('middle.txt', tenLines, middle.content, middle),
      [
        '--- a/middle.txt',
        '+++ b/middle.txt',
        '@@ -3,7 +3,7 @@',
        ' L2',
        ' L3',
        ' L4',
        '-L5',
        '+NEW',
        ' L6',
        ' L7',
        ' L8',
      ].join('\n'),
    );
    for (const [before, after, match] of [
      ['', '', { startLine: 1, endLine: 1 }],
      ['x', 'y', { startLine: 0, endLine: 1 }],
      ['x', 'y', { startLine: 1, endLine: 2 }],
      ['x\0', 'y', { startLine: 1, endLine: 1 }],
      ['x', 'y\0', { startLine: 1, endLine: 1 }],
      ['OLD', 'N\n'.repeat(801), { startLine: 1, endLine: 1 }],
      ['OLD', '🦊'.repeat(8193), { startLine: 1, endLine: 1 }],
      ['OLD', 'N'.repeat(32769), { startLine: 1, endLine: 1 }],
    ] as const) {
      assert.equal(createEditUnifiedDiff('bounded.txt', before, after, match), undefined);
    }
    const oldWindowTooLarge = 'P'.repeat(32769) + '\nOLD\nTAIL';
    assert.equal(
      createEditUnifiedDiff(
        'bounded.txt',
        oldWindowTooLarge,
        oldWindowTooLarge.replace('OLD', 'NEW'),
        {
          startLine: 2,
          endLine: 2,
        },
      ),
      undefined,
    );
    const path = join(root, 'actual.txt');
    const prefix = 'a\n'.repeat(250_000);
    const before = prefix + 'TARGET\ntail\n';
    await writeFile(path, before);
    const metadata = await stat(path, { bigint: true });
    const response = await executeFilesystemWorkerRequest({
      version: FILESYSTEM_WORKER_PROTOCOL_VERSION,
      requestId: 'edit-window',
      operation: { kind: 'edit', cwd: root, path, oldString: 'TARGET', newString: 'NEW' },
      operationBoundary: { filesystem: { entries: [{ path, access: 'write', scope: 'exact' }] } },
      expectedTarget: {
        enforcementPath: path,
        access: 'write',
        scope: 'exact',
        targetType: 'file',
        identity: { dev: String(metadata.dev), ino: String(metadata.ino) },
      },
    });
    assert.ok(response.ok);
    assert.equal(response.result.kind, 'edit');
    if (response.result.kind !== 'edit') assert.fail('expected edit');
    assert.equal(
      response.result.diff,
      [
        `--- a/${path}`,
        `+++ b/${path}`,
        '@@ -249998,5 +249998,5 @@',
        ' a',
        ' a',
        ' a',
        '-TARGET',
        '+NEW',
        ' tail',
      ].join('\n'),
    );
    assert.equal(response.result.startLine, 250_001);
    assert.equal(response.result.endLine, 250_001);
    assert.equal(await readFile(path, 'utf8'), prefix + 'NEW\ntail\n');
    const after = await stat(path, { bigint: true });
    assert.equal(after.dev, metadata.dev);
    assert.equal(after.ino, metadata.ino);
    // Old code must preserve all hunks and writes before failing only this assertion.
    assert.equal(expandedSlots, 0, 'localized diffs must not split both complete files');
  } finally {
    String.prototype.split = originalSplit;
    await rm(root, { recursive: true, force: true });
  }
});

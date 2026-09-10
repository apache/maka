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
import { executeFilesystemWorkerRequest } from '../filesystem-worker/operations.js';
import { FILESYSTEM_WORKER_PROTOCOL_VERSION } from '../filesystem-worker/protocol.js';

test('edit line ranges count newlines without materializing prefix or span line arrays', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'maka-edit-line-count-')));
  const originalSplit = String.prototype.split;
  let expandedSlots = 0;
  String.prototype.split = function (this: string, ...args: Parameters<typeof originalSplit>) {
    const result = Reflect.apply(originalSplit, this, args);
    const caller = Reflect.apply(originalSplit, new Error().stack ?? '', ['\n'])[2];
    if (caller?.includes('at finish ') && caller.includes('/edit-replace.js:')) {
      expandedSlots += result.length;
    }
    return result;
  } as typeof originalSplit;
  try {
    const prefixes = ['', '\n', '\r\n', '中🦊\n\n', 'e\u0301\r', '\ud800\n', 'a\n'.repeat(250_000)];
    const spans = ['TARGET', 'TARGET\n', 'TARGET\nNEXT', 'TARGET\r\nNEXT\r\n', 'TARGET\n\n', '\n'];
    for (const prefix of prefixes) {
      for (const span of spans) {
        // A newline-only span needs an otherwise newline-free source to be unique.
        if (span === '\n' && prefix.includes('\n')) continue;
        const suffix = 'suffix🦊\udfff';
        const source = prefix + span + suffix;
        const replacement = '$&$1\\ literal';
        const startLine = Reflect.apply(originalSplit, prefix, ['\n']).length;
        const spanLines =
          Reflect.apply(originalSplit, span, ['\n']).length - (span.endsWith('\n') ? 1 : 0);
        assert.deepEqual(computeEditedSource(source, span, replacement, 'fixture.txt'), {
          content: prefix + replacement + suffix,
          matchedVia: 'exact',
          startLine,
          endLine: startLine + Math.max(spanLines, 1) - 1,
        });
      }
    }
    const largeSpan = 'BEGIN\n' + 'span\n'.repeat(250_000) + 'END\n';
    assert.deepEqual(
      computeEditedSource('prefix\n' + largeSpan + 'tail', largeSpan, 'X', 'large.txt'),
      {
        content: 'prefix\nXtail',
        matchedVia: 'exact',
        startLine: 2,
        endLine: 250_003,
      },
    );
    for (const fixture of [
      { source: 'head\n  alpha\n  beta\nend', find: 'alpha\nbeta\n', via: 'line-trimmed', end: 3 },
      { source: 'head\nalpha   beta\nend', find: 'alpha beta', via: 'whitespace', end: 2 },
      { source: 'head\nalpha\nbeta\nend', find: 'alpha\\nbeta', via: 'escape', end: 3 },
    ]) {
      const edited = computeEditedSource(fixture.source, fixture.find, 'X', 'fuzzy.txt');
      assert.equal(edited.matchedVia, fixture.via);
      assert.equal(edited.startLine, 2);
      assert.equal(edited.endLine, fixture.end);
    }
    assert.throws(
      () => computeEditedSource('TARGET TARGET', 'TARGET', 'X', 'ambiguous'),
      /not unique/,
    );
    assert.throws(() => computeEditedSource('abc', '', 'X', 'empty'), /must not be empty/);
    assert.throws(() => computeEditedSource('abc', 'abc', 'abc', 'same'), /identical/);

    const path = join(root, 'actual.txt');
    const prefix = 'a\n'.repeat(250_000);
    await writeFile(path, prefix + 'TARGET\nNEXT\ntail\n');
    const metadata = await stat(path, { bigint: true });
    const response = await executeFilesystemWorkerRequest({
      version: FILESYSTEM_WORKER_PROTOCOL_VERSION,
      requestId: 'edit-memory',
      operation: {
        kind: 'edit',
        cwd: root,
        path,
        oldString: 'TARGET\nNEXT\n',
        newString: 'REPLACED\n',
      },
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
    if (response.result.kind !== 'edit') assert.fail('expected edit result');
    assert.equal(response.result.matchedVia, 'exact');
    assert.equal(response.result.startLine, 250_001);
    assert.equal(response.result.endLine, 250_002);
    assert.match(response.result.diff ?? '', /-TARGET\n-NEXT\n\+REPLACED/);
    assert.equal(await readFile(path, 'utf8'), prefix + 'REPLACED\ntail\n');
    const after = await stat(path, { bigint: true });
    assert.equal(after.dev, metadata.dev);
    assert.equal(after.ino, metadata.ino);
    // The old implementation must pass all output/write checks before this negative control.
    assert.equal(expandedSlots, 0, 'line numbers must not require prefix/span line arrays');
  } finally {
    String.prototype.split = originalSplit;
    await rm(root, { recursive: true, force: true });
  }
});

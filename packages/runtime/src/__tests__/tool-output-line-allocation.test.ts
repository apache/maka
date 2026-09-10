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
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import type { ShellRunRecord } from '@maka/core/shell-run';
import { shellRunContent, terminalContent } from '../shell-run-tool-result.js';
import {
  OUTPUT_RECOVERY_HINT,
  type TruncatedToolOutput,
  truncateToolOutput,
} from '../tool-output.js';

// Split-based reference keeps the original line, byte, and marker contract.
function reference(
  text: string,
  maxLines: number,
  maxBytes: number,
  direction: 'head' | 'tail',
): TruncatedToolOutput {
  const totalBytes = Buffer.byteLength(text);
  const lines = (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n');
  const unchanged = { content: text, truncated: false, removed: 0, unit: 'lines' as const };
  if (lines.length <= maxLines && totalBytes <= maxBytes) return unchanged;
  const ordered = direction === 'head' ? lines : lines.reverse();
  const selected: string[] = [];
  let bytes = 0;
  let hitBytes = false;
  for (const line of ordered) {
    if (!(selected.length < maxLines)) break;
    const size = Buffer.byteLength(line) + (selected.length > 0 ? 1 : 0);
    if (bytes + size > maxBytes) {
      hitBytes = true;
      break;
    }
    selected.push(line);
    bytes += size;
  }
  let preview: string;
  if (selected.length === 0) {
    const line = ordered[0];
    const encoded = Buffer.from(line);
    preview =
      encoded.length <= maxBytes
        ? line
        : direction === 'head'
          ? encoded.subarray(0, maxBytes).toString().replace(/�+$/, '')
          : encoded
              .subarray(encoded.length - maxBytes)
              .toString()
              .replace(/^�+/, '');
    bytes = Buffer.byteLength(preview);
    hitBytes = true;
  } else {
    preview = (direction === 'head' ? selected : selected.reverse()).join('\n');
  }
  const removed = hitBytes ? Math.max(0, totalBytes - bytes) : lines.length - selected.length;
  if (removed <= 0) return unchanged;
  const unit = hitBytes ? 'bytes' : 'lines';
  const marker = `...${removed} ${unit} truncated. ${OUTPUT_RECOVERY_HINT} Otherwise work from the kept output above.`;
  return {
    content: direction === 'head' ? `${preview}\n\n${marker}` : `${marker}\n\n${preview}`,
    truncated: true,
    removed,
    unit,
  };
}

test('bounded tool windows preserve output without allocating an array of every line', () => {
  const originalSplit = String.prototype.split;
  let fullLineSlots = 0;
  String.prototype.split = function (...args: unknown[]) {
    const result = Reflect.apply(originalSplit, this, args);
    const caller = Reflect.apply(originalSplit, new Error().stack ?? '', ['\n'])[2] ?? '';
    if (caller.includes('truncateToolOutput') && caller.includes('/tool-output.js:')) {
      fullLineSlots += result.length;
    }
    return result;
  };
  try {
    const inputs = [
      '',
      '\n',
      '\n\n',
      '\n\n\n',
      'a',
      'a\n',
      '\na',
      'a\n\nb\n',
      'a\r\nb\r\n',
      '界🦊\ne\u0301\n',
      '\ud800\n\udc00',
      '�'.repeat(8),
      '🦊'.repeat(8),
      '界'.repeat(8),
      'x'.repeat(80),
    ];
    for (const text of inputs) {
      for (const maxLines of [-1, 0, 0.5, 1, 2, 3, 2000, Number.NaN, Infinity]) {
        for (const maxBytes of [-1, 0, 1, 2, 3, 4.5, 7, 20, 51200, Number.NaN, Infinity]) {
          for (const direction of ['head', 'tail'] as const) {
            assert.deepEqual(
              truncateToolOutput(text, { maxLines, maxBytes, direction }),
              reference(text, maxLines, maxBytes, direction),
              JSON.stringify({ text, maxLines, maxBytes, direction }),
            );
          }
        }
      }
    }
    // Real child-process pipe output, projected through both public result paths.
    const stdout = execFileSync(
      process.execPath,
      ['-e', "process.stdout.write('old\\n'.repeat(250000) + '界\\n🦊\\nDONE\\n')"],
      {
        encoding: 'utf8',
        maxBuffer: 2 * 1024 * 1024,
      },
    );
    const record: ShellRunRecord = {
      shellRunId: 'shell-1',
      sessionId: 'session-1',
      sourceTurnId: 'turn-1',
      sourceToolCallId: 'tool-1',
      cwd: process.cwd(),
      command: 'fixture',
      status: 'completed',
      startedAt: 1,
      updatedAt: 2,
      completedAt: 2,
      exitCode: 0,
      revision: 2,
      output: {
        mode: 'pipes',
        stdout,
        stderr: 'warning\n',
        stdoutTruncated: false,
        stderrTruncated: false,
        redacted: false,
      },
    };
    const expected = reference(stdout, 2000, 51200, 'tail');
    for (const result of [terminalContent(record), shellRunContent(record)]) {
      assert.ok('output' in result);
      assert.ok(result.output);
      assert.equal(result.output.mode, 'pipes');
      if (result.output.mode !== 'pipes') throw new Error('expected pipes');
      assert.deepEqual(result.output, {
        ...record.output,
        stdout: expected.content,
        stdoutTruncated: true,
      });
      assert.ok(result.output.stdout.endsWith('界\n🦊\nDONE'));
    }
    for (const direction of ['head', 'tail'] as const) {
      assert.deepEqual(
        truncateToolOutput(stdout, { maxLines: 3, direction }),
        reference(stdout, 3, 51200, direction),
      );
      assert.deepEqual(
        truncateToolOutput('\n'.repeat(250000), { maxLines: 3, direction }),
        reference('\n'.repeat(250000), 3, 51200, direction),
      );
    }
    assert.equal(fullLineSlots, 0, 'bounded projections must not split the full output');
  } finally {
    String.prototype.split = originalSplit;
  }
});

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
import { OUTPUT_RECOVERY_HINT, truncateToolOutput } from '../tool-output.js';

function reference(line: string, maxBytes: number, direction: 'head' | 'tail') {
  const encoded = Buffer.from(line);
  if (encoded.length <= maxBytes) {
    return { content: line, truncated: false, removed: 0, unit: 'lines' };
  }
  const preview =
    direction === 'head'
      ? encoded.subarray(0, maxBytes).toString().replace(/�+$/, '')
      : encoded
          .subarray(encoded.length - maxBytes)
          .toString()
          .replace(/^�+/, '');
  const removed = encoded.length - Buffer.byteLength(preview);
  const marker = `...${removed} bytes truncated. ${OUTPUT_RECOVERY_HINT} Otherwise work from the kept output above.`;
  return {
    content: direction === 'head' ? `${preview}\n\n${marker}` : `${marker}\n\n${preview}`,
    truncated: true,
    removed,
    unit: 'bytes',
  };
}

test('oversized single-line previews encode a bounded window, not the whole line', () => {
  const originalFrom = Buffer.from;
  let maxAllocation = 0;
  let allocations = 0;
  Buffer.from = ((...args: unknown[]) => {
    const result = Reflect.apply(originalFrom, Buffer, args);
    const caller = (new Error().stack ?? '').split('\n')[2] ?? '';
    if (caller.includes('sliceLineByBytes') && caller.includes('/tool-output.js:')) {
      allocations++;
      maxAllocation = Math.max(maxAllocation, result.length);
    }
    return result;
  }) as typeof Buffer.from;
  try {
    for (const unit of ['x', '界', '🦊', '\ud800', '\udc00', '�', 'e\u0301', '🦊\ud800界�']) {
      const line = unit.repeat(60000);
      for (const maxBytes of [0, 1, 2, 3, 4, 31, 51200]) {
        for (const direction of ['head', 'tail'] as const) {
          assert.deepEqual(
            truncateToolOutput(line, { maxBytes, direction }),
            reference(line, maxBytes, direction),
          );
        }
      }
    }
    // Force the fallback even when the line itself fits: preserve raw surrogates.
    for (const direction of ['head', 'tail'] as const) {
      assert.equal(
        truncateToolOutput('\ud800x\udc00', { maxLines: 0, maxBytes: 100, direction }).content,
        '\ud800x\udc00',
      );
    }
    const stdout = execFileSync(
      process.execPath,
      ['-e', "process.stdout.write('界🦊'.repeat(150000))"],
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
        stderr: '',
        stdoutTruncated: false,
        stderrTruncated: false,
        redacted: false,
      },
    };
    for (const result of [terminalContent(record), shellRunContent(record)]) {
      assert.ok('output' in result && result.output);
      assert.equal(result.output.mode, 'pipes');
      if (result.output.mode !== 'pipes') throw new Error('expected pipes');
      assert.deepEqual(result.output, {
        ...record.output,
        stdout: reference(stdout, 51200, 'tail').content,
        stdoutTruncated: true,
      });
    }
    assert.ok(allocations > 0, 'observe the actual single-line encoder');
    assert.ok(
      maxAllocation <= 3 * (51200 + 1),
      `oversized encoding allocated ${maxAllocation} bytes`,
    );
  } finally {
    Buffer.from = originalFrom;
  }
});

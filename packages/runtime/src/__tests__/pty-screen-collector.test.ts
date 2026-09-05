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
  PTY_PARSER_HIGH_WATER_BYTES,
  PTY_SCROLLBACK_ROWS,
  PtyScreenCollector,
} from '../pty-screen-collector.js';
import { loadPtyStack } from '../pty-stack.js';

describe('PtyScreenCollector', () => {
  test('restores cursor visibility after a DECSTR soft reset', async () => {
    const { collector, failures } = await createCollector();
    try {
      collector.accept('\u001b[?25lhidden');
      assert.equal((await collector.snapshotAtCut()).output.cursor.visible, false);

      collector.accept('\u001b[!p');
      assert.equal((await collector.snapshotAtCut()).output.cursor.visible, true);
      assert.deepEqual(failures, []);
    } finally {
      collector.dispose();
    }
  });

  test('keeps the newest frame and evicts the oldest queued data when the parse queue exceeds its budget', async () => {
    const { collector, failures } = await createCollector();
    try {
      const flood = 'x'.repeat(PTY_PARSER_HIGH_WATER_BYTES + 128 * 1024);
      collector.accept(flood);
      collector.accept('FINAL-DRAIN\n');
      const output = (await collector.snapshotAtCut()).output;
      assert.match([output.scrollback, output.screen].filter(Boolean).join('\n'), /FINAL-DRAIN/);
      assert.equal(output.truncated, true);
      assert.doesNotMatch(output.scrollback, /x{80}/);
      assert.deepEqual(failures, []);
    } finally {
      collector.dispose();
    }
  });

  test('resets the parser at an input gap so eviction cannot swallow the newest frame behind an unterminated escape sequence', async () => {
    const { collector, failures } = await createCollector();
    try {
      // OSC starts and parses into the terminal (parser waits for BEL/ST).
      collector.accept('\u001b]0;unterminated');
      await collector.snapshotAtCut();
      // The chunk carrying the OSC terminator exceeds the queue budget and is
      // evicted as the oldest queued data, creating an input gap.
      collector.accept('\u0007' + 'x'.repeat(PTY_PARSER_HIGH_WATER_BYTES));
      collector.accept('FINAL-DRAIN\n');
      const output = (await collector.snapshotAtCut()).output;
      assert.match(output.screen, /FINAL-DRAIN/);
      assert.equal(output.truncated, true);
      assert.deepEqual(failures, []);
    } finally {
      collector.dispose();
    }
  });

  test('distinguishes an intentional screen clear from scrollback eviction', async () => {
    const { collector, failures } = await createCollector();
    try {
      collector.accept('BEFORE\u001b[2J\u001b[HAFTER');
      const cleared = (await collector.snapshotAtCut()).output;
      assert.equal(cleared.screen, 'AFTER');
      assert.equal(cleared.truncated, false);

      collector.accept(
        Array.from({ length: PTY_SCROLLBACK_ROWS + 23 }, (_, index) => `line-${index}\r\n`).join(
          '',
        ),
      );
      assert.equal((await collector.snapshotAtCut()).output.truncated, false);

      collector.accept('\u001b[?1049hALT\u001b[?1049l');
      assert.equal((await collector.snapshotAtCut()).output.truncated, false);

      collector.accept('evicts-oldest\r\n');
      assert.equal((await collector.snapshotAtCut()).output.truncated, true);
      assert.deepEqual(failures, []);
    } finally {
      collector.dispose();
    }
  });
});

async function createCollector(): Promise<{
  collector: PtyScreenCollector;
  failures: Error[];
}> {
  const failures: Error[] = [];
  const collector = new PtyScreenCollector({
    stack: await loadPtyStack(),
    onProtocolReply: () => {},
    onDirty: () => {},
    onFailure: (error) => failures.push(error),
  });
  return { collector, failures };
}

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
import type { ToolOutputDeltaEvent } from '@maka/core/events';
import { TOOL_OUTPUT_DELTA_MAX_CHARS } from '@maka/core/events';
import { createToolOutputDeltaEmitter } from '../tool-output-delta.js';

describe('ToolOutputDelta emitter', () => {
  test('emits per-tool monotonic seq and preserves stdout/stderr stream labels', () => {
    const events: ToolOutputDeltaEvent[] = [];
    const emitter = createToolOutputDeltaEmitter({
      sessionId: 'session-1',
      turnId: 'turn-1',
      toolUseId: 'tool-1',
      newId: idGenerator(),
      now: nextNow(),
      push: (event) => events.push(event),
    });

    emitter.emit('stdout', 'one\n');
    emitter.emit('stderr', 'two\n');

    assert.deepStrictEqual(
      events.map((event) => event.seq),
      [1, 2],
    );
    assert.deepStrictEqual(
      events.map((event) => event.stream),
      ['stdout', 'stderr'],
    );
    assert.strictEqual(events[0]?.toolCallId, 'tool-1');
    assert.strictEqual(events[0]?.toolUseId, 'tool-1');
  });

  test('redacts chunk metadata without mutating the event shape', () => {
    const events: ToolOutputDeltaEvent[] = [];
    const emitter = createToolOutputDeltaEmitter({
      sessionId: 'session-1',
      turnId: 'turn-1',
      toolUseId: 'tool-1',
      newId: idGenerator(),
      now: nextNow(),
      push: (event) => events.push(event),
    });

    emitter.emit('stdout', 'Authorization: Bearer sk-live-secret-token-value\n');

    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0]?.redacted, true);
    assert.ok(events[0]?.chunk.includes('[redacted]'));
    assert.strictEqual(events[0]?.chunk.includes('sk-live-secret-token-value'), false);
  });

  test('buffers unterminated chunks so secrets split across writes are still redacted', () => {
    const events: ToolOutputDeltaEvent[] = [];
    const emitter = createToolOutputDeltaEmitter({
      sessionId: 'session-1',
      turnId: 'turn-1',
      toolUseId: 'tool-1',
      newId: idGenerator(),
      now: nextNow(),
      push: (event) => events.push(event),
    });

    emitter.emit('stdout', 'token=sk-live-secret');
    assert.strictEqual(events.length, 0);
    emitter.emit('stdout', '-token-value\n');

    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0]?.redacted, true);
    assert.strictEqual(events[0]?.chunk.includes('sk-live-secret-token-value'), false);
  });

  test('keeps a redaction tail when forced to flush a long unterminated stream', () => {
    const events: ToolOutputDeltaEvent[] = [];
    const emitter = createToolOutputDeltaEmitter({
      sessionId: 'session-1',
      turnId: 'turn-1',
      toolUseId: 'tool-1',
      newId: idGenerator(),
      now: nextNow(),
      push: (event) => events.push(event),
    });

    emitter.emit('stdout', `${'x'.repeat(TOOL_OUTPUT_DELTA_MAX_CHARS - 6)}token=sk-live-secret`);
    emitter.emit('stdout', '-token-value\n');

    const body = events.map((event) => event.chunk).join('');
    assert.strictEqual(body.includes('sk-live-secret-token-value'), false);
    assert.strictEqual(
      events.some((event) => event.redacted),
      true,
    );
  });

  test('enforces chunk bound before pushing to renderer', () => {
    const events: ToolOutputDeltaEvent[] = [];
    const emitter = createToolOutputDeltaEmitter({
      sessionId: 'session-1',
      turnId: 'turn-1',
      toolUseId: 'tool-1',
      newId: idGenerator(),
      now: nextNow(),
      push: (event) => events.push(event),
    });

    emitter.emit('stdout', `${'x'.repeat(TOOL_OUTPUT_DELTA_MAX_CHARS + 300)}\n`);

    assert.strictEqual(events.length > 1, true);
    assert.strictEqual(
      events.every((event) => event.chunk.length <= TOOL_OUTPUT_DELTA_MAX_CHARS),
      true,
    );
  });

  test('flush emits the final partial chunk before tool_result can arrive', () => {
    const events: ToolOutputDeltaEvent[] = [];
    const emitter = createToolOutputDeltaEmitter({
      sessionId: 'session-1',
      turnId: 'turn-1',
      toolUseId: 'tool-1',
      newId: idGenerator(),
      now: nextNow(),
      push: (event) => events.push(event),
    });

    emitter.emit('stdout', 'partial');
    assert.strictEqual(events.length, 0);
    emitter.flush();

    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0]?.chunk, 'partial');
  });
});

function idGenerator(): () => string {
  let index = 0;
  return () => `event-${++index}`;
}

function nextNow(): () => number {
  let now = 100;
  return () => now++;
}

import { describe, test } from 'node:test';
import type { ToolOutputDeltaEvent } from '@maka/core/events';
import { TOOL_OUTPUT_DELTA_MAX_CHARS } from '@maka/core/events';
import { expect } from '../test-helpers.js';
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

    expect(events.map((event) => event.seq)).toEqual([1, 2]);
    expect(events.map((event) => event.stream)).toEqual(['stdout', 'stderr']);
    expect(events[0]?.toolCallId).toBe('tool-1');
    expect(events[0]?.toolUseId).toBe('tool-1');
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

    expect(events).toHaveLength(1);
    expect(events[0]?.redacted).toBe(true);
    expect(events[0]?.chunk).toContain('[redacted]');
    expect(events[0]?.chunk.includes('sk-live-secret-token-value')).toBe(false);
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
    expect(events).toHaveLength(0);
    emitter.emit('stdout', '-token-value\n');

    expect(events).toHaveLength(1);
    expect(events[0]?.redacted).toBe(true);
    expect(events[0]?.chunk.includes('sk-live-secret-token-value')).toBe(false);
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
    expect(body.includes('sk-live-secret-token-value')).toBe(false);
    expect(events.some((event) => event.redacted)).toBe(true);
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

    expect(events.length > 1).toBe(true);
    expect(events.every((event) => event.chunk.length <= TOOL_OUTPUT_DELTA_MAX_CHARS)).toBe(true);
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
    expect(events).toHaveLength(0);
    emitter.flush();

    expect(events).toHaveLength(1);
    expect(events[0]?.chunk).toBe('partial');
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

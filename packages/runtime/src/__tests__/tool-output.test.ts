import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { truncateToolOutput } from '../tool-output.js';

describe('truncateToolOutput', () => {
  test('keeps the head and reports removed lines when over the line budget', () => {
    const text = Array.from({ length: 10 }, (_, i) => `line${i}`).join('\n');
    const result = truncateToolOutput(text, { maxLines: 4, maxBytes: 100_000, direction: 'head' });
    assert.equal(result.truncated, true);
    assert.equal(result.unit, 'lines');
    assert.equal(result.removed, 6);
    assert.ok(result.content.startsWith('line0\nline1\nline2\nline3'));
    assert.ok(result.content.includes('6 lines truncated'));
    assert.ok(!result.content.includes('line4'));
  });

  test('keeps the tail with the marker at the top when direction is tail', () => {
    const text = Array.from({ length: 10 }, (_, i) => `line${i}`).join('\n');
    const result = truncateToolOutput(text, { maxLines: 3, maxBytes: 100_000, direction: 'tail' });
    assert.equal(result.truncated, true);
    assert.equal(result.removed, 7);
    assert.ok(result.content.endsWith('line7\nline8\nline9'));
    assert.ok(result.content.startsWith('...7 lines truncated'));
    assert.ok(!result.content.includes('line6'));
  });

  test('truncates by bytes and reports the bytes unit', () => {
    const text = Array.from({ length: 50 }, () => 'x'.repeat(100)).join('\n');
    const result = truncateToolOutput(text, { maxLines: 10_000, maxBytes: 250, direction: 'head' });
    assert.equal(result.truncated, true);
    assert.equal(result.unit, 'bytes');
    assert.ok(result.removed > 0);
    assert.ok(Buffer.byteLength(result.content.split('\n\n')[0], 'utf8') <= 250);
  });

  test('does not report a truncation when only a trailing newline exceeds the byte budget', () => {
    // Content fits exactly; the lone trailing newline pushes total bytes one over.
    const text = 'x'.repeat(100) + '\n';
    const result = truncateToolOutput(text, { maxLines: 2000, maxBytes: 100 });
    assert.equal(result.truncated, false);
    assert.equal(result.content, text);
  });

  test('a single trailing newline is a terminator, not an extra line', () => {
    // 4 real lines + terminating newline must still count as 4 lines.
    const text = 'a\nb\nc\nd\n';
    const result = truncateToolOutput(text, { maxLines: 4, maxBytes: 1000 });
    assert.equal(result.truncated, false);
    assert.equal(result.content, text);
  });

  test('keeps a byte-safe slice of a single oversized line instead of dropping it', () => {
    const text = 'x'.repeat(500);
    const result = truncateToolOutput(text, { maxLines: 2000, maxBytes: 100, direction: 'head' });
    assert.equal(result.truncated, true);
    assert.equal(result.unit, 'bytes');
    const preview = result.content.split('\n\n')[0];
    assert.equal(preview, 'x'.repeat(100)); // line not dropped — head slice kept
    assert.ok(result.content.includes('truncated'));
  });

  test('byte-safe single-line slice does not split a multi-byte character', () => {
    const text = '世'.repeat(200); // 3 bytes each = 600 bytes on one line
    const result = truncateToolOutput(text, { maxLines: 2000, maxBytes: 100, direction: 'tail' });
    assert.equal(result.truncated, true);
    const preview = result.content.split('\n\n').pop() ?? '';
    assert.ok(!preview.includes('�')); // no replacement char from a mid-char cut
    assert.ok(Buffer.byteLength(preview, 'utf8') <= 100);
    assert.ok(preview.length > 0);
  });
});

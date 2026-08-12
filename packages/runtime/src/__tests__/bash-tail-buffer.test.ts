import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { BashTailBuffer } from '../bash-tail-buffer.js';

describe('BashTailBuffer', () => {
  test('bounds retained output to the cap and keeps whole tail lines', () => {
    const buf = new BashTailBuffer(20);
    for (let i = 0; i < 100; i++) buf.push(`line${i}\n`);
    const value = buf.value();
    assert.ok(value.length <= 20);
    assert.ok(value.endsWith('line99\n')); // tail preserved
    assert.ok(value.startsWith('line')); // starts at a line boundary, not mid-line
  });

  test('drops the partial leading line so a sliced secret prefix cannot survive', () => {
    // The first line would be cut mid-secret; the buffer must drop it whole so a
    // later redaction pass never sees a secret with its prefix sliced off.
    const buf = new BashTailBuffer(10);
    buf.push('SECRETXYZ\n');
    buf.push('KEEP1\nKEEP2\n');
    const value = buf.value();
    assert.equal(value, 'KEEP2\n');
    assert.ok(!value.includes('SECRET'));
  });

  test('drops a single oversized line with no newline (no safe redaction boundary)', () => {
    // A single line larger than the cap has no line boundary to cut on; keeping
    // a byte-slice could hand redaction a secret with its prefix sliced off, so
    // it is dropped entirely. Pathological case — the common single line is
    // under the cap and never sliced.
    const buf = new BashTailBuffer(5);
    buf.push('Authorization: Bearer sk-live-secret-token-value'); // one giant line
    assert.equal(buf.value(), '');
    // It also flags the unsafe drop so callers can mark the empty result.
    assert.equal(buf.hasDroppedUnsafe(), true);
  });

  test('does not flag a safe drop (partial leading line trimmed at a newline)', () => {
    const buf = new BashTailBuffer(8);
    buf.push('aaaa\nbbbb\ncccc\n'); // sliced at a newline boundary — safe, not unsafe
    assert.ok(buf.value().length <= 8);
    assert.equal(buf.hasDroppedUnsafe(), false);
  });

  test('keeps discarding continuation chunks of a dropped oversized line until a newline', () => {
    // The oversized line arrives across multiple chunks (stdout does not split on
    // line boundaries). After the prefix is dropped, the suffix chunk must stay
    // discarded — otherwise redaction would later see a secret with no prefix.
    const buf = new BashTailBuffer(20);
    buf.push('Authorization: Bearer sk-live-' + 'A'.repeat(30)); // oversized prefix dropped
    buf.push('secret_tail'); // continuation of the SAME line
    assert.equal(buf.value(), '');
    buf.push(' more\nKEEP\n'); // newline terminates the compromised line; resume after it
    assert.equal(buf.value(), 'KEEP\n');
  });
});

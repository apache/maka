import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DiagnosticLogBuffer } from '../diagnostic-log.js';

test('keeps a bounded redacted tail of diagnostic logs', () => {
  const buffer = new DiagnosticLogBuffer({
    maxBytes: 1024,
    maxEntries: 2,
    maxEntryCodePoints: 200,
    maxEntryUtf8Bytes: 80,
  });
  buffer.append('info', 'api_key=sk-secretvalue123 first', new Date('2026-08-09T00:00:00Z'));
  buffer.append('warn', '🚀'.repeat(100), new Date('2026-08-09T00:00:01Z'));
  buffer.append('error', 'newest', new Date('2026-08-09T00:00:02Z'));

  const logs = buffer.snapshot();
  assert.equal(logs.length, 2);
  assert.ok(Buffer.byteLength(JSON.stringify(logs)) <= 1024);
  assert.ok(logs.every((entry) => Buffer.byteLength(entry) <= 80));
  assert.doesNotMatch(logs.join('\n'), /sk-secretvalue123/);
  assert.match(logs.at(-1) ?? '', /ERROR newest$/);
});

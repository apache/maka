import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { formatAsKeyValueLines, formatQuietJsonValue } from '../tool-quiet-preview.js';

describe('tool quiet preview', () => {
  it('redacts secrets in values and embedded keys', () => {
    const value = formatQuietJsonValue({ password: 'correct-horse', ok: true }, 'en').body;
    assert.doesNotMatch(value, /correct-horse/);
    assert.match(value, /redacted/i);
    const key = formatAsKeyValueLines({ 'password=secret': true }, 0, 'en');
    assert.doesNotMatch(key, /secret/);
    assert.match(key, /redacted/i);
  });
});

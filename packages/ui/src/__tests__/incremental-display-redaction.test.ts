import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { appendRedactedDisplay } from '../incremental-display-redaction.js';
import { redactSecrets } from '../redact.js';

function stream(text: string, chunkSize: number): string {
  let displayed = '';
  for (let offset = 0; offset < text.length; offset += chunkSize) {
    displayed = appendRedactedDisplay(displayed, text.slice(offset, offset + chunkSize)).text;
  }
  return displayed;
}

describe('incremental display redaction', () => {
  it('matches whole-text redaction across small delta boundaries', () => {
    const text = [
      'Authorization: Bearer sk-abcdefghijklmnop ',
      'https://example.test/?access_token=secret-value&next=1 ',
      'x-api-key: abcdefghijklmnopqrstuvwxyz ',
      'opaque 0123456789abcdef0123456789abcdef01234567 done',
    ].join('\n');
    for (const chunkSize of [1, 3, 7, 20, 97]) {
      assert.equal(stream(text, chunkSize), redactSecrets(text));
    }
  });

  it('preserves a stable prefix larger than the overlap', () => {
    const prefix = 'safe '.repeat(4_000);
    const result = appendRedactedDisplay(prefix, 'tail');
    assert.equal(result.text, `${prefix}tail`);
    assert.equal(result.redacted, false);
  });

  it('does not reveal a long secret after its marker crosses the overlap', () => {
    const text = `Authorization: Bearer sk-${'a'.repeat(2_048)} done`;
    assert.equal(stream(text, 20), redactSecrets(text));
  });
});

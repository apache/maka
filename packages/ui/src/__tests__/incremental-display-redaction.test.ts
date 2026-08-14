import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  appendRedactedDisplay,
  DISPLAY_REDACTION_OVERLAP_CHARS,
  type IncrementalDisplayRedactionState,
} from '../incremental-display-redaction.js';
import { redactSecrets } from '../redact.js';

function stream(text: string, chunkSize: number): string {
  let displayed = '';
  let state: IncrementalDisplayRedactionState | undefined;
  for (let offset = 0; offset < text.length; offset += chunkSize) {
    const result = appendRedactedDisplay(
      displayed,
      text.slice(offset, offset + chunkSize),
      state,
    );
    displayed = result.text;
    state = result.state;
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

  it('carries a bounded sensitive opener across arbitrarily long whitespace', () => {
    const spaces = ' '.repeat(DISPLAY_REDACTION_OVERLAP_CHARS + 8);
    const text = `Authorization:${spaces}Bearer arbitrary-secret-value`;
    assert.equal(stream(text, 17), redactSecrets(text));
    assert.ok(!stream(text, 17).includes('arbitrary-secret-value'));
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatRedactedJson, formatToolIntent } from '@maka/ui';

describe('tool args redaction', () => {
  it('redacts JSON-shaped args before they are rendered', () => {
    const rendered = formatRedactedJson({
      command: 'curl -H "Authorization: Bearer sk-live-secret-token" https://example.test',
      nested: { apiKey: 'sk-ant-test-secret-token-12345' },
    });

    assert.doesNotMatch(rendered, /sk-live-secret-token/);
    assert.doesNotMatch(rendered, /sk-ant-test-secret-token-12345/);
    assert.match(rendered, /Authorization: Bearer/);
    assert.match(rendered, /command/);
  });

  it('redacts and caps model-authored tool intents', () => {
    const rendered = formatToolIntent(
      `Use curl with Authorization: Bearer sk-live-secret-token ${'x'.repeat(320)}`,
    );

    assert.doesNotMatch(rendered, /sk-live-secret-token/);
    assert.match(rendered, /Authorization: Bearer/);
    assert.ok(rendered.length <= 241);

  });
});

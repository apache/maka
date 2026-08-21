import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatRedactedJson, formatToolIntent } from '@maka/ui';
import { formatToolInvocationLine, projectToolArgsPreview } from '@maka/core/tool-quiet-preview';

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

  it('keeps secrets out of the collapsed-row invocation line and its wire preview', () => {
    // Built at runtime so no literal secret ever sits in the repo.
    const bearerToken = ['sk', 'live', 'test', '9f8e7d6c5b4a'].join('-');
    const passwordValue = ['maka', 'pw', '1a2b3c4d'].join('-');
    const args = {
      command: `curl -H "Authorization: Bearer ${bearerToken}" https://example.test`,
      password: passwordValue,
    };
    const line = formatToolInvocationLine({ toolName: 'Bash', args }, 'en');
    assert.ok(line !== undefined);
    assert.doesNotMatch(line, new RegExp(bearerToken));
    assert.match(line, /redacted/i);

    const preview = projectToolArgsPreview('Bash', args);
    const serialized = JSON.stringify(preview ?? null);
    assert.doesNotMatch(serialized, new RegExp(bearerToken));
    assert.doesNotMatch(serialized, new RegExp(passwordValue));
    assert.doesNotMatch(serialized, /password/);
  });
});

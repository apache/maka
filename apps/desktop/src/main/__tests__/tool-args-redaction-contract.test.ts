import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
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

  it('routes ToolActivity args through quiet formatters', async () => {
    const [toolSource, quietSource] = await Promise.all([
      readFile(join(process.cwd(), '../../packages/ui/src/tool-activity.tsx'), 'utf8'),
      readFile(join(process.cwd(), '../../packages/core/src/tool-quiet-preview.ts'), 'utf8'),
    ]);
    const toolActivity = toolSource.match(/export function ToolActivity[\s\S]*?function ToolOutputStream/)?.[0] ?? '';

    // Quiet panel: never stringify args; use formatToolInvocationLine / formatQuietJsonValue.
    assert.match(toolActivity, /formatToolInvocationLine\(item, locale\)/);
    assert.match(toolActivity, /formatQuietJsonValue/);
    assert.doesNotMatch(toolActivity, /JSON\.stringify\(item\.args/);
    assert.doesNotMatch(toolActivity, /formatRedactedJson\(item\.args\)/);
    // Keys and full lines are redacted in the shared core quiet key/value formatter.
    assert.match(quietSource, /redactSecrets\(key\)/);
    assert.match(quietSource, /push\(redactSecrets\(line\)\)|lines\.push\(redactSecrets\(line\)\)/);
  });

  it('redacts and caps model-authored tool intents before rendering', async () => {
    const rendered = formatToolIntent(
      `Use curl with Authorization: Bearer sk-live-secret-token ${'x'.repeat(320)}`,
    );

    assert.doesNotMatch(rendered, /sk-live-secret-token/);
    assert.match(rendered, /Authorization: Bearer/);
    assert.ok(rendered.length <= 241);

    const source = await readFile(join(process.cwd(), '../../packages/ui/src/tool-activity.tsx'), 'utf8');
    const toolActivity = source.match(/export function ToolActivity[\s\S]*?function ToolOutputStream/)?.[0] ?? '';
    // The rendered row label routes intent through formatToolIntent (redaction
    // + 240 cap) — raw `{item.intent}` never reaches JSX.
    assert.match(toolActivity, /formatToolIntent\(item\.intent\)/);
    assert.doesNotMatch(toolActivity, /\{item\.intent\}/);
  });

});

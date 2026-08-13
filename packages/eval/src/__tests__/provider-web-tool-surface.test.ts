import assert from 'node:assert/strict';
import test from 'node:test';
import { removeEvalWebTools } from '../provider-web-tool-surface.js';

test('Eval removes named and provider-native web tools from provider requests', () => {
  const projected = removeEvalWebTools(
    Buffer.from(
      JSON.stringify({
        model: 'deepseek-v4-flash',
        tools: [
          { type: 'function', function: { name: 'Read' } },
          { type: 'function', function: { name: 'WebSearch' } },
          { name: 'WebFetch', input_schema: {} },
          { type: 'custom', name: 'FetchURL' },
          { type: 'web_search_20250305' },
          { type: 'web_fetch_preview' },
        ],
      }),
    ),
  );

  assert.equal(projected.removed, 5);
  assert.equal(projected.model, 'deepseek-v4-flash');
  assert.deepEqual(projected.toolNames, ['Read']);
  assert.deepEqual(JSON.parse(projected.body.toString('utf8')), {
    model: 'deepseek-v4-flash',
    tools: [{ type: 'function', function: { name: 'Read' } }],
  });
});

test('Eval preserves non-JSON and requests without web tools byte-for-byte', () => {
  for (const body of [
    Buffer.from('not-json'),
    Buffer.from(JSON.stringify({ model: 'deepseek-v4-flash' })),
    Buffer.from(JSON.stringify({ tools: [{ type: 'function', function: { name: 'Read' } }] })),
  ]) {
    const projected = removeEvalWebTools(body);
    assert.equal(projected.removed, 0);
    assert.equal(projected.body, body);
  }
});

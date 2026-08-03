import assert from 'node:assert/strict';
import { test } from 'node:test';
import { workspaceFileInlineReferencesFromTokenValues } from '../inline-reference.js';

test('collects only surviving workspace-file token values with exact spaced paths', () => {
  assert.deepEqual(
    workspaceFileInlineReferencesFromTokenValues([
      '@docs/my plan.md',
      '/skill:writer',
      '@docs/my plan.md',
      'plain text',
      '@packages/ui/src/chat-turn.tsx',
    ]),
    [
      { kind: 'workspace_file', value: '@docs/my plan.md', label: 'my plan.md' },
      {
        kind: 'workspace_file',
        value: '@packages/ui/src/chat-turn.tsx',
        label: 'chat-turn.tsx',
      },
    ],
  );
});

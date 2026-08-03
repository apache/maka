import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeSentInlineReferences } from '../session-send-inline-references.js';

test('merges trusted file tokens with successful Skill receipts in display order', () => {
  assert.deepEqual(
    mergeSentInlineReferences({
      displayText: 'Use /skill:Writer on @docs/my plan.md',
      rendererReferences: [
        { kind: 'workspace_file', value: '@docs/my plan.md', label: 'my plan.md' },
      ],
      receipts: [
        {
          invocation: 'explicit',
          request: 'Writer',
          success: true,
          ref: 'workspace:maka:writer',
          id: 'writer-id',
          name: 'Writer Skill',
          scope: 'workspace',
          source: 'maka',
          truncated: false,
        },
        {
          invocation: 'explicit',
          request: 'missing',
          success: false,
          reason: 'not_found',
        },
      ],
    }),
    [
      { kind: 'skill', value: '/skill:Writer', label: 'Writer Skill' },
      { kind: 'workspace_file', value: '@docs/my plan.md', label: 'my plan.md' },
    ],
  );
});

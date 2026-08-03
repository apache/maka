import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeSentInlineReferences } from '../session-send-inline-references.js';

test('merges trusted file tokens with successful Skill receipts in display order', () => {
  const displayText = 'Use /skill:writer on @docs/my plan.md';
  assert.deepEqual(
    mergeSentInlineReferences({
      displayText,
      workspaceFileReferences: [
        { value: '@docs/my plan.md', start: displayText.indexOf('@docs/my plan.md') },
      ],
      receipts: [
        {
          invocation: 'explicit',
          request: 'project:maka:writer',
          success: true,
          ref: 'workspace:maka:writer',
          id: 'writer',
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
      { kind: 'skill', value: '/skill:writer', label: 'Writer Skill', start: 4 },
      {
        kind: 'workspace_file',
        value: '@docs/my plan.md',
        label: 'my plan.md',
        start: displayText.indexOf('@docs/my plan.md'),
      },
    ],
  );
});

test('preserves only the selected occurrence of a repeated workspace value', () => {
  const displayText = 'literal @docs/a.ts then selected @docs/a.ts';
  const selectedStart = displayText.lastIndexOf('@docs/a.ts');
  assert.deepEqual(
    mergeSentInlineReferences({
      displayText,
      workspaceFileReferences: [{ value: '@docs/a.ts', start: selectedStart }],
      receipts: [],
    }),
    [
      {
        kind: 'workspace_file',
        value: '@docs/a.ts',
        label: 'a.ts',
        start: selectedStart,
      },
    ],
  );
});

test('bounds derived Skill references to the Core message schema', () => {
  const token = '/skill:writer';
  const displayText = Array.from({ length: 33 }, () => token).join(' ');
  const references = mergeSentInlineReferences({
    displayText,
    receipts: [
      {
        invocation: 'explicit',
        request: 'writer',
        success: true,
        ref: 'personal:writer',
        id: 'writer',
        name: 'w'.repeat(201),
        scope: 'workspace',
        source: 'maka',
        truncated: false,
      },
    ],
  });

  assert.equal(references.length, 32);
  assert.ok(references.every((reference) => reference.label.length === 200));

  const emojiBoundary = mergeSentInlineReferences({
    displayText: token,
    receipts: [
      {
        invocation: 'explicit',
        request: 'writer',
        success: true,
        ref: 'workspace:writer',
        id: 'writer',
        name: `${'a'.repeat(199)}😀`,
        scope: 'workspace',
        source: 'maka',
        truncated: false,
      },
    ],
  });
  assert.equal(emojiBoundary[0]?.label, 'a'.repeat(199));
});

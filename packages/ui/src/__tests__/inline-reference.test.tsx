import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { InlineReference } from '@maka/core';
import { renderToStaticMarkup } from 'react-dom/server';
import { InlineReferenceText } from '../inline-reference.js';

test('fails plain instead of tokenizing a malformed empty reference', () => {
  const markup = renderToStaticMarkup(
    <InlineReferenceText
      text="hello"
      references={[
        { kind: 'skill', value: '', label: 'Writer', start: 0 } as InlineReference,
      ]}
    />,
  );
  assert.match(markup, />hello</);
  assert.doesNotMatch(markup, /astryx-badge/);
});

test('renders only the selected occurrence of a repeated workspace value as a badge', () => {
  const text = 'literal @docs/a.ts then selected @docs/a.ts';
  const markup = renderToStaticMarkup(
    <InlineReferenceText
      text={text}
      references={[
        {
          kind: 'workspace_file',
          value: '@docs/a.ts',
          label: 'a.ts',
          start: text.lastIndexOf('@docs/a.ts'),
        },
      ]}
    />,
  );
  assert.equal(markup.match(/astryx-badge/g)?.length, 1);
  assert.match(markup, /literal @docs\/a\.ts then selected/);
  assert.match(markup, />a\.ts</);
});

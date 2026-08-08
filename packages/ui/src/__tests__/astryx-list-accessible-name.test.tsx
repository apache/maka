import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { List } from '@astryxdesign/core';
import { renderToStaticMarkup } from 'react-dom/server';

describe('Astryx List accessible name', () => {
  /**
   * Guard for `patches/@astryxdesign+core+0.2.0.patch`. `ListProps` accepts
   * `aria-label`, but upstream 0.2.0 drops it before rendering the root list.
   * Delete the patch when this passes against an unpatched package.
   */
  it('forwards its supported aria-label to the root list', () => {
    const markup = renderToStaticMarkup(
      <List aria-label="Available models">
        <li>Example model</li>
      </List>,
    );

    assert.match(markup, /<ul[^>]*aria-label="Available models"/);
  });

  it('keeps the visible header association when an aria-label is also present', () => {
    const markup = renderToStaticMarkup(
      <List aria-label="Fallback name" header="Visible heading">
        <li>Example model</li>
      </List>,
    );

    const labelledBy = markup.match(/<ul[^>]*aria-labelledby="([^"]+)"/)?.[1];
    assert.ok(labelledBy);
    assert.match(markup, /<ul[^>]*aria-label="Fallback name"/);
    assert.ok(markup.includes(`id="${labelledBy}"`));
  });
});

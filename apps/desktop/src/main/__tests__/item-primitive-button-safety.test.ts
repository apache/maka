import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  Item,
  ItemMedia,
  ItemContent,
  ItemTitle,
  ItemDescription,
  ItemActions,
} from '@maka/ui';

// Regression guard for the Item primitive when used as a clickable row.
// An Item is routinely rendered as a <button> (provider rows, OAuth cards,
// connection rows). A <button> may only contain phrasing content, so the
// sub-slots must NOT emit <div>/<p>. This locks the behavior instead of the
// source shape so the slots can keep evolving as long as they stay
// button-safe.
describe('Item primitive button safety', () => {
  it('clickable Item renders a <button> with no flow-content slots inside', () => {
    const markup = renderToStaticMarkup(
      h(
        Item,
        {
          'aria-label': '打开 Claude 连接',
          render: h('button', { type: 'button' }),
        },
        h(ItemMedia, null, 'logo'),
        h(
          ItemContent,
          null,
          h(ItemTitle, null, 'Claude'),
          h(ItemDescription, null, 'Anthropic 官方接入'),
        ),
        h(ItemActions, null, 'chevron'),
      ),
    );

    // The row is a real button and keeps its accessible name + type.
    assert.match(markup, /^<button/);
    assert.match(markup, /aria-label="打开 Claude 连接"/);
    assert.match(markup, /type="button"/);

    // No invalid nesting: a <button> must not contain <div>/<p>.
    assert.doesNotMatch(markup, /<div/);
    assert.doesNotMatch(markup, /<p[\s>]/);

    // Content + slot identity still render.
    assert.match(markup, /Claude/);
    assert.match(markup, /Anthropic 官方接入/);
    assert.match(markup, /data-slot="item-content"/);
    assert.match(markup, /data-slot="item-description"/);
    assert.match(markup, /data-slot="item-actions"/);
  });

  it('non-clickable Item stays a <div> container', () => {
    const markup = renderToStaticMarkup(
      h(Item, null, h(ItemContent, null, h(ItemTitle, null, '静态行'))),
    );

    assert.match(markup, /^<div/);
    assert.match(markup, /静态行/);
  });
});

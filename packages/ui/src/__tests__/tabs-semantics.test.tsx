import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { Tab, TabList } from '@astryxdesign/core';

describe('tabs accessibility semantics', () => {
  it('exposes Astryx navigation with the current page and roving tab stop', () => {
    const markup = renderToStaticMarkup(
      <TabList value="activity" onChange={() => {}} aria-label="Views">
        <Tab value="overview" label="Overview" />
        <Tab value="activity" label="Activity" />
      </TabList>,
    );

    assert.match(markup, /<nav[^>]*aria-label="Views"/);
    assert.match(markup, /data-tab-value="overview"[^>]*tabindex="-1"/);
    assert.match(markup, /data-tab-value="activity"[^>]*aria-current="page"[^>]*tabindex="0"/);
  });
});

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { Tabs, TabsList, TabsPanel, TabsTab } from '../primitives/tabs.js';

describe('Astryx-backed tabs', () => {
  it('binds the selected Astryx tab to the visible Maka panel', () => {
    const markup = renderToStaticMarkup(
      <Tabs value="activity">
        <TabsList aria-label="Views">
          <TabsTab value="overview" label="Overview" />
          <TabsTab value="activity" label="Activity" />
        </TabsList>
        <TabsPanel value="overview">Overview panel</TabsPanel>
        <TabsPanel value="activity">Activity panel</TabsPanel>
      </Tabs>,
    );

    assert.match(markup, /<nav[^>]*aria-label="Views"/);
    assert.match(markup, /data-tab-value="activity" aria-current="page"/);
    assert.doesNotMatch(markup, /Overview panel/);
    assert.match(markup, />Activity panel<\/div>/);
  });

  it('keeps an inactive panel mounted only when requested', () => {
    const markup = renderToStaticMarkup(
      <Tabs value="overview">
        <TabsList aria-label="Views">
          <TabsTab value="overview" label="Overview" />
        </TabsList>
        <TabsPanel value="activity" keepMounted>
          Preserved panel
        </TabsPanel>
      </Tabs>,
    );

    assert.match(markup, /data-slot="tabs-content" hidden="">Preserved panel/);
  });
});

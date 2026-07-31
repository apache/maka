import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { Tabs, TabsList, TabsPanel, TabsTab } from '../primitives/tabs.js';

describe('tabs accessibility semantics', () => {
  it('exposes a tablist with selected tabs and tabpanels', () => {
    const markup = renderToStaticMarkup(
      <Tabs value="activity">
        <TabsList aria-label="Views">
          <TabsTab value="overview">Overview</TabsTab>
          <TabsTab value="activity">Activity</TabsTab>
        </TabsList>
        <TabsPanel value="overview">Overview panel</TabsPanel>
        <TabsPanel value="activity">Activity panel</TabsPanel>
      </Tabs>,
    );

    assert.match(markup, /role="tablist"/);
    assert.match(markup, /role="tab"[^>]*aria-selected="false"/);
    assert.match(markup, /role="tab"[^>]*aria-selected="true"/);
    assert.match(markup, /role="tabpanel"/);
  });
});

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { REPO_ROOT } from './css-test-helpers.js';
import { renderSessionListPanel } from './session-list-render-helpers.js';
import { readRenderedSessionHistorySource } from './session-history-owner-source-helpers.js';

describe('sidebar session row menu', () => {
  it('exposes one overflow trigger instead of four inline management buttons', () => {
    const markup = renderSessionListPanel();

    assert.match(markup, /<button(?=[^>]*aria-haspopup="menu")(?=[^>]*aria-label="对话操作")[^>]*>/);
    assert.doesNotMatch(markup, /aria-label="置顶对话"/);
    assert.doesNotMatch(markup, /aria-label="重命名对话"/);
    assert.doesNotMatch(markup, /aria-label="归档对话"/);
    assert.doesNotMatch(markup, /aria-label="删除对话"/);
  });

  it('keeps row metadata hidden while the portaled menu owns focus', async () => {
    const [source, styles] = await Promise.all([
      readRenderedSessionHistorySource(),
      readFile(join(REPO_ROOT, 'apps/desktop/src/renderer/styles/sidebar.css'), 'utf8'),
    ]);

    assert.match(source, /data-menu-open=\{menuOpen \? 'true' : undefined\}/);
    assert.match(
      styles,
      /\.maka-list-row\[data-menu-open="true"\] \.maka-list-row-meta,[\s\S]*?\.maka-list-row\[data-menu-open="true"\] \.maka-list-row-unread\s*\{[\s\S]*?visibility:\s*hidden;/,
    );
    assert.doesNotMatch(source, /<MenuPopup[^>]*sideOffset=\{4\}/);
    assert.doesNotMatch(styles, /\.maka-list-row-menu\s*\{[\s\S]*?min-width:\s*144px;/);
  });
});

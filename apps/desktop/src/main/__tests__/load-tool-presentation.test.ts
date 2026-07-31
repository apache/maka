import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { describeLoadToolResult, loadToolDisplayName } from '@maka/ui';

// The `load_tools` group-activation connector gets a friendly, locale-aware
// presentation in the renderer instead of its raw name + raw JSON result.
// The copy logic is pure (locale passed in) so it is tested without a DOM.

describe('load_tools presentation', () => {
  test('display name is localized', () => {
    assert.equal(loadToolDisplayName('zh'), '加载工具组');
    assert.equal(loadToolDisplayName('en'), 'Load tools');
  });

  test('describes a browser load in Chinese', () => {
    const d = describeLoadToolResult(
      { group: 'browser' },
      { loaded: ['browser_click', 'browser_type'] },
      'zh',
    );
    assert.ok(d);
    assert.equal(d.title, '已加载 browser 工具组');
    assert.equal(d.countLabel, '新增 2 个可用工具：');
    assert.equal(d.toolsText, 'browser_click、browser_type');
    assert.equal(d.footer, '下一步即可调用');
  });

  test('describes a load in English with singular/plural counts', () => {
    const one = describeLoadToolResult(
      { group: 'computer_use' },
      { loaded: ['maka_computer'] },
      'en',
    );
    assert.ok(one);
    assert.equal(one.title, 'Loaded computer_use tools');
    assert.equal(one.countLabel, 'Added 1 available tool:');
    assert.equal(one.toolsText, 'maka_computer');

    const many = describeLoadToolResult({ group: 'computer_use' }, { loaded: ['a', 'b'] }, 'en');
    assert.equal(many?.countLabel, 'Added 2 available tools:');
  });

  test('historical load_tool namespace arg still renders (replayed old sessions)', () => {
    assert.equal(describeLoadToolResult({ namespace: 'browser' }, { loaded: ['x'] }, 'zh')?.title, '已加载 browser 工具组');
    assert.equal(
      describeLoadToolResult({ namespace: 'rive' }, { loaded: ['x'] }, 'en')?.title,
      'Loaded rive tools',
    );
  });

  test('missing group falls back to a generic title', () => {
    assert.equal(describeLoadToolResult({}, { loaded: ['x'] }, 'zh')?.title, '已加载工具组');
    assert.equal(describeLoadToolResult(undefined, { loaded: ['x'] }, 'en')?.title, 'Loaded tools');
  });

  test('unexpected result shape → null so the caller uses the generic JSON preview', () => {
    assert.equal(describeLoadToolResult({ group: 'browser' }, { loaded: 'nope' }, 'zh'), null);
    assert.equal(describeLoadToolResult({ group: 'browser' }, { loaded: [1, 2] }, 'zh'), null);
    assert.equal(describeLoadToolResult({}, null, 'en'), null);
  });
});

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { describeLoadToolResult } from '@maka/ui';

// The `load_tools` group-activation connector gets a friendly, locale-aware
// presentation in the renderer instead of its raw name + raw JSON result.
// The copy logic is pure (locale passed in) so it is tested without a DOM.

describe('load_tools presentation', () => {
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

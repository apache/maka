import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { DailyReviewPanel } from '../daily-review-panel.js';
import { LocaleProvider } from '../locale-context.js';

function renderPanel(): string {
  return renderToStaticMarkup(
    <LocaleProvider locale="zh">
      <DailyReviewPanel
        bridge={{
          fetchDay: async () => ({
            day: { fromMs: 0, toMs: 1 },
            totals: { sessionCount: 0, requestCount: 0, totalTokens: 0, costUsd: 0, errorCount: 0 },
            sessions: [],
            topModels: [],
            topTools: [],
          }),
          runOnce: async () => ({ archiveId: '1970-01-01-1d' }),
          listArchives: async () => [],
          getArchive: async () => {
            throw new Error('No archive');
          },
        }}
      />
    </LocaleProvider>,
  );
}

describe('Daily Review activity surface', () => {
  it('offers one range-based analysis action without the retired modes', () => {
    const markup = renderPanel();

    assert.match(markup, />今日</);
    assert.match(markup, />最近 7 天</);
    assert.match(markup, />最近 30 天</);
    assert.match(markup, />生成分析</);
    assert.doesNotMatch(markup, /生成每日回顾|生成深度分析|分析模型/);
  });

  it('does not render report history or model and tool rankings on the activity route', () => {
    const markup = renderPanel();

    assert.doesNotMatch(markup, />报告</);
    assert.doesNotMatch(markup, />模型使用</);
    assert.doesNotMatch(markup, />工具调用</);
  });
});

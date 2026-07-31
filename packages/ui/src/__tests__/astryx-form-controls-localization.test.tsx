import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  DateInput,
  DateTimeInput,
  MultiSelector,
  NumberInput,
  TimeInput,
  type ISODateString,
  type ISODateTimeString,
  type ISOTimeString,
} from '@astryxdesign/core';
import {
  AstryxLocaleProvider,
  astryxMessageOverrides,
} from '../astryx-i18n.js';
import { LocaleProvider } from '../locale-context.js';

function renderChineseControl(children: React.ReactNode): string {
  return renderToStaticMarkup(
    <LocaleProvider locale="zh">
      <AstryxLocaleProvider>{children}</AstryxLocaleProvider>
    </LocaleProvider>,
  );
}

describe('Astryx form-control localization', () => {
  it('sources every rendered Slice 4 default message from the Maka copy catalog', () => {
    const messages = astryxMessageOverrides('zh')?.zh;

    assert.deepEqual(
      {
        selectorPlaceholder: messages?.['@astryx.selector.placeholder'],
        selectorSearchPlaceholder:
          messages?.['@astryx.selector.searchPlaceholder'],
        selectorSearchOptions: messages?.['@astryx.selector.searchOptions'],
        selectorClear: messages?.['@astryx.selector.clearLabel'],
        multiSelectPlaceholder:
          messages?.['@astryx.multiSelector.selectPlaceholder'],
        multiSelectAll: messages?.['@astryx.multiSelector.selectAll'],
        multiSearchPlaceholder:
          messages?.['@astryx.multiSelector.searchPlaceholder'],
        multiSearchOptions:
          messages?.['@astryx.multiSelector.searchOptions'],
        multiClearAll: messages?.['@astryx.multiSelector.clearAll'],
        numberClear: messages?.['@astryx.numberInput.clearLabel'],
        datePlaceholder: messages?.['@astryx.dateInput.placeholder'],
        dateDialog: messages?.['@astryx.dateInput.dialogLabel'],
        dateClose: messages?.['@astryx.dateInput.closeCalendar'],
        dateOpen: messages?.['@astryx.dateInput.openCalendar'],
        dateToggleClose:
          messages?.['@astryx.dateInput.toggleCalendarClose'],
        dateClear: messages?.['@astryx.dateInput.clear'],
        dateTimePlaceholder:
          messages?.['@astryx.dateTimeInput.placeholder'],
        dateTimeDialog: messages?.['@astryx.dateTimeInput.dialogLabel'],
        dateTimeTimePlaceholder:
          messages?.['@astryx.dateTimeInput.timePlaceholder'],
        dateTimeSuffix: messages?.['@astryx.dateTimeInput.timeSuffix'],
        timePlaceholder: messages?.['@astryx.timeInput.placeholder'],
        timeClear: messages?.['@astryx.timeInput.clearLabel'],
      },
      {
        selectorPlaceholder: '选择…',
        selectorSearchPlaceholder: '搜索…',
        selectorSearchOptions: '搜索选项',
        selectorClear: '清除{label}',
        multiSelectPlaceholder: '选择…',
        multiSelectAll: '全选',
        multiSearchPlaceholder: '搜索…',
        multiSearchOptions: '搜索选项',
        multiClearAll: '清除{label}的全部选项',
        numberClear: '清除{label}',
        datePlaceholder: '选择日期',
        dateDialog: '选择日期',
        dateClose: '关闭日历',
        dateOpen: '打开日历',
        dateToggleClose: '关闭日历',
        dateClear: '清除{label}',
        dateTimePlaceholder: '选择日期',
        dateTimeDialog: '选择日期',
        dateTimeTimePlaceholder: '选择时间',
        dateTimeSuffix: '{label}时间',
        timePlaceholder: '选择时间',
        timeClear: '清除{label}',
      },
    );
  });

  it('renders Chinese placeholders and accessible clear/toggle names', () => {
    const markup = renderChineseControl(
      <>
        <MultiSelector
          label="模型"
          options={['A', 'B']}
          value={[]}
          onChange={() => {}}
          hasSearch
          hasSelectAll
        />
        <NumberInput
          label="端口"
          value={3939}
          onChange={() => {}}
          hasClear
        />
        <DateInput
          label="日期"
          value={'2026-07-31' as ISODateString}
          onChange={() => {}}
          hasClear
        />
        <DateTimeInput
          label="执行日期"
          value={'2026-07-31T08:30' as ISODateTimeString}
          onChange={() => {}}
          hasClear
        />
        <TimeInput
          label="开始时间"
          value={'08:30' as ISOTimeString}
          onChange={() => {}}
          hasClear
          hourFormat="24h"
        />
      </>,
    );

    assert.match(markup, />选择…</);
    assert.match(markup, /aria-label="清除端口"/);
    assert.match(markup, /aria-label="清除日期"/);
    assert.match(markup, /aria-label="清除执行日期"/);
    assert.match(markup, /aria-label="执行日期时间"/);
    assert.match(markup, /aria-label="清除开始时间"/);
    assert.match(markup, /aria-label="打开日历"/);
    assert.doesNotMatch(
      markup,
      /Select…|Clear |Open calendar|Close calendar|Choose date/,
    );
  });
});

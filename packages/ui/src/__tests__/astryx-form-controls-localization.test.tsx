import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { CommandPaletteList, NumberInput } from '@astryxdesign/core';
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
        selectorClear: messages?.['@astryx.selector.clearLabel'],
        numberClear: messages?.['@astryx.numberInput.clearLabel'],
      },
      {
        selectorPlaceholder: '选择…',
        selectorClear: '清除{label}',
        numberClear: '清除{label}',
      },
    );
  });

  it('renders a Chinese accessible clear name', () => {
    const markup = renderChineseControl(
      <>
        <NumberInput
          label="端口"
          value={3939}
          onChange={() => {}}
          hasClear
        />
      </>,
    );

    assert.match(markup, /aria-label="清除端口"/);
    assert.doesNotMatch(markup, /Clear /);
  });

  it('merges a product-scoped label with the shared Astryx catalog', () => {
    const markup = renderToStaticMarkup(
      <LocaleProvider locale="zh">
        <AstryxLocaleProvider
          overrides={{
            '@astryx.commandPalette.list.label': '搜索结果',
          }}
        >
          <CommandPaletteList>
            <NumberInput
              label="端口"
              value={3939}
              onChange={() => {}}
              hasClear
            />
          </CommandPaletteList>
        </AstryxLocaleProvider>
      </LocaleProvider>,
    );

    assert.match(markup, /role="listbox" aria-label="搜索结果"/);
    assert.match(markup, /aria-label="清除端口"/);
    assert.doesNotMatch(markup, /Commands|Clear /);
  });
});

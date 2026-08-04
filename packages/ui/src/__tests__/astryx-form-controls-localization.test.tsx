import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { CommandPaletteList, NumberInput, TextInput } from '@astryxdesign/core';
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

  /**
   * Guard for `patches/@astryxdesign+core+0.2.0.patch`. Upstream `FieldLabel`
   * hard-codes the two words; the patch routes them through the catalog. Both
   * halves matter and they fail differently: the marker is what the patch adds,
   * `aria-required` is what a CSS-only or drop-the-prop workaround would have
   * cost. Delete the patch when this passes without it.
   */
  it('localizes the required marker while keeping aria-required', () => {
    const markup = renderChineseControl(
      <TextInput label="API Key" value="" onChange={() => {}} isRequired />,
    );

    assert.match(markup, /必填/);
    assert.doesNotMatch(markup, /Required/);
    assert.match(markup, /aria-required="true"/);
  });

  it('localizes the optional marker', () => {
    const markup = renderChineseControl(
      <TextInput label="备注" value="" onChange={() => {}} isOptional />,
    );

    assert.match(markup, /可选/);
    assert.doesNotMatch(markup, /Optional/);
  });

  /**
   * `en` resolves through the catalog the patch adds to, not through a
   * hard-coded string, so a key missing from `locales/en.json` surfaces as the
   * raw key in the markup. Both markers are asserted because they are separate
   * entries: dropping one leaves the other's assertion green.
   */
  it('keeps Astryx’s English markers when the locale is en', () => {
    const markup = renderToStaticMarkup(
      <LocaleProvider locale="en">
        <AstryxLocaleProvider>
          <TextInput label="API key" value="" onChange={() => {}} isRequired />
          <TextInput label="Note" value="" onChange={() => {}} isOptional />
        </AstryxLocaleProvider>
      </LocaleProvider>,
    );

    assert.match(markup, /Required/);
    assert.match(markup, /Optional/);
    assert.doesNotMatch(markup, /@astryx\.field/);
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

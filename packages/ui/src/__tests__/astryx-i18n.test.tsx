import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { useTranslator } from '@astryxdesign/core/i18n';
import { AstryxLocaleProvider } from '../astryx-i18n.js';
import { LocaleProvider } from '../locale-context.js';

function TranslationProbe() {
  const translate = useTranslator();
  return createElement(
    'span',
    null,
    `${translate('@maka.test.outer')}|${translate('@maka.test.inner')}`,
  );
}

test('nested Astryx locale providers preserve ambient scoped overrides', () => {
  const markup = renderToStaticMarkup(
    createElement(LocaleProvider, {
      locale: 'en',
      children: createElement(AstryxLocaleProvider, {
        overrides: { '@maka.test.outer': 'Outer copy' },
        children: createElement(AstryxLocaleProvider, {
          overrides: { '@maka.test.inner': 'Inner copy' },
          children: createElement(TranslationProbe),
        }),
      }),
    }),
  );

  assert.match(markup, />Outer copy\|Inner copy</);
});

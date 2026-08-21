import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AstryxLocaleProvider, LocaleProvider, ToastProvider } from '@maka/ui';
import { AboutSettingsPage } from '../../renderer/settings/about-settings-page.js';

test('keeps manual diagnostics available while About metadata is pending', () => {
  const page = createElement(AboutSettingsPage, {});
  const withToasts = createElement(ToastProvider, { children: page });
  const withAstryxLocale = createElement(AstryxLocaleProvider, { children: withToasts });
  const markup = renderToStaticMarkup(
    createElement(LocaleProvider, { locale: 'en', children: withAstryxLocale }),
  );

  assert.match(markup, />Copy diagnostics</);
  assert.match(markup, /role="status"[^>]*aria-busy="true"/);
});

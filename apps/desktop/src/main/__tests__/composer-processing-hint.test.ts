/**
 * Quiet composer (#646 retained, chrome simplified): streaming is communicated
 * only by Send → Stop. Long "正在处理… / 正在回答…" status copy is gone.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Composer, LocaleProvider } from '@maka/ui';

function renderWithLocale(child: ReactNode): string {
  return renderToStaticMarkup(
    createElement(LocaleProvider, { locale: 'zh', children: child }),
  );
}

function render(props: Partial<Parameters<typeof Composer>[0]>): string {
  return renderWithLocale(
    createElement(Composer, {
      onSend: () => {},
      onStop: () => {},
      ...props,
    }),
  );
}

describe('composer streaming chrome (quiet)', () => {
  it('offers Stop without long status copy while streaming in any wait state', () => {
    for (const props of [
      { streaming: true, processing: true },
      { streaming: true, processing: false },
      { streaming: true, processing: false, continuing: true },
    ] as const) {
      const markup = render(props);
      assert.match(markup, /停止/, 'Stop replaces Send while streaming');
      assert.doesNotMatch(markup, /maka-composer-streaming-hint/);
      assert.doesNotMatch(markup, /Maka 正在处理…/);
      assert.doesNotMatch(markup, /Maka 正在回答…/);
      assert.doesNotMatch(markup, /Maka 继续中…/);
    }
  });

  it('shows neither Stop nor streaming hints when idle', () => {
    const markup = render({ streaming: false });
    assert.doesNotMatch(markup, /maka-composer-streaming-hint/);
    assert.doesNotMatch(markup, /Maka 正在处理…/);
    assert.doesNotMatch(markup, /Maka 正在回答…/);
    assert.match(markup, /发送|aria-label="发送"/);
  });
});

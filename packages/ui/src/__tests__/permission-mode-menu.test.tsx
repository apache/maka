import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { PermissionMode, UiLocale } from '@maka/core';
import { PERMISSION_MODES } from '@maka/core';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { getConversationCopy } from '../conversation-copy.js';
import { LocaleProvider } from '../locale-context.js';
import { PermissionModeSelect, getPermissionModeMeta } from '../permission-mode-menu.js';

function render(locale: UiLocale, mode: PermissionMode): string {
  return renderToStaticMarkup(
    <LocaleProvider locale={locale}>
      <PermissionModeSelect activeMode={mode} onSelect={() => {}} />
    </LocaleProvider>,
  );
}

describe('Permission mode surface', () => {
  it('shows a read-only session as read-only, with its own hint (#1611)', () => {
    for (const locale of ['zh', 'en'] as const) {
      const meta = getPermissionModeMeta(locale);
      const markup = render(locale, 'explore');

      assert.match(markup, new RegExp(escapeRegExp(escapeMarkup(meta.explore.label))));
      assert.match(
        markup,
        new RegExp(
          `role="combobox"[^>]*aria-description="${escapeRegExp(escapeMarkup(meta.explore.hint))}"`,
        ),
      );
    }
  });

  it('keeps legacy execute sessions collapsed to Auto', () => {
    for (const locale of ['zh', 'en'] as const) {
      const meta = getPermissionModeMeta(locale);
      const markup = render(locale, 'execute');

      assert.match(markup, new RegExp(escapeRegExp(escapeMarkup(meta.ask.label))));
      assert.doesNotMatch(markup, new RegExp(escapeRegExp(escapeMarkup(meta.execute.hint))));
    }
  });

  it('names the dangerous mode for what it grants, not for the mechanism it turns off (#1616)', () => {
    assert.equal(getPermissionModeMeta('zh').bypass.label, '完全权限');
    assert.equal(getPermissionModeMeta('en').bypass.label, 'Full access');
    assert.match(render('zh', 'bypass'), /完全权限/);
    assert.match(render('en', 'bypass'), /Full access/);
  });

  it('leaves every Astryx option unselected when the display state is not selectable', () => {
    // The read-only state has no option to select. Astryx exposes that through
    // the public listbox contract: the trigger shows the read-only placeholder
    // while every offered option remains aria-selected=false.
    const readOnly = render('zh', 'explore');
    assert.match(readOnly, /role="combobox"[^>]*>[\s\S]*?>只读</);
    assert.equal(readOnly.match(/aria-selected="false"/g)?.length, 2);
    assert.doesNotMatch(readOnly, /aria-selected="true"/);

    // A selectable state marks exactly one option, so the check indicator and
    // keyboard restore have a stable selected item.
    assert.equal(render('zh', 'ask').match(/aria-selected="true"/g)?.length, 1);
    assert.equal(render('zh', 'bypass').match(/aria-selected="true"/g)?.length, 1);
  });

  it('never hands the reader the word "sandbox" in a permission label or hint (#1616)', () => {
    for (const locale of ['zh', 'en'] as const) {
      const copy = getConversationCopy(locale);
      for (const mode of PERMISSION_MODES) {
        const { label, hint } = copy.permissions.mode[mode];
        assert.doesNotMatch(`${label} ${hint}`, /沙箱|sandbox/i, `${locale} ${mode}`);
      }
      assert.doesNotMatch(copy.sandboxBoundary.title, /沙箱|sandbox/i, locale);
    }
  });

  it('icon appearance is a ghost menu of Auto + full access (no long descriptions)', () => {
    const markup = renderToStaticMarkup(
      <LocaleProvider locale="zh">
        <PermissionModeSelect appearance="icon" activeMode="ask" onSelect={() => {}} />
      </LocaleProvider>,
    );
    assert.match(markup, /permissionModeIcon/);
    assert.match(markup, /data-variant="ghost"/);
    assert.match(markup, /role="menuitemradio"/);
    assert.equal(markup.match(/role="menuitemradio"/g)?.length, 2);
    assert.match(markup, /自动/);
    assert.match(markup, /完全权限/);
    // Radio rows are label + icon only; the short hint lives on the trigger.
    const menuMatch = markup.match(/role="menu"[\s\S]*?<\/div><\/div><\/div><\/span>/);
    assert.ok(menuMatch);
    assert.doesNotMatch(menuMatch[0], /越权先问你|仅限可信任务/);
  });
});

function escapeMarkup(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(
    /"/g,
    '&quot;',
  ).replace(/'/g, '&#x27;');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

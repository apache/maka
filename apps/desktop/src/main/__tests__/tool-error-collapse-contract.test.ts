/**
 * Ordinary tool failures: no Maka "工具调用失败" Alert or nested raw disclosure.
 * Detail is the same CodeBlock/panel as success (maxHeight-bounded).
 */

import { strict as assert } from 'node:assert';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it } from 'node:test';
import type { ToolActivityItem } from '@maka/ui';
import { LocaleProvider, ToolActivity } from '@maka/ui';

const TAIL_MARKER = 'TAIL_MARKER_SCHEMA_DETAILS';

function renderWithLocale(child: ReactNode): string {
  return renderToStaticMarkup(
    createElement(LocaleProvider, { locale: 'zh', children: child }),
  );
}

// Varied prose so redactSecrets does not collapse the whole string.
const LONG_ERROR = 'Validation failed: ' + Array.from({ length: 15 }, (_, i) => `field ${i} invalid; `).join('') + TAIL_MARKER;

function erroredItem(errorText: string): ToolActivityItem {
  return {
    toolUseId: 'tu_err_1',
    toolName: 'read',
    status: 'errored',
    args: { path: '/some/file.ts' },
    result: { kind: 'text', text: errorText },
  };
}

function renderErrored(errorText: string): string {
  return renderWithLocale(createElement(ToolActivity, { items: [erroredItem(errorText)] }));
}

function renderExpanded(errorText: string): string {
  return renderWithLocale(createElement(ToolActivity, { items: [erroredItem(errorText)], open: true }));
}

describe('tool failure detail contract', () => {
  it('keeps the errored card collapsed by default with the failure signal on the row', () => {
    const markup = renderErrored(LONG_ERROR);
    assert.match(markup, /aria-expanded="false"/);
    assert.match(markup, />失败</);
    assert.doesNotMatch(markup, /工具调用失败/);
    assert.doesNotMatch(markup, /显示原始诊断/);
    assert.doesNotMatch(markup, /data-slot="tool-output"/);
  });

  it('expands ordinary failures into CodeBlock detail without a Maka error Alert', () => {
    const markup = renderExpanded(LONG_ERROR);
    assert.match(markup, /astryx-codeblock|data-slot="tool-output"/);
    assert.match(markup, /Validation failed:/);
    assert.match(markup, new RegExp(TAIL_MARKER));
    assert.doesNotMatch(markup, /工具调用失败/);
    assert.doesNotMatch(markup, /显示原始诊断/);
    assert.doesNotMatch(markup, /data-slot="alert"/);
  });

  it('still redacts secrets before diagnostics reach the detail well', () => {
    const markup = renderExpanded('Authorization: Bearer sk-live-super-secret-value');
    assert.doesNotMatch(markup, /sk-live-super-secret-value/);
    assert.match(markup, /redacted|脱敏/i);
  });

  it('renders a short failure the same way as a long one (no banner / raw nest)', () => {
    const markup = renderExpanded('short failure reason');
    assert.match(markup, /short failure reason/);
    assert.doesNotMatch(markup, /工具调用失败/);
    assert.doesNotMatch(markup, /显示原始诊断/);
  });
});

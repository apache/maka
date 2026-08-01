/**
 * Tool failure dialect (Astryx-aligned, supersedes issue #741 banner path):
 *
 * Ordinary tool failures no longer render a Maka Alert "工具调用失败" card or a
 * nested "显示原始诊断" disclosure. Expanded detail is the same CodeBlock /
 * result panel as success (maxHeight-bounded). Chat rows still expose
 * status=error + errorMessage via ChatToolCalls (covered in packages/ui
 * presentation tests). Sandbox denials remain product-owned warning banners.
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

// Long, natural-language error. Varied prose so redactSecrets does not
// collapse it to <redacted>.
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

describe('tool failure detail contract (Astryx dialect)', () => {
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
    assert.match(markup, new RegExp(TAIL_MARKER), 'full error text is in the detail well');
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

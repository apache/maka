/**
 * Production ordinary-tool failure chrome (ToolTrow → ChatToolCalls):
 * row error status + errorMessage; no Maka Alert / raw nest.
 * Detail wells mount only after expand; well shape is covered via ToolResultPreview.
 */

import { strict as assert } from 'node:assert';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it } from 'node:test';
import type { ToolActivityItem } from '@maka/ui';
import { LocaleProvider, ToolResultPreview, ToolTrow } from '@maka/ui';

const TAIL_MARKER = 'TAIL_MARKER_SCHEMA_DETAILS';
const LONG_ERROR = `Validation failed: ${Array.from({ length: 15 }, (_, i) => `field ${i} invalid; `).join('')}${TAIL_MARKER}`;

function renderWithLocale(child: ReactNode): string {
  return renderToStaticMarkup(
    createElement(LocaleProvider, { locale: 'zh', children: child }),
  );
}

function erroredItem(errorText: string): ToolActivityItem {
  return {
    toolUseId: 'tu_err_1',
    toolName: 'read',
    status: 'errored',
    args: { path: '/some/file.ts' },
    result: { kind: 'text', text: errorText },
  };
}

function renderTrow(errorText: string): string {
  return renderWithLocale(createElement(ToolTrow, { items: [erroredItem(errorText)] }));
}

describe('tool failure detail contract', () => {
  it('surfaces ordinary failures on the production ToolTrow row without Maka Alert chrome', () => {
    const markup = renderTrow(LONG_ERROR);
    assert.match(markup, /astryx-chat-tool-calls/);
    assert.match(markup, /aria-expanded="false"/);
    assert.match(markup, /Validation failed:/);
    assert.doesNotMatch(markup, /工具调用失败|显示原始诊断|data-slot="alert"|astryx-codeblock/);
  });

  it('keeps ordinary failure detail as a neutral CodeBlock well', () => {
    const markup = renderWithLocale(
      createElement(ToolResultPreview, {
        content: { kind: 'text', text: LONG_ERROR },
        toolName: 'read',
      }),
    );
    assert.match(markup, /astryx-codeblock/);
    assert.match(markup, /Validation failed:/);
    assert.match(markup, new RegExp(TAIL_MARKER));
    assert.doesNotMatch(markup, /工具调用失败|显示原始诊断|data-slot="alert"|失败·退出码/);
  });

  it('redacts secrets before diagnostics reach the row and detail well', () => {
    const secret = 'Authorization: Bearer sk-live-super-secret-value';
    const row = renderTrow(secret);
    assert.doesNotMatch(row, /sk-live-super-secret-value/);
    assert.match(row, /redacted|脱敏/i);

    const well = renderWithLocale(
      createElement(ToolResultPreview, {
        content: { kind: 'text', text: secret },
        toolName: 'read',
      }),
    );
    assert.doesNotMatch(well, /sk-live-super-secret-value/);
    assert.match(well, /redacted|脱敏/i);
  });
});

/**
 * PR-TOOL-ERROR-COLLAPSE-0 (issue #741): an errored tool must show one concise
 * summary (ToolErrorBanner) by default and keep the raw diagnostic payload
 * behind a collapsed disclosure, so a verbose validation/runtime failure
 * cannot grow a turn to ~2631px and dominate the conversation until expanded.
 *
 * The banner already truncates errorText to 240px and offers a copy action;
 * the fix adds an inner Collapsible (closed by default, keyboard-reachable
 * trigger) that owns the raw result, and removes the raw result from the
 * shared panel so the truncated banner summary is not duplicated inline.
 *
 * These tests render the public ToolActivity surface (boxed card path) with
 * a single errored item whose error text is long enough that its tail sits
 * past the banner's 240px truncation. The errored card itself now stays
 * collapsed by default (the failure signal lives on the row's status label),
 * so the body-level assertions render the expanded card via the `open` prop.
 * Astryx owns the linked disclosure region, trigger, focus, and keyboard
 * behavior. Maka's existing product `open` state also gates the raw child so a
 * collapsed diagnostic does not build a potentially large hidden result tree.
 */

import { strict as assert } from 'node:assert';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it } from 'node:test';
import type { ToolActivityItem } from '@maka/ui';
import { LocaleProvider, ToolActivity, ToolErrorDetails } from '@maka/ui';

const TAIL_MARKER = 'TAIL_MARKER_SCHEMA_DETAILS';

function renderWithLocale(child: ReactNode): string {
  return renderToStaticMarkup(
    createElement(LocaleProvider, { locale: 'zh', children: child }),
  );
}

// A long, natural-language error whose tail sits past the banner's 240px
// truncation. Repeating varied prose (not a single-char run) so redactSecrets
// does not collapse it to <redacted> and shorten it under the truncation.
const LONG_ERROR = 'Validation failed: ' + Array.from({length: 15}, (_, i) => `field ${i} invalid; `).join('') + TAIL_MARKER;

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

describe('PR-TOOL-ERROR-COLLAPSE-0 contract (issue #741)', () => {
  it('keeps the errored card collapsed by default, with the failure signal on the row', () => {
    const markup = renderErrored(LONG_ERROR);
    assert.match(markup, /<button[^>]*aria-expanded="false"[^>]*aria-controls="[^"]+"/, 'the errored tool must start collapsed');
    assert.match(markup, /class="[^"]*astryx-collapsible-content[^"]*"/, 'the collapsed body must use Astryx hit-test ownership');
    assert.match(markup, />失败</, 'the collapsed row still carries the failure status label');
  });

  it('renders the concise failure banner when an errored tool is expanded', () => {
    const markup = renderExpanded(LONG_ERROR);
    assert.match(markup, /工具调用失败/, 'expanded errored tool must show the ToolErrorBanner summary');
    assert.match(markup, /Validation failed:/, 'banner must show the start of the error text');
  });

  it('collapses the raw diagnostic payload behind an Astryx-linked inner disclosure', () => {
    const markup = renderExpanded(LONG_ERROR);
    assert.match(markup, /显示原始诊断/);
    assert.match(markup, /<button[^>]*aria-expanded="false"[^>]*aria-controls="[^"]+"/);
    assert.match(markup, /class="[^"]*astryx-collapsible-content[^"]*"/);
  });

  it('exposes a keyboard-reachable trigger to expand the raw diagnostics', () => {
    const markup = renderExpanded(LONG_ERROR);
    assert.match(markup, /显示原始诊断/, 'errored tool must label the raw-details disclosure trigger');
  });

  it('does not collapse the banner summary itself — the first 240px stays visible', () => {
    // A short error (under the 240px banner truncation) still renders its text
    // in the banner; only the raw payload (which would duplicate it) collapses.
    const markup = renderExpanded('short failure reason');
    assert.match(markup, /short failure reason/, 'a short error must still appear in the banner');
    assert.match(markup, /显示原始诊断/, '...and still offers the raw-details disclosure');
  });

  it('does not render an empty shared output panel for an errored tool with no invocation (args:{})', () => {
    // #741 P2: args:{} + errored + non-owned used to leave an empty destructive
    // tool-output box (the raw moved to the disclosure, but showResult kept the
    // shared panel open with nothing in it).
    const markup = renderWithLocale(createElement(ToolActivity, { items: [{
      toolUseId: 'tu_empty', toolName: 'unknown_tool', status: 'errored', args: {},
      result: { kind: 'text', text: 'validation failed' },
    }], open: true }));
    assert.doesNotMatch(markup, /data-slot="tool-output"/, 'an errored tool whose raw lives in the disclosure must not also render an empty shared output panel');
  });

  it('renders the raw payload inside the disclosure when expanded (open=true)', () => {
    // #741 P3: the collapsed-default tests above prove the tail is hidden; this
    // proves the disclosure actually mounts the raw when open, so "reachable"
    // is verified, not just "hidden by default".
    const markup = renderWithLocale(createElement(ToolErrorDetails, { open: true, children: TAIL_MARKER }));
    assert.match(markup, new RegExp(TAIL_MARKER), 'an expanded disclosure must render the raw payload');
  });

  it('marks the raw payload disclosure collapsed when open=false', () => {
    const markup = renderWithLocale(createElement(ToolErrorDetails, { open: false, children: TAIL_MARKER }));
    assert.match(markup, /aria-expanded="false"/);
    assert.match(markup, /class="[^"]*astryx-collapsible-content[^"]*"/);
    assert.doesNotMatch(markup, new RegExp(TAIL_MARKER), 'collapsed raw diagnostics must not build hidden content');
  });

  it('caps the banner summary at 4 logical lines so a multi-line error cannot grow it to ~2.6kpx', () => {
    // #741 P2: a 240-char slice kept newlines, so a 180-line error still
    // rendered ~161 lines (~2656px). The summary now caps both chars and lines.
    const multiLine = Array.from({ length: 180 }, (_, i) => `line ${i}`).join('\n');
    const markup = renderExpanded(multiLine);
    assert.match(
      markup,
      /line 0\nline 1\nline 2\nline 3…/,
      'the Astryx Banner description must contain exactly the truncated four-line summary',
    );
  });

  it('redacts secrets before diagnostics reach either the banner or disclosure content', () => {
    const markup = renderExpanded('Authorization: Bearer sk-live-super-secret-value');
    assert.doesNotMatch(markup, /sk-live-super-secret-value/);
    assert.match(markup, /redacted|脱敏/i);
  });
});
